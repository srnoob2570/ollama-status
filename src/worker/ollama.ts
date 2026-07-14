import { classifyHttp, isLatencyAnomalous, publicStatusFor } from './status.ts';
import { classifyProbe } from './classifier.ts';
import type { ProbeResult, Provider, TimeoutStage } from './types.ts';
import { now } from './types.ts';

// Probe fetch abort threshold. Exported so runMonitor's time-box margin can absorb a full
// in-flight probe when computing the per-tick deadline (see runDeadlineMs in monitor.ts).
export const PROBE_TIMEOUT_MS = 45_000;
// Catalog metadata calls (/tags, /show) previously ran bounded only by the run-level hard stop
// (5 min): one stalled fetch held the whole run open and the UI reported "monitor stuck" until
// the next scheduler cycle. Generous for metadata endpoints that normally answer in <2s.
const CATALOG_TIMEOUT_MS = 20_000;
const maxResponseBytes = 64 * 1024;
const probeMessage = 'Reply with OK.';

type ChatChunk = {
    done?: boolean;
    error?: string;
    message?: { content?: string | null; thinking?: string | null };
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isChatChunk(value: unknown): value is ChatChunk {
    if (!isRecord(value)) return false;

    const hasMessage = 'message' in value;
    const hasDone = 'done' in value;
    const hasError = 'error' in value;

    if (hasDone && typeof value.done !== 'boolean') return false;
    if (hasError && typeof value.error !== 'string') return false;
    if (hasMessage) {
        if (!isRecord(value.message)) return false;
        // A server may serialize an empty optional field as `null` instead of omitting it;
        // treat that the same as absent rather than rejecting the whole chunk as malformed.
        if (
            'content' in value.message &&
            value.message.content !== null &&
            typeof value.message.content !== 'string'
        )
            return false;
        if (
            'thinking' in value.message &&
            value.message.thinking !== null &&
            typeof value.message.thinking !== 'string'
        )
            return false;
    }

    return hasMessage || hasDone || hasError;
}

export class OllamaProvider {
    private readonly provider: Provider;
    private readonly apiKey: string;
    private readonly maxResponseTokens: number;

    constructor(provider: Provider, apiKey: string, maxResponseTokens = 8) {
        this.provider = provider;
        this.apiKey = apiKey;
        this.maxResponseTokens = maxResponseTokens;
    }

    private headers() {
        return { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' };
    }
    private url(path: string) {
        return `${this.provider.base_url.replace(/\/$/, '')}${path}`;
    }

    // Merges the caller's run-level signal with this call's own timer, mirroring probe(): either
    // one aborting cancels the in-flight fetch and any pending body read.
    private catalogSignal(parentSignal?: AbortSignal): { signal: AbortSignal; timer: ReturnType<typeof setTimeout> } {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
        const signal = parentSignal
            ? AbortSignal.any([controller.signal, parentSignal])
            : controller.signal;
        return { signal, timer };
    }

    async tags(
        parentSignal?: AbortSignal,
    ): Promise<{ models: Array<{ name: string; digest?: string }> }> {
        const { signal, timer } = this.catalogSignal(parentSignal);
        try {
            const response = await fetch(this.url('/tags'), { headers: this.headers(), signal });
            if (!response.ok) throw new OllamaHttpError(response.status);
            const body = (await response.json()) as {
                models?: Array<{ name: string; digest?: string }>;
            };
            if (!Array.isArray(body.models)) throw new Error('catalog_protocol');
            return { models: body.models };
        } finally {
            clearTimeout(timer);
        }
    }

    async show(model: string, parentSignal?: AbortSignal): Promise<unknown> {
        const { signal, timer } = this.catalogSignal(parentSignal);
        try {
            const response = await fetch(this.url('/show'), {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({ model }),
                signal,
            });
            if (!response.ok) throw new OllamaHttpError(response.status);
            return await response.json();
        } finally {
            clearTimeout(timer);
        }
    }

    async probe(
        model: string,
        baseline?: number,
        parentSignal?: AbortSignal,
    ): Promise<ProbeResult> {
        const startedAt = now();
        const startedMs = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        // A hard stop at the run level aborts `parentSignal` when the whole run has overstayed its
        // budget, so a probe stuck on a slow/stalled Ollama stream can't hold the run (and the
        // scheduler lock) open indefinitely. Either signal aborting cancels the in-flight fetch.
        const signal = parentSignal
            ? AbortSignal.any([controller.signal, parentSignal])
            : controller.signal;

        // Timeline milestones (spec 002 §2.4)
        let headersAt: string | null = null;
        const milestones = { firstByteAt: null as string | null, firstTokenAt: null as string | null };
        let httpStatus: number | null = null;
        let timeoutStage: TimeoutStage | null = null;
        const responseBodySnippet: string | null = null;
        let retryAfterHeader: string | null | undefined = undefined;

        try {
            const response = await fetch(this.url('/chat'), {
                method: 'POST',
                headers: this.headers(),
                signal,
                // Chat validates the account's model entitlement; an empty /generate request only preloads a model.
                body: JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: probeMessage }],
                    stream: true,
                    think: false,
                    options: { num_predict: this.maxResponseTokens, temperature: 0 },
                }),
            });
            headersAt = now();
            httpStatus = response.status;
            retryAfterHeader = response.headers.get('retry-after') ?? undefined;

            if (!response.ok) {
                // Inspect the response only in memory; errors and generated text are never persisted.
                const error = await responseTextPrefix(response, maxResponseBytes);
                const classification =
                    response.status === 403 &&
                    /requires a subscription|upgrade for access/i.test(error)
                        ? 'SUBSCRIPTION_REQUIRED'
                        : classifyHttp(response.status);
                const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
                return {
                    classification,
                    publicStatus: publicStatusFor(classification),
                    httpStatus: response.status,
                    rttMs: Date.now() - startedMs,
                    headersAt,
                    firstByteAt: milestones.firstByteAt,
                    firstTokenAt: milestones.firstTokenAt,
                    ttftMs: null,
                    errorCode: `http_${response.status}`,
                    retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
                };
            }
            return await firstChatToken(
                response,
                startedAt,
                startedMs,
                headersAt,
                baseline,
                milestones,
            );
        } catch (error) {
            const rttMs = Date.now() - startedMs;

            // A run-level hard stop (parentSignal) means the whole run is being aborted; rethrow so
            // runMonitor's catch closes the run as abandoned instead of silently persisting a
            // TIMEOUT check that would mask the stuck run. Only the probe's own 45s timer produces
            // a real TIMEOUT result.
            if (parentSignal?.aborted) throw error;

            // When an error occurs (fetch failure or stream error), the HTTP status is either
            // absent or misleading. Null it so the classifier uses the error-based path.
            httpStatus = null;

            // Determine timeout stage for the probe's own AbortError
            if (error instanceof DOMException && error.name === 'AbortError') {
                if (!headersAt) {
                    timeoutStage = 'REQUEST_OR_HEADERS';
                } else if (!milestones.firstByteAt) {
                    timeoutStage = 'FIRST_BYTE';
                } else if (!milestones.firstTokenAt) {
                    timeoutStage = 'FIRST_TOKEN';
                } else {
                    timeoutStage = 'NONE';
                }
            }

            const classificationResult = classifyProbe({
                httpStatus,
                error,
                timeoutStage,
                responseBodySnippet,
                retryAfterHeader,
            });

            return {
                classification: classificationResult.classification,
                publicStatus: classificationResult.publicStatus,
                httpStatus: classificationResult.httpStatus ?? undefined,
                rttMs,
                headersAt,
                firstByteAt: milestones.firstByteAt,
                firstTokenAt: milestones.firstTokenAt,
                ttftMs: milestones.firstTokenAt ? Date.parse(milestones.firstTokenAt) - startedMs : null,
                timeoutStage: classificationResult.timeoutStage ?? undefined,
                failureDomain: classificationResult.failureDomain,
                reasonCode: classificationResult.reasonCode,
                evidenceSource: classificationResult.evidenceSource,
                retryability: classificationResult.retryability,
                contributesToStatus: classificationResult.contributesToStatus,
                errorCode: classificationResult.classification.toLowerCase(),
                retryAfterSeconds: classificationResult.retryAfterSeconds ?? undefined,
            };
        } finally {
            clearTimeout(timer);
        }
    }
}

async function firstChatToken(
    response: Response,
    startedAt: string,
    startedMs: number,
    headersAt: string,
    baseline?: number,
    milestones?: { firstByteAt: string | null; firstTokenAt: string | null },
): Promise<ProbeResult> {
    if (!response.body) return protocolError(startedAt, startedMs, headersAt, 'missing_stream');
    const reader = response.body.getReader(),
        decoder = new TextDecoder();
    let buffer = '';
    let receivedBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (milestones && !milestones.firstByteAt && value && value.byteLength > 0) {
                milestones.firstByteAt = now();
            }
            receivedBytes += value?.byteLength ?? 0;
            if (receivedBytes > maxResponseBytes) {
                await reader.cancel();
                return protocolError(startedAt, startedMs, headersAt, 'stream_too_large', milestones?.firstByteAt ?? null, milestones?.firstTokenAt ?? null);
            }
            buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
            const lines = buffer.split(/\r?\n/);
            buffer = done ? '' : (lines.pop() ?? '');
            for (const line of lines) {
                if (!line.trim()) continue;
                let chunk: ChatChunk;
                try {
                    const parsed: unknown = JSON.parse(line);
                    if (!isChatChunk(parsed)) return protocolError(startedAt, startedMs, headersAt, 'invalid_stream', milestones?.firstByteAt ?? null, milestones?.firstTokenAt ?? null);
                    chunk = parsed;
                } catch {
                    return protocolError(startedAt, startedMs, headersAt, 'invalid_stream', milestones?.firstByteAt ?? null, milestones?.firstTokenAt ?? null);
                }
                if (chunk.error !== undefined) return streamError(startedAt, startedMs, headersAt, chunk.error, milestones?.firstByteAt ?? null, milestones?.firstTokenAt ?? null);
                // Some thinking-capable models emit only a thinking fragment before the
                // configured token limit. Either field proves that inference started. Cancel the
                // reader at the first token so the probe measures time-to-first-token and releases
                // the stream immediately instead of waiting for the full generation.
                if (
                    (typeof chunk.message?.content === 'string' &&
                        chunk.message.content.trim().length > 0) ||
                    (typeof chunk.message?.thinking === 'string' &&
                        chunk.message.thinking.trim().length > 0)
                ) {
                    // Measure time-to-first-token before cancel(), whose own teardown latency is
                    // unrelated to the model and would otherwise inflate the reported RTT.
                    if (milestones) milestones.firstTokenAt = now();
                    const rttMs = Date.now() - startedMs;
                    const ttftMs = milestones?.firstTokenAt ? Date.parse(milestones.firstTokenAt) - startedMs : null;
                    await reader.cancel();
                    const classification = isLatencyAnomalous(ttftMs ?? rttMs, baseline)
                        ? 'HIGH_LATENCY'
                        : 'SUCCESS';

                    const classificationResult = classifyProbe({
                        httpStatus: response.status,
                        error: null,
                        timeoutStage: null,
                        responseBodySnippet: null,
                        retryAfterHeader: response.headers.get('retry-after') ?? undefined,
                    });

                    return {
                        classification,
                        publicStatus: classificationResult.publicStatus,
                        httpStatus: response.status,
                        rttMs,
                        headersAt,
                        firstByteAt: milestones?.firstByteAt ?? null,
                        firstTokenAt: milestones?.firstTokenAt ?? null,
                        ttftMs,
                        timeoutStage: classificationResult.timeoutStage ?? undefined,
                        failureDomain: classificationResult.failureDomain,
                        reasonCode: classificationResult.reasonCode,
                        evidenceSource: classificationResult.evidenceSource,
                        retryability: classificationResult.retryability,
                        contributesToStatus: classificationResult.contributesToStatus,
                    };
                }
            }
            if (done) return emptyResponse(startedAt, startedMs, headersAt, milestones?.firstByteAt ?? null, milestones?.firstTokenAt ?? null);
        }
    } finally {
        reader.releaseLock();
    }
}

async function responseTextPrefix(response: Response, limit: number): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader(),
        decoder = new TextDecoder();
    let body = '',
        remaining = limit;
    try {
        while (remaining > 0) {
            const { done, value } = await reader.read();
            if (done) break;
            const bytes = value ?? new Uint8Array();
            const prefix = bytes.subarray(0, remaining);
            body += decoder.decode(prefix, { stream: prefix.byteLength === bytes.byteLength });
            remaining -= prefix.byteLength;
            if (prefix.byteLength < bytes.byteLength || remaining === 0) {
                await reader.cancel();
                break;
            }
        }
        return body + decoder.decode();
    } finally {
        reader.releaseLock();
    }
}

function emptyResponse(
    _startedAt: string,
    startedMs: number,
    headersAt: string,
    firstByteAt: string | null,
    firstTokenAt: string | null,
): ProbeResult {
    const rttMs = Date.now() - startedMs;
    return {
        classification: 'EMPTY_RESPONSE',
        publicStatus: 'OUTAGE',
        rttMs,
        headersAt,
        firstByteAt,
        firstTokenAt,
        ttftMs: firstTokenAt ? Date.parse(firstTokenAt) - startedMs : null,
        errorCode: 'empty_response',
    };
}

function protocolError(
    _startedAt: string,
    startedMs: number,
    headersAt: string,
    errorCode: string,
    firstByteAt?: string | null,
    firstTokenAt?: string | null,
): ProbeResult {
    const rttMs = Date.now() - startedMs;
    return {
        classification: 'PROTOCOL_ERROR',
        publicStatus: 'CONFIGURATION',
        rttMs,
        headersAt,
        firstByteAt: firstByteAt ?? null,
        firstTokenAt: firstTokenAt ?? null,
        ttftMs: firstTokenAt ? Date.parse(firstTokenAt) - startedMs : null,
        errorCode,
    };
}

// An `error` field mid-stream can be a transient backend condition (overloaded, out of
// capacity) rather than a genuine protocol/configuration problem. Classify those distinctly, the
// same way the 403 handler above distinguishes SUBSCRIPTION_REQUIRED from a generic auth error,
// so a transient overload doesn't get the same "requires manual fix" treatment as a corrupt stream.
function streamError(
    _startedAt: string,
    startedMs: number,
    headersAt: string,
    message: string,
    firstByteAt?: string | null,
    firstTokenAt?: string | null,
): ProbeResult {
    const rttMs = Date.now() - startedMs;
    const classification = /overloaded|too many requests|at capacity|try again/i.test(message)
        ? 'OVERLOADED'
        : 'PROTOCOL_ERROR';
    return {
        classification,
        publicStatus: classification === 'OVERLOADED' ? 'OUTAGE' : 'CONFIGURATION',
        rttMs,
        headersAt,
        firstByteAt: firstByteAt ?? null,
        firstTokenAt: firstTokenAt ?? null,
        ttftMs: firstTokenAt ? Date.parse(firstTokenAt) - startedMs : null,
        errorCode: classification === 'OVERLOADED' ? 'stream_overloaded' : 'stream_error',
    };
}

export class OllamaHttpError extends Error {
    readonly status: number;

    constructor(status: number) {
        super(`http_${status}`);
        this.status = status;
    }
}

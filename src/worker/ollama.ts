import { classifyHttp, isLatencyAnomalous, publicStatusFor } from './status';
import type { ProbeResult, Provider } from './types';

// Probe fetch abort threshold. Exported so runMonitor's time-box margin can absorb a full
// in-flight probe when computing the per-tick deadline (see runDeadlineMs in monitor.ts).
export const PROBE_TIMEOUT_MS = 45_000;
const maxResponseBytes = 64 * 1024;
const probeMessage = 'Reply with OK.';

type ChatChunk = {
    done?: boolean;
    error?: string;
    message?: { content?: string; thinking?: string };
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
        if ('content' in value.message && typeof value.message.content !== 'string') return false;
        if ('thinking' in value.message && typeof value.message.thinking !== 'string') return false;
    }

    return hasMessage || hasDone || hasError;
}

export class OllamaProvider {
    constructor(
        private readonly provider: Provider,
        private readonly apiKey: string,
        private readonly maxResponseTokens = 8,
    ) {}

    private headers() {
        return { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' };
    }
    private url(path: string) {
        return `${this.provider.base_url.replace(/\/$/, '')}${path}`;
    }

    async tags(): Promise<{ models: Array<{ name: string; digest?: string }> }> {
        const response = await fetch(this.url('/tags'), { headers: this.headers() });
        if (!response.ok) throw new OllamaHttpError(response.status);
        const body = (await response.json()) as {
            models?: Array<{ name: string; digest?: string }>;
        };
        if (!Array.isArray(body.models)) throw new Error('catalog_protocol');
        return { models: body.models };
    }

    async show(model: string): Promise<unknown> {
        const response = await fetch(this.url('/show'), {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ model }),
        });
        if (!response.ok) throw new OllamaHttpError(response.status);
        return response.json();
    }

    async probe(model: string, baseline?: number): Promise<ProbeResult> {
        const started = performance.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        try {
            const response = await fetch(this.url('/chat'), {
                method: 'POST',
                headers: this.headers(),
                signal: controller.signal,
                // Chat validates the account's model entitlement; an empty /generate request only preloads a model.
                body: JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: probeMessage }],
                    stream: true,
                    think: false,
                    options: { num_predict: this.maxResponseTokens, temperature: 0 },
                }),
            });
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
                    rttMs: performance.now() - started,
                    errorCode: `http_${response.status}`,
                    retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
                };
            }
            return await firstChatToken(response, started, baseline);
        } catch (error) {
            const classification =
                error instanceof DOMException && error.name === 'AbortError'
                    ? 'TIMEOUT'
                    : 'NETWORK_ERROR';
            return {
                classification,
                publicStatus: publicStatusFor(classification),
                rttMs: performance.now() - started,
                errorCode: classification.toLowerCase(),
            };
        } finally {
            clearTimeout(timer);
        }
    }
}

async function firstChatToken(
    response: Response,
    started: number,
    baseline?: number,
): Promise<ProbeResult> {
    if (!response.body) return protocolError(started, 'missing_stream');
    const reader = response.body.getReader(),
        decoder = new TextDecoder();
    let buffer = '';
    let receivedBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            receivedBytes += value?.byteLength ?? 0;
            if (receivedBytes > maxResponseBytes) {
                await reader.cancel();
                return protocolError(started, 'stream_too_large');
            }
            buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
            const lines = buffer.split(/\r?\n/);
            buffer = done ? '' : (lines.pop() ?? '');
            for (const line of lines) {
                if (!line.trim()) continue;
                let chunk: ChatChunk;
                try {
                    const parsed: unknown = JSON.parse(line);
                    if (!isChatChunk(parsed)) return protocolError(started, 'invalid_stream');
                    chunk = parsed;
                } catch {
                    return protocolError(started, 'invalid_stream');
                }
                if (chunk.error !== undefined) return protocolError(started, 'stream_error');
                // Some thinking-capable models emit only a thinking fragment before the
                // configured token limit. Either field proves that inference started.
                if (
                    (typeof chunk.message?.content === 'string' &&
                        chunk.message.content.trim().length > 0) ||
                    (typeof chunk.message?.thinking === 'string' &&
                        chunk.message.thinking.trim().length > 0)
                ) {
                    await reader.cancel();
                    const rttMs = performance.now() - started;
                    const classification = isLatencyAnomalous(rttMs, baseline)
                        ? 'HIGH_LATENCY'
                        : 'SUCCESS';
                    return {
                        classification,
                        publicStatus: publicStatusFor(classification),
                        httpStatus: response.status,
                        rttMs,
                    };
                }
            }
            if (done) return emptyResponse(started);
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

function emptyResponse(started: number): ProbeResult {
    return {
        classification: 'EMPTY_RESPONSE',
        publicStatus: 'OUTAGE',
        rttMs: performance.now() - started,
        errorCode: 'empty_response',
    };
}

function protocolError(started: number, errorCode: string): ProbeResult {
    return {
        classification: 'PROTOCOL_ERROR',
        publicStatus: 'CONFIGURATION',
        rttMs: performance.now() - started,
        errorCode,
    };
}

export class OllamaHttpError extends Error {
    constructor(readonly status: number) {
        super(`http_${status}`);
    }
}

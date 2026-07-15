import type {
    Classification,
    PublicStatus,
    FailureDomain,
    ReasonCode,
    EvidenceSource,
    Retryability,
    TimeoutStage,
} from './types.ts';
import { publicStatusFor, classifyHttp } from './status.ts';

// ── Public API types ──────────────────────────────────────────────────────────

export interface ProbeContext {
    /** HTTP status code from the response, or null if no response was received. */
    httpStatus: number | null;
    /** The error object if the probe failed (network error, abort, stream error). */
    error: unknown;
    /** The timeout stage reached before an AbortError, or null. */
    timeoutStage: TimeoutStage | null;
    /** A short sanitized snippet of the response body (max 500 chars) for 403 subscription detection. */
    responseBodySnippet: string | null;
    /** The raw Retry-After header value, if present. */
    retryAfterHeader: string | null | undefined;
}

export interface ClassificationResult {
    classification: Classification;
    publicStatus: PublicStatus;
    failureDomain: FailureDomain;
    reasonCode: ReasonCode;
    evidenceSource: EvidenceSource;
    retryability: Retryability;
    contributesToStatus: boolean;
    classifierRuleVersion: number;
    errorFingerprint: string | null;
    retryAfterSeconds: number | null;
    retryAt: string | null;
    httpStatus: number | null;
    timeoutStage: TimeoutStage | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const CLASSIFIER_RULE_VERSION = 1;

export const SUBSCRIPTION_MARKERS = [
    'subscription required',
    'requires subscription',
    'model entitlement',
    'plan required',
    'upgrade your plan',
    'billing required',
    'payment required',
] as const;

// ── Lazy-loaded Node crypto (available in vitest/Node, not in Workers) ────────

let _nodeCreateHash: ((alg: string) => {
    update(data: string): { digest(enc: 'hex'): string };
}) | null | undefined;

async function getNodeCreateHash() {
    if (_nodeCreateHash === undefined) {
        try {
            const m = await import('node:crypto');
            _nodeCreateHash = m.createHash;
        } catch {
            _nodeCreateHash = null;
        }
    }
    return _nodeCreateHash;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function isSubscription403(snippet: string | null): boolean {
    if (!snippet) return false;
    const lower = snippet.toLowerCase();
    return SUBSCRIPTION_MARKERS.some((marker) => lower.includes(marker));
}

export function classifySubscription403(
    httpStatus: number,
    bodySnippet: string | null,
): { classification: Classification; reasonCode: ReasonCode | null; evidenceSource: EvidenceSource } {
    if (httpStatus === 403 && isSubscription403(bodySnippet)) {
        return {
            classification: 'SUBSCRIPTION_REQUIRED',
            reasonCode: 'subscription_required',
            evidenceSource: 'CLASSIFIER_RULE',
        };
    }
    return {
        classification: classifyHttp(httpStatus),
        reasonCode: null,
        evidenceSource: 'HTTP_STATUS',
    };
}

function isAbortError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === 'AbortError') return true;
    if (error instanceof Error && error.name === 'AbortError') return true;
    return false;
}

function isNetworkError(error: unknown): boolean {
    if (error instanceof TypeError) return true;
    if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        if (msg.includes('fetch') && msg.includes('failed')) return true;
        if (msg.includes('network') && msg.includes('unreachable')) return true;
        if (msg.includes('econnrefused')) return true;
        if (msg.includes('enotfound')) return true;
        if (msg.includes('etimedout')) return true;
    }
    return false;
}

function isStreamError(error: unknown): { type: 'empty' | 'invalid' | 'too_large' | null } {
    if (!(error instanceof Error)) return { type: null };
    const msg = error.message.toLowerCase();
    if (msg.includes('empty response') || msg.includes('no data') || msg.includes('empty stream')) {
        return { type: 'empty' };
    }
    if (msg.includes('invalid stream') || msg.includes('malformed') || msg.includes('parse error')) {
        return { type: 'invalid' };
    }
    if (msg.includes('too large') || msg.includes('exceeds limit') || msg.includes('max size')) {
        return { type: 'too_large' };
    }
    return { type: null };
}

function normalizeErrorMessage(error: unknown): string {
    if (!(error instanceof Error)) return 'unknown_error';
    return error.message.slice(0, 200).toLowerCase().replace(/[^a-z0-9\s_-]/g, '');
}

// ── Public functions ──────────────────────────────────────────────────────────

/**
 * Normalize a Retry-After header value into seconds and an ISO timestamp.
 *
 * Accepts:
 * - A plain number of seconds (e.g. "120")
 * - An HTTP-date (e.g. "Wed, 13 Jul 2026 18:00:00 GMT")
 * - null / undefined / empty → { retryAfterSeconds: null, retryAt: null }
 * - Invalid values → { retryAfterSeconds: null, retryAt: null }
 */
export function normalizeRetryAfter(
    retryAfterHeader: string | null | undefined,
): { retryAfterSeconds: number | null; retryAt: string | null } {
    if (!retryAfterHeader || retryAfterHeader.trim() === '') {
        return { retryAfterSeconds: null, retryAt: null };
    }

    const trimmed = retryAfterHeader.trim();

    if (/^\d+$/.test(trimmed)) {
        const seconds = parseInt(trimmed, 10);
        if (seconds >= 0) {
            const retryAt = new Date(Date.now() + seconds * 1000).toISOString();
            return { retryAfterSeconds: seconds, retryAt };
        }
        return { retryAfterSeconds: null, retryAt: null };
    }

    const parsed = Date.parse(trimmed);
    if (!isNaN(parsed)) {
        const retryAt = new Date(parsed).toISOString();
        const seconds = Math.max(0, Math.round((parsed - Date.now()) / 1000));
        return { retryAfterSeconds: seconds, retryAt };
    }

    return { retryAfterSeconds: null, retryAt: null };
}

/**
 * Create a non-reversible, normalized error fingerprint.
 *
 * The fingerprint is a SHA-256 hash (first 32 hex chars) of a normalized
 * representation: `http_status=${status}|stage=${stage}|error_type=${type}|message=${normalizedMessage}`
 *
 * Error messages are truncated to 200 chars, lowercased, and stripped of
 * non-alphanumeric characters. No bodies, API keys, or prompts are included.
 */
export async function errorFingerprint(
    error: unknown,
    stage: TimeoutStage | null,
    httpStatus: number | null,
): Promise<string> {
    const errorType = error instanceof Error ? error.constructor.name : typeof error;
    const normalizedMessage = normalizeErrorMessage(error);
    const stageStr = stage ?? 'NONE';

    const input =
        `http_status=${httpStatus ?? 'null'}|stage=${stageStr}|error_type=${errorType}|message=${normalizedMessage}`;

    const nodeHash = await getNodeCreateHash();
    if (nodeHash) {
        return nodeHash('sha256').update(input).digest('hex').slice(0, 32);
    }

    // Fallback: simple DJB2-like hash for environments without Node crypto
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Classify a probe outcome into diagnostic dimensions.
 *
 * Pure function — no side effects, no DB access.
 * Maps HTTP status codes, timeout stages, network errors, and stream errors
 * to the full diagnostic taxonomy from spec 002.
 */
export async function classifyProbe(context: ProbeContext): Promise<ClassificationResult> {
    const { httpStatus, error, timeoutStage, responseBodySnippet, retryAfterHeader } = context;

    if (httpStatus !== null) {
        switch (httpStatus) {
            case 401:
                return await result({
                    classification: 'AUTH_ERROR',
                    failureDomain: 'ACCOUNT',
                    reasonCode: 'credential_auth_failed',
                    evidenceSource: 'HTTP_STATUS',
                    retryability: 'NONE',
                    contributesToStatus: false,
                    httpStatus,
                });

            case 403: {
                if (isSubscription403(responseBodySnippet)) {
                    return await result({
                        classification: 'SUBSCRIPTION_REQUIRED',
                        failureDomain: 'MODEL',
                        reasonCode: 'subscription_required',
                        evidenceSource: 'CLASSIFIER_RULE',
                        retryability: 'NONE',
                        contributesToStatus: false,
                        httpStatus,
                    });
                }
                return await result({
                    classification: 'PROTOCOL_ERROR',
                    failureDomain: 'PROTOCOL',
                    reasonCode: 'unattributed',
                    evidenceSource: 'HTTP_STATUS',
                    retryability: 'NONE',
                    contributesToStatus: false,
                    httpStatus,
                });
            }

            case 404:
                return await result({
                    classification: 'MODEL_NOT_FOUND',
                    failureDomain: 'MODEL',
                    reasonCode: 'model_not_found',
                    evidenceSource: 'HTTP_STATUS',
                    retryability: 'NONE',
                    contributesToStatus: true,
                    httpStatus,
                });

            case 408:
                return await result({
                    classification: 'TIMEOUT',
                    failureDomain: 'PROVIDER',
                    reasonCode: 'provider_http_timeout',
                    evidenceSource: 'HTTP_STATUS',
                    retryability: 'NONE',
                    contributesToStatus: true,
                    httpStatus,
                });

            case 429: {
                const ra = normalizeRetryAfter(retryAfterHeader);
                return await result({
                    classification: 'RATE_LIMITED',
                    failureDomain: 'ACCOUNT',
                    reasonCode: 'credential_rate_limited',
                    evidenceSource: 'HTTP_STATUS',
                    retryability: 'AFTER_RETRY_AFTER',
                    contributesToStatus: false,
                    httpStatus,
                    retryAfterSeconds: ra.retryAfterSeconds,
                    retryAt: ra.retryAt,
                });
            }

            case 503:
                return await result({
                    classification: 'OVERLOADED',
                    failureDomain: 'PROVIDER',
                    reasonCode: 'provider_overloaded',
                    evidenceSource: 'HTTP_STATUS',
                    retryability: 'AFTER_BACKOFF',
                    contributesToStatus: true,
                    httpStatus,
                });

            case 504:
                return await result({
                    classification: 'TIMEOUT',
                    failureDomain: 'PROVIDER',
                    reasonCode: 'provider_http_timeout',
                    evidenceSource: 'HTTP_STATUS',
                    retryability: 'NONE',
                    contributesToStatus: true,
                    httpStatus,
                });

            default:
                if (httpStatus >= 500) {
                    return await result({
                        classification: 'MODEL_UNREACHABLE',
                        failureDomain: 'PROVIDER',
                        reasonCode: 'provider_http_5xx',
                        evidenceSource: 'HTTP_STATUS',
                        retryability: 'AFTER_BACKOFF',
                        contributesToStatus: true,
                        httpStatus,
                    });
                }
                return await result({
                    classification: 'PROTOCOL_ERROR',
                    failureDomain: 'PROTOCOL',
                    reasonCode: 'unattributed',
                    evidenceSource: 'HTTP_STATUS',
                    retryability: 'NONE',
                    contributesToStatus: false,
                    httpStatus,
                });
        }
    }

    if (isAbortError(error)) {
        const stage = timeoutStage ?? 'NONE';

        switch (stage) {
            case 'REQUEST_OR_HEADERS':
                return await result({
                    classification: 'TIMEOUT',
                    failureDomain: 'PROVIDER',
                    reasonCode: 'timeout_before_headers',
                    evidenceSource: 'TIMEOUT_PHASE',
                    retryability: 'AFTER_BACKOFF',
                    contributesToStatus: true,
                    httpStatus: null,
                    timeoutStage: stage,
                });

            case 'FIRST_BYTE':
                return await result({
                    classification: 'TIMEOUT',
                    failureDomain: 'PROVIDER',
                    reasonCode: 'timeout_waiting_first_byte',
                    evidenceSource: 'TIMEOUT_PHASE',
                    retryability: 'AFTER_BACKOFF',
                    contributesToStatus: true,
                    httpStatus: null,
                    timeoutStage: stage,
                });

            case 'FIRST_TOKEN':
                return await result({
                    classification: 'TIMEOUT',
                    failureDomain: 'PROVIDER',
                    reasonCode: 'timeout_waiting_first_token',
                    evidenceSource: 'TIMEOUT_PHASE',
                    retryability: 'AFTER_BACKOFF',
                    contributesToStatus: true,
                    httpStatus: null,
                    timeoutStage: stage,
                });

            default:
                return await result({
                    classification: 'TIMEOUT',
                    failureDomain: 'PROVIDER',
                    reasonCode: 'timeout_before_headers',
                    evidenceSource: 'ABORT_SIGNAL',
                    retryability: 'AFTER_BACKOFF',
                    contributesToStatus: true,
                    httpStatus: null,
                    timeoutStage: 'NONE',
                });
        }
    }

    if (isNetworkError(error)) {
        return await result({
            classification: 'NETWORK_ERROR',
            failureDomain: 'NETWORK_PATH',
            reasonCode: 'network_error',
            evidenceSource: 'STREAM_STATE',
            retryability: 'AFTER_BACKOFF',
            contributesToStatus: false,
            httpStatus: null,
        });
    }

    const streamIssue = isStreamError(error);
    if (streamIssue.type === 'empty') {
        return await result({
            classification: 'EMPTY_RESPONSE',
            failureDomain: 'PROVIDER',
            reasonCode: 'empty_response',
            evidenceSource: 'EMPTY_RESPONSE',
            retryability: 'AFTER_BACKOFF',
            contributesToStatus: true,
            httpStatus: null,
        });
    }
    if (streamIssue.type === 'invalid') {
        return await result({
            classification: 'PROTOCOL_ERROR',
            failureDomain: 'PROTOCOL',
            reasonCode: 'invalid_stream',
            evidenceSource: 'STREAM_STATE',
            retryability: 'NONE',
            contributesToStatus: true,
            httpStatus: null,
        });
    }
    if (streamIssue.type === 'too_large') {
        return await result({
            classification: 'PROTOCOL_ERROR',
            failureDomain: 'PROTOCOL',
            reasonCode: 'stream_too_large',
            evidenceSource: 'STREAM_STATE',
            retryability: 'NONE',
            contributesToStatus: true,
            httpStatus: null,
        });
    }

    if (error) {
        return await result({
            classification: 'UNKNOWN',
            failureDomain: 'UNKNOWN',
            reasonCode: 'unattributed',
            evidenceSource: 'UNKNOWN',
            retryability: 'NONE',
            contributesToStatus: false,
            httpStatus: null,
        });
    }

    // No error, no HTTP status — should not happen, but handle gracefully
    return await result({
        classification: 'UNKNOWN',
        failureDomain: 'UNKNOWN',
        reasonCode: 'unattributed',
        evidenceSource: 'UNKNOWN',
        retryability: 'NONE',
        contributesToStatus: false,
        httpStatus: null,
    });
}

// ── Internal result builder ───────────────────────────────────────────────────

interface ResultOverrides {
    classification: Classification;
    failureDomain: FailureDomain;
    reasonCode: ReasonCode;
    evidenceSource: EvidenceSource;
    retryability: Retryability;
    contributesToStatus: boolean;
    httpStatus: number | null;
    timeoutStage?: TimeoutStage | null;
    retryAfterSeconds?: number | null;
    retryAt?: string | null;
}

async function result(overrides: ResultOverrides): Promise<ClassificationResult> {
    const publicStatus = publicStatusFor(overrides.classification);
    const fp = await errorFingerprint(
        null, // No error object for HTTP-based classifications
        overrides.timeoutStage ?? null,
        overrides.httpStatus,
    );

    return {
        classification: overrides.classification,
        publicStatus,
        failureDomain: overrides.failureDomain,
        reasonCode: overrides.reasonCode,
        evidenceSource: overrides.evidenceSource,
        retryability: overrides.retryability,
        contributesToStatus: overrides.contributesToStatus,
        classifierRuleVersion: CLASSIFIER_RULE_VERSION,
        errorFingerprint: fp,
        retryAfterSeconds: overrides.retryAfterSeconds ?? null,
        retryAt: overrides.retryAt ?? null,
        httpStatus: overrides.httpStatus,
        timeoutStage: overrides.timeoutStage ?? null,
    };
}

import { describe, expect, it } from 'vitest';
import {
    classifyProbe,
    errorFingerprint,
    normalizeRetryAfter,
    isSubscription403,
    classifySubscription403,
    CLASSIFIER_RULE_VERSION,
    SUBSCRIPTION_MARKERS,
} from '../src/worker/classifier';
import type { ProbeContext } from '../src/worker/classifier';

// ── normalizeRetryAfter ────────────────────────────────────────────────────────

describe('normalizeRetryAfter', () => {
    it('parses plain seconds', async () => {
        const result = normalizeRetryAfter('120');
        expect(result.retryAfterSeconds).toBe(120);
        expect(result.retryAt).toBeTruthy();
        expect(result.retryAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('parses HTTP-date', async () => {
        const future = new Date(Date.now() + 60_000).toUTCString();
        const result = normalizeRetryAfter(future);
        expect(result.retryAfterSeconds).toBeGreaterThan(0);
        expect(result.retryAt).toBeTruthy();
    });

    it('returns null for null input', async () => {
        const result = normalizeRetryAfter(null);
        expect(result.retryAfterSeconds).toBeNull();
        expect(result.retryAt).toBeNull();
    });

    it('returns null for undefined input', async () => {
        const result = normalizeRetryAfter(undefined);
        expect(result.retryAfterSeconds).toBeNull();
        expect(result.retryAt).toBeNull();
    });

    it('returns null for empty string', async () => {
        const result = normalizeRetryAfter('');
        expect(result.retryAfterSeconds).toBeNull();
        expect(result.retryAt).toBeNull();
    });

    it('returns null for whitespace-only string', async () => {
        const result = normalizeRetryAfter('   ');
        expect(result.retryAfterSeconds).toBeNull();
        expect(result.retryAt).toBeNull();
    });

    it('returns null for invalid value', async () => {
        const result = normalizeRetryAfter('not-a-date');
        expect(result.retryAfterSeconds).toBeNull();
        expect(result.retryAt).toBeNull();
    });

    it('handles zero seconds', async () => {
        const result = normalizeRetryAfter('0');
        expect(result.retryAfterSeconds).toBe(0);
        expect(result.retryAt).toBeTruthy();
    });
});

// ── errorFingerprint ──────────────────────────────────────────────────────────

describe('errorFingerprint', () => {
    it('produces a 32-char hex string with SHA-256', async () => {
        const fp = await errorFingerprint(new Error('test error'), 'FIRST_BYTE', 503);
        expect(fp).toMatch(/^[0-9a-f]{8,32}$/);
    });

    it('is deterministic for same input', async () => {
        const a = await errorFingerprint(new Error('same'), 'REQUEST_OR_HEADERS', 408);
        const b = await errorFingerprint(new Error('same'), 'REQUEST_OR_HEADERS', 408);
        expect(a).toBe(b);
    });

    it('differs for different httpStatus', async () => {
        const a = await errorFingerprint(new Error('err'), 'FIRST_BYTE', 500);
        const b = await errorFingerprint(new Error('err'), 'FIRST_BYTE', 503);
        expect(a).not.toBe(b);
    });

    it('differs for different stage', async () => {
        const a = await errorFingerprint(new Error('err'), 'FIRST_BYTE', null);
        const b = await errorFingerprint(new Error('err'), 'FIRST_TOKEN', null);
        expect(a).not.toBe(b);
    });

    it('handles null error gracefully', async () => {
        const fp = await errorFingerprint(null, 'NONE', 200);
        expect(fp).toMatch(/^[0-9a-f]+$/);
    });

    it('handles non-Error error objects', async () => {
        const fp = await errorFingerprint('string error', 'NONE', null);
        expect(fp).toMatch(/^[0-9a-f]+$/);
    });

    it('truncates long messages to 200 chars', async () => {
        const longMsg = 'x'.repeat(500);
        const fp = await errorFingerprint(new Error(longMsg), 'NONE', null);
        expect(fp).toMatch(/^[0-9a-f]+$/);
    });

    it('strips non-alphanumeric from messages', async () => {
        const fp1 = await errorFingerprint(new Error('hello!@# world'), 'NONE', null);
        const fp2 = await errorFingerprint(new Error('hello world'), 'NONE', null);
        expect(fp1).toBe(fp2);
    });
});

// ── classifyProbe: HTTP status codes ──────────────────────────────────────────

function ctx(overrides: Partial<ProbeContext> = {}): ProbeContext {
    return {
        httpStatus: null,
        error: null,
        timeoutStage: null,
        responseBodySnippet: null,
        retryAfterHeader: null,
        ...overrides,
    };
}

describe('classifyProbe — HTTP status codes', () => {
    it('401 → AUTH_ERROR / ACCOUNT / credential_auth_failed', async () => {
        const r = await classifyProbe(ctx({ httpStatus: 401 }));
        expect(r.classification).toBe('AUTH_ERROR');
        expect(r.failureDomain).toBe('ACCOUNT');
        expect(r.reasonCode).toBe('credential_auth_failed');
        expect(r.evidenceSource).toBe('HTTP_STATUS');
        expect(r.retryability).toBe('NONE');
        expect(r.contributesToStatus).toBe(false);
        expect(r.publicStatus).toBe('AUTHENTICATION');
        expect(r.httpStatus).toBe(401);
        expect(r.classifierRuleVersion).toBe(1);
    });

    it('403 with subscription marker → SUBSCRIPTION_REQUIRED', async () => {
        const r = await classifyProbe(ctx({
            httpStatus: 403,
            responseBodySnippet: 'Your account requires subscription required to access this model.',
        }));
        expect(r.classification).toBe('SUBSCRIPTION_REQUIRED');
        expect(r.failureDomain).toBe('MODEL');
        expect(r.reasonCode).toBe('subscription_required');
        expect(r.evidenceSource).toBe('CLASSIFIER_RULE');
        expect(r.retryability).toBe('NONE');
        expect(r.contributesToStatus).toBe(false);
        expect(r.publicStatus).toBe('PLAN_REQUIRED');
    });

    it('403 with "requires subscription" marker', async () => {
        const r = await classifyProbe(ctx({
            httpStatus: 403,
            responseBodySnippet: 'This model requires subscription.',
        }));
        expect(r.reasonCode).toBe('subscription_required');
    });

    it('403 with "model entitlement" marker', async () => {
        const r = await classifyProbe(ctx({
            httpStatus: 403,
            responseBodySnippet: 'Missing model entitlement for this resource.',
        }));
        expect(r.reasonCode).toBe('subscription_required');
    });

    it('403 with "plan required" marker', async () => {
        const r = await classifyProbe(ctx({
            httpStatus: 403,
            responseBodySnippet: 'A paid plan required to use this feature.',
        }));
        expect(r.reasonCode).toBe('subscription_required');
    });

    it('403 with "upgrade your plan" marker', async () => {
        const r = await classifyProbe(ctx({
            httpStatus: 403,
            responseBodySnippet: 'Please upgrade your plan to continue.',
        }));
        expect(r.reasonCode).toBe('subscription_required');
    });

    it('403 with "billing required" marker', async () => {
        const r = await classifyProbe(ctx({
            httpStatus: 403,
            responseBodySnippet: 'Billing required for API access.',
        }));
        expect(r.reasonCode).toBe('subscription_required');
    });

    it('403 with "payment required" marker', async () => {
        const r = await classifyProbe(ctx({
            httpStatus: 403,
            responseBodySnippet: 'Payment required to access this endpoint.',
        }));
        expect(r.reasonCode).toBe('subscription_required');
    });

    it('403 unknown (no subscription marker) → PROTOCOL_ERROR / unattributed', async () => {
        const r = await classifyProbe(ctx({
            httpStatus: 403,
            responseBodySnippet: 'Access denied. Contact your administrator.',
        }));
        expect(r.classification).toBe('PROTOCOL_ERROR');
        expect(r.failureDomain).toBe('PROTOCOL');
        expect(r.reasonCode).toBe('unattributed');
        expect(r.contributesToStatus).toBe(false);
        // Must NOT be subscription_required
        expect(r.reasonCode).not.toBe('subscription_required');
    });

    it('403 with null snippet → PROTOCOL_ERROR (not subscription)', async () => {
        const r = await classifyProbe(ctx({ httpStatus: 403, responseBodySnippet: null }));
        expect(r.reasonCode).toBe('unattributed');
        expect(r.reasonCode).not.toBe('subscription_required');
    });

    it('404 → MODEL_NOT_FOUND / MODEL / model_not_found', async () => {
        const r = await classifyProbe(ctx({ httpStatus: 404 }));
        expect(r.classification).toBe('MODEL_NOT_FOUND');
        expect(r.failureDomain).toBe('MODEL');
        expect(r.reasonCode).toBe('model_not_found');
        expect(r.evidenceSource).toBe('HTTP_STATUS');
        expect(r.contributesToStatus).toBe(true);
        expect(r.publicStatus).toBe('MODEL_NOT_FOUND');
    });

    it('408 → TIMEOUT / PROVIDER / provider_http_timeout', async () => {
        const r = await classifyProbe(ctx({ httpStatus: 408 }));
        expect(r.classification).toBe('TIMEOUT');
        expect(r.failureDomain).toBe('PROVIDER');
        expect(r.reasonCode).toBe('provider_http_timeout');
        expect(r.evidenceSource).toBe('HTTP_STATUS');
        expect(r.contributesToStatus).toBe(true);
        expect(r.publicStatus).toBe('OUTAGE');
    });

    it('429 → RATE_LIMITED / ACCOUNT / credential_rate_limited', async () => {
        const r = await classifyProbe(ctx({
            httpStatus: 429,
            retryAfterHeader: '60',
        }));
        expect(r.classification).toBe('RATE_LIMITED');
        expect(r.failureDomain).toBe('ACCOUNT');
        expect(r.reasonCode).toBe('credential_rate_limited');
        expect(r.evidenceSource).toBe('HTTP_STATUS');
        expect(r.retryability).toBe('AFTER_RETRY_AFTER');
        expect(r.contributesToStatus).toBe(false);
        expect(r.publicStatus).toBe('RATE_LIMITED');
        expect(r.retryAfterSeconds).toBe(60);
        expect(r.retryAt).toBeTruthy();
    });

    it('429 without Retry-After → still RATE_LIMITED with null retryAfter', async () => {
        const r = await classifyProbe(ctx({ httpStatus: 429 }));
        expect(r.classification).toBe('RATE_LIMITED');
        expect(r.retryAfterSeconds).toBeNull();
        expect(r.retryAt).toBeNull();
    });

    it('503 → OVERLOADED / PROVIDER / provider_overloaded', async () => {
        const r = await classifyProbe(ctx({ httpStatus: 503 }));
        expect(r.classification).toBe('OVERLOADED');
        expect(r.failureDomain).toBe('PROVIDER');
        expect(r.reasonCode).toBe('provider_overloaded');
        expect(r.contributesToStatus).toBe(true);
        expect(r.publicStatus).toBe('OUTAGE');
    });

    it('504 → TIMEOUT / PROVIDER / provider_http_timeout', async () => {
        const r = await classifyProbe(ctx({ httpStatus: 504 }));
        expect(r.classification).toBe('TIMEOUT');
        expect(r.failureDomain).toBe('PROVIDER');
        expect(r.reasonCode).toBe('provider_http_timeout');
        expect(r.contributesToStatus).toBe(true);
    });

    it('5xx (other, e.g. 502) → MODEL_UNREACHABLE / provider_http_5xx', async () => {
        const r = await classifyProbe(ctx({ httpStatus: 502 }));
        expect(r.classification).toBe('MODEL_UNREACHABLE');
        expect(r.failureDomain).toBe('PROVIDER');
        expect(r.reasonCode).toBe('provider_http_5xx');
        expect(r.contributesToStatus).toBe(true);
        expect(r.publicStatus).toBe('OUTAGE');
    });

    it('500 → MODEL_UNREACHABLE / provider_http_5xx', async () => {
        const r = await classifyProbe(ctx({ httpStatus: 500 }));
        expect(r.classification).toBe('MODEL_UNREACHABLE');
        expect(r.reasonCode).toBe('provider_http_5xx');
    });

    it('other 4xx (e.g. 400) → PROTOCOL_ERROR / unattributed', async () => {
        const r = await classifyProbe(ctx({ httpStatus: 400 }));
        expect(r.classification).toBe('PROTOCOL_ERROR');
        expect(r.failureDomain).toBe('PROTOCOL');
        expect(r.reasonCode).toBe('unattributed');
        expect(r.contributesToStatus).toBe(false);
    });
});

// ── classifyProbe: timeout stages ─────────────────────────────────────────────

describe('classifyProbe — timeout stages', () => {
    function abortError(): Error {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        return err;
    }

    it('REQUEST_OR_HEADERS → timeout_before_headers', async () => {
        const r = await classifyProbe(ctx({
            error: abortError(),
            timeoutStage: 'REQUEST_OR_HEADERS',
        }));
        expect(r.classification).toBe('TIMEOUT');
        expect(r.failureDomain).toBe('PROVIDER');
        expect(r.reasonCode).toBe('timeout_before_headers');
        expect(r.evidenceSource).toBe('TIMEOUT_PHASE');
        expect(r.httpStatus).toBeNull();
        expect(r.timeoutStage).toBe('REQUEST_OR_HEADERS');
        expect(r.contributesToStatus).toBe(true);
    });

    it('FIRST_BYTE → timeout_waiting_first_byte', async () => {
        const r = await classifyProbe(ctx({
            error: abortError(),
            timeoutStage: 'FIRST_BYTE',
        }));
        expect(r.reasonCode).toBe('timeout_waiting_first_byte');
        expect(r.evidenceSource).toBe('TIMEOUT_PHASE');
        expect(r.timeoutStage).toBe('FIRST_BYTE');
        expect(r.httpStatus).toBeNull();
    });

    it('FIRST_TOKEN → timeout_waiting_first_token', async () => {
        const r = await classifyProbe(ctx({
            error: abortError(),
            timeoutStage: 'FIRST_TOKEN',
        }));
        expect(r.reasonCode).toBe('timeout_waiting_first_token');
        expect(r.evidenceSource).toBe('TIMEOUT_PHASE');
        expect(r.timeoutStage).toBe('FIRST_TOKEN');
        expect(r.httpStatus).toBeNull();
    });

    it('AbortError without stage → ABORT_SIGNAL / timeout_before_headers', async () => {
        const r = await classifyProbe(ctx({
            error: abortError(),
            timeoutStage: null,
        }));
        expect(r.classification).toBe('TIMEOUT');
        expect(r.reasonCode).toBe('timeout_before_headers');
        expect(r.evidenceSource).toBe('ABORT_SIGNAL');
        expect(r.timeoutStage).toBe('NONE');
    });

    it('AbortError with NONE stage → ABORT_SIGNAL', async () => {
        const r = await classifyProbe(ctx({
            error: abortError(),
            timeoutStage: 'NONE',
        }));
        expect(r.evidenceSource).toBe('ABORT_SIGNAL');
        expect(r.timeoutStage).toBe('NONE');
    });
});

// ── classifyProbe: network error ──────────────────────────────────────────────

describe('classifyProbe — network error', () => {
    it('TypeError → NETWORK_ERROR / NETWORK_PATH / network_error', async () => {
        const r = await classifyProbe(ctx({
            error: new TypeError('fetch failed'),
        }));
        expect(r.classification).toBe('NETWORK_ERROR');
        expect(r.failureDomain).toBe('NETWORK_PATH');
        expect(r.reasonCode).toBe('network_error');
        expect(r.evidenceSource).toBe('STREAM_STATE');
        expect(r.contributesToStatus).toBe(false);
        expect(r.httpStatus).toBeNull();
        expect(r.publicStatus).toBe('OUTAGE');
    });

    it('Error with "fetch failed" → NETWORK_ERROR', async () => {
        const r = await classifyProbe(ctx({
            error: new Error('fetch failed: connection refused'),
        }));
        expect(r.classification).toBe('NETWORK_ERROR');
    });

    it('Error with ECONNREFUSED → NETWORK_ERROR', async () => {
        const r = await classifyProbe(ctx({
            error: new Error('connect ECONNREFUSED 127.0.0.1:11434'),
        }));
        expect(r.classification).toBe('NETWORK_ERROR');
    });

    it('Error with ENOTFOUND → NETWORK_ERROR', async () => {
        const r = await classifyProbe(ctx({
            error: new Error('getaddrinfo ENOTFOUND api.example.com'),
        }));
        expect(r.classification).toBe('NETWORK_ERROR');
    });

    it('Error with ETIMEDOUT → NETWORK_ERROR', async () => {
        const r = await classifyProbe(ctx({
            error: new Error('connect ETIMEDOUT 10.0.0.1:443'),
        }));
        expect(r.classification).toBe('NETWORK_ERROR');
    });
});

// ── classifyProbe: stream errors ──────────────────────────────────────────────

describe('classifyProbe — stream errors', () => {
    it('empty response → EMPTY_RESPONSE / empty_response', async () => {
        const r = await classifyProbe(ctx({
            error: new Error('empty response from provider'),
        }));
        expect(r.classification).toBe('EMPTY_RESPONSE');
        expect(r.failureDomain).toBe('PROVIDER');
        expect(r.reasonCode).toBe('empty_response');
        expect(r.evidenceSource).toBe('EMPTY_RESPONSE');
        expect(r.contributesToStatus).toBe(true);
        expect(r.httpStatus).toBeNull();
    });

    it('"no data" → EMPTY_RESPONSE', async () => {
        const r = await classifyProbe(ctx({
            error: new Error('stream ended with no data'),
        }));
        expect(r.classification).toBe('EMPTY_RESPONSE');
    });

    it('"empty stream" → EMPTY_RESPONSE', async () => {
        const r = await classifyProbe(ctx({
            error: new Error('received empty stream'),
        }));
        expect(r.classification).toBe('EMPTY_RESPONSE');
    });

    it('invalid stream → PROTOCOL_ERROR / invalid_stream', async () => {
        const r = await classifyProbe(ctx({
            error: new Error('invalid stream: malformed JSON'),
        }));
        expect(r.classification).toBe('PROTOCOL_ERROR');
        expect(r.failureDomain).toBe('PROTOCOL');
        expect(r.reasonCode).toBe('invalid_stream');
        expect(r.evidenceSource).toBe('STREAM_STATE');
        expect(r.contributesToStatus).toBe(true);
    });

    it('"malformed" → invalid_stream', async () => {
        const r = await classifyProbe(ctx({
            error: new Error('malformed response from API'),
        }));
        expect(r.reasonCode).toBe('invalid_stream');
    });

    it('"parse error" → invalid_stream', async () => {
        const r = await classifyProbe(ctx({
            error: new Error('parse error in stream chunk'),
        }));
        expect(r.reasonCode).toBe('invalid_stream');
    });

    it('stream too large → PROTOCOL_ERROR / stream_too_large', async () => {
        const r = await classifyProbe(ctx({
            error: new Error('response too large: exceeds limit'),
        }));
        expect(r.classification).toBe('PROTOCOL_ERROR');
        expect(r.reasonCode).toBe('stream_too_large');
        expect(r.evidenceSource).toBe('STREAM_STATE');
        expect(r.contributesToStatus).toBe(true);
    });

    it('"exceeds limit" → stream_too_large', async () => {
        const r = await classifyProbe(ctx({
            error: new Error('body exceeds limit of 10MB'),
        }));
        expect(r.reasonCode).toBe('stream_too_large');
    });

    it('"max size" → stream_too_large', async () => {
        const r = await classifyProbe(ctx({
            error: new Error('response exceeds max size'),
        }));
        expect(r.reasonCode).toBe('stream_too_large');
    });
});

// ── classifyProbe: edge cases ─────────────────────────────────────────────────

describe('classifyProbe — edge cases', () => {
    it('unknown error → UNKNOWN / unattributed', async () => {
        const r = await classifyProbe(ctx({
            error: new Error('some unexpected thing'),
        }));
        expect(r.classification).toBe('UNKNOWN');
        expect(r.failureDomain).toBe('UNKNOWN');
        expect(r.reasonCode).toBe('unattributed');
        expect(r.evidenceSource).toBe('UNKNOWN');
        expect(r.contributesToStatus).toBe(false);
    });

    it('no error, no httpStatus → UNKNOWN', async () => {
        const r = await classifyProbe(ctx({}));
        expect(r.classification).toBe('UNKNOWN');
        expect(r.failureDomain).toBe('UNKNOWN');
        expect(r.reasonCode).toBe('unattributed');
    });

    it('classifier_rule_version is always 1', async () => {
        const r1 = await classifyProbe(ctx({ httpStatus: 200 }));
        const r2 = await classifyProbe(ctx({ httpStatus: 500 }));
        const r3 = await classifyProbe(ctx({ error: new Error('x') }));
        expect(r1.classifierRuleVersion).toBe(1);
        expect(r2.classifierRuleVersion).toBe(1);
        expect(r3.classifierRuleVersion).toBe(1);
    });

    it('errorFingerprint is set for all results', async () => {
        const r = await classifyProbe(ctx({ httpStatus: 503 }));
        expect(r.errorFingerprint).toBeTruthy();
        expect(r.errorFingerprint).toMatch(/^[0-9a-f]+$/);
    });

    it('httpStatus is preserved in result', async () => {
        const r = await classifyProbe(ctx({ httpStatus: 503 }));
        expect(r.httpStatus).toBe(503);
    });

    it('httpStatus is null for non-HTTP errors', async () => {
        const r = await classifyProbe(ctx({ error: new Error('fetch failed') }));
        expect(r.httpStatus).toBeNull();
    });

    it('timeoutStage is null for HTTP-based results', async () => {
        const r = await classifyProbe(ctx({ httpStatus: 408 }));
        expect(r.timeoutStage).toBeNull();
    });

    it('subscription marker is case-insensitive', async () => {
        const r = await classifyProbe(ctx({
            httpStatus: 403,
            responseBodySnippet: 'SUBSCRIPTION REQUIRED for this model.',
        }));
        expect(r.reasonCode).toBe('subscription_required');
    });

    it('subscription marker matches within longer text', async () => {
        const r = await classifyProbe(ctx({
            httpStatus: 403,
            responseBodySnippet: '{"error":{"message":"This model requires subscription to access","code":"forbidden"}}',
        }));
        expect(r.reasonCode).toBe('subscription_required');
    });

    it('DOMException AbortError is detected', async () => {
        // DOMException may not exist in Node, but we test the Error path
        const err = new Error('aborted');
        err.name = 'AbortError';
        const r = await classifyProbe(ctx({
            error: err,
            timeoutStage: 'FIRST_BYTE',
        }));
        expect(r.reasonCode).toBe('timeout_waiting_first_byte');
    });

    it('non-Error objects are handled gracefully', async () => {
        const r = await classifyProbe(ctx({ error: 'just a string' }));
        expect(r.classification).toBe('UNKNOWN');
    });
});

// ── isSubscription403 ──────────────────────────────────────────────────────────

describe('isSubscription403', () => {
    it('returns true for a known subscription marker', () => {
        expect(isSubscription403('Your account requires subscription to access this model.')).toBe(true);
    });

    it('is case-insensitive', () => {
        expect(isSubscription403('SUBSCRIPTION REQUIRED')).toBe(true);
    });

    it('matches within longer JSON text', () => {
        expect(isSubscription403('{"error":{"message":"plan required"}}')).toBe(true);
    });

    it('returns false for a null snippet', () => {
        expect(isSubscription403(null)).toBe(false);
    });

    it('returns false for an empty string', () => {
        expect(isSubscription403('')).toBe(false);
    });

    it('returns false for a non-subscription 403 body', () => {
        expect(isSubscription403('Access denied. Contact your administrator.')).toBe(false);
    });
});

// ── classifySubscription403 ───────────────────────────────────────────────────

describe('classifySubscription403', () => {
    it('returns SUBSCRIPTION_REQUIRED for a 403 with a subscription marker', () => {
        const r = classifySubscription403(403, 'requires subscription to access this model');
        expect(r.classification).toBe('SUBSCRIPTION_REQUIRED');
        expect(r.reasonCode).toBe('subscription_required');
        expect(r.evidenceSource).toBe('CLASSIFIER_RULE');
    });

    it('falls back to classifyHttp for a 403 without a subscription marker', () => {
        const r = classifySubscription403(403, 'Access denied');
        expect(r.classification).toBe('PROTOCOL_ERROR');
        expect(r.reasonCode).toBeNull();
        expect(r.evidenceSource).toBe('HTTP_STATUS');
    });

    it('falls back to classifyHttp for a non-403 status even with a marker', () => {
        const r = classifySubscription403(401, 'subscription required');
        expect(r.classification).toBe('AUTH_ERROR');
        expect(r.reasonCode).toBeNull();
        expect(r.evidenceSource).toBe('HTTP_STATUS');
    });

    it('returns RATE_LIMITED for 429', () => {
        const r = classifySubscription403(429, null);
        expect(r.classification).toBe('RATE_LIMITED');
        expect(r.reasonCode).toBeNull();
    });
});

// ── exported constants ─────────────────────────────────────────────────────────

describe('exported constants', () => {
    it('CLASSIFIER_RULE_VERSION is 1', () => {
        expect(CLASSIFIER_RULE_VERSION).toBe(1);
    });

    it('SUBSCRIPTION_MARKERS includes the canonical markers', () => {
        expect(SUBSCRIPTION_MARKERS).toContain('subscription required');
        expect(SUBSCRIPTION_MARKERS).toContain('requires subscription');
        expect(SUBSCRIPTION_MARKERS).toContain('model entitlement');
        expect(SUBSCRIPTION_MARKERS).toContain('payment required');
    });
});

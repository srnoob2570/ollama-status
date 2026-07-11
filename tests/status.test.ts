import { describe, expect, it } from 'vitest';
import {
    checkIntervalMinutes,
    classifyHttp,
    CRON_INTERVAL_MS,
    eligibilityCutoff,
    isLatencyAnomalous,
    nextCheckAt,
    nominalCheckIntervalMinutes,
    publicStatusFor,
    trimmedMean,
} from '../src/worker/status';
import { entitlementFromFreeProbe, shouldProbePaid } from '../src/worker/entitlement';
import { maxResponseTokens } from '../src/worker/probe-config';
import { OllamaProvider } from '../src/worker/ollama';
import {
    effectiveProvider,
    historyBuckets,
    lastSuccessfulFinishedAt,
    nextUpdatesForModels,
    worstStatus,
} from '../src/worker/api';
import { materializedStatus, nextCheckTier, renewLock } from '../src/worker/monitor';
import type { Env } from '../src/worker/types';
import { nextUpdateLabel, roundUpToMonitorInterval } from '../src/web/next-update';

describe('Ollama status classification', () => {
    it('uses a moving one-hour window by default with bucket counts based on model tier', () => {
        const reference = new Date('2026-07-10T13:34:00.000Z');
        const free = historyBuckets(
            [
                {
                    provider_id: 'ollama-free',
                    model_id: 'm1',
                    checked_at: '2026-07-10T12:33:59.999Z',
                    public_status: 'OUTAGE',
                    classification: 'TIMEOUT',
                    total_duration_ms: null,
                    rtt_ms: 1,
                },
                {
                    provider_id: 'ollama-free',
                    model_id: 'm1',
                    checked_at: '2026-07-10T12:34:00.000Z',
                    public_status: 'OPERATIONAL',
                    classification: 'SUCCESS',
                    total_duration_ms: null,
                    rtt_ms: 2,
                },
                {
                    provider_id: 'ollama-free',
                    model_id: 'm1',
                    checked_at: '2026-07-10T13:34:00.000Z',
                    public_status: 'OUTAGE',
                    classification: 'TIMEOUT',
                    total_duration_ms: null,
                    rtt_ms: 3,
                },
            ],
            null,
            reference,
            'FREE',
        );
        const paid = historyBuckets([], '1h', reference, 'PAID');

        expect(free).toHaveLength(12);
        expect(paid).toHaveLength(4);
        expect(free[0]).toMatchObject({ startAt: '2026-07-10T12:34:00.000Z', checks: 1 });
        expect(free.at(-1)?.startAt).toBe('2026-07-10T13:29:00.000Z');
        expect(paid[0].startAt).toBe('2026-07-10T12:34:00.000Z');
        expect(paid.at(-1)?.startAt).toBe('2026-07-10T13:19:00.000Z');
        expect(historyBuckets([], 'invalid', reference, 'FREE')).toHaveLength(12);
    });

    it('generates UTC hourly buckets and leaves periods without checks unknown', () => {
        const reference = new Date('2026-07-10T13:34:00.000Z');
        const buckets = historyBuckets(
            [
                {
                    provider_id: 'ollama-free',
                    model_id: 'm1',
                    checked_at: '2026-07-10T13:15:00.000Z',
                    public_status: 'OPERATIONAL',
                    classification: 'SUCCESS',
                    total_duration_ms: 25,
                    rtt_ms: 30,
                },
            ],
            '24h',
            reference,
        );

        expect(buckets).toHaveLength(24);
        expect(buckets[0]).toMatchObject({
            startAt: '2026-07-09T14:00:00.000Z',
            status: 'UNKNOWN',
            checks: 0,
        });
        expect(buckets.at(-1)).toMatchObject({
            startAt: '2026-07-10T13:00:00.000Z',
            status: 'OPERATIONAL',
            checks: 1,
            averageLatencyMs: 25,
            latencySamples: 1,
        });
    });

    it('generates seven and thirty UTC daily buckets', () => {
        const reference = new Date('2026-07-10T13:34:00.000Z');
        expect(historyBuckets([], '7d', reference)).toHaveLength(7);
        expect(historyBuckets([], '7d', reference)[0].startAt).toBe('2026-07-04T00:00:00.000Z');
        expect(historyBuckets([], '30d', reference)).toHaveLength(30);
        expect(historyBuckets([], '30d', reference)[0].startAt).toBe('2026-06-11T00:00:00.000Z');
    });

    it('uses the worst observed status within each history bucket', () => {
        expect(worstStatus(['OPERATIONAL', 'DEGRADED', 'RATE_LIMITED'])).toBe('RATE_LIMITED');
        expect(worstStatus(['PLAN_REQUIRED', 'AUTHENTICATION', 'OPERATIONAL'])).toBe(
            'AUTHENTICATION',
        );
        const buckets = historyBuckets(
            [
                {
                    provider_id: 'ollama-free',
                    model_id: 'm1',
                    checked_at: '2026-07-10T13:10:00.000Z',
                    public_status: 'OPERATIONAL',
                    classification: 'SUCCESS',
                    total_duration_ms: null,
                    rtt_ms: 30,
                },
                {
                    provider_id: 'ollama-free',
                    model_id: 'm1',
                    checked_at: '2026-07-10T13:20:00.000Z',
                    public_status: 'OUTAGE',
                    classification: 'TIMEOUT',
                    total_duration_ms: null,
                    rtt_ms: 30,
                },
                {
                    provider_id: 'ollama-free',
                    model_id: 'm1',
                    checked_at: '2026-07-10T13:25:00.000Z',
                    public_status: 'OPERATIONAL',
                    classification: 'SUCCESS',
                    total_duration_ms: null,
                    rtt_ms: 30,
                },
            ],
            '24h',
            new Date('2026-07-10T13:34:00.000Z'),
        );
        expect(buckets.at(-1)).toMatchObject({
            status: 'OUTAGE',
            checks: 3,
            segments: [
                { status: 'OUTAGE', checks: 1 },
                { status: 'OPERATIONAL', checks: 2 },
            ],
        });
    });

    it('uses RTT for the bucket average only when total duration is unavailable', () => {
        const buckets = historyBuckets(
            [
                {
                    provider_id: 'ollama-free',
                    model_id: 'm1',
                    checked_at: '2026-07-10T13:10:00.000Z',
                    public_status: 'OPERATIONAL',
                    classification: 'SUCCESS',
                    total_duration_ms: null,
                    rtt_ms: 20,
                },
                {
                    provider_id: 'ollama-free',
                    model_id: 'm1',
                    checked_at: '2026-07-10T13:20:00.000Z',
                    public_status: 'OPERATIONAL',
                    classification: 'SUCCESS',
                    total_duration_ms: null,
                    rtt_ms: 40,
                },
            ],
            '24h',
            new Date('2026-07-10T13:34:00.000Z'),
        );
        expect(buckets.at(-1)).toMatchObject({ averageLatencyMs: 30, latencySamples: 2 });
    });

    it('prefers paid results for paid models and otherwise retains the free subscription status', () => {
        const freeOnly = [
            {
                provider_id: 'ollama-free',
                model_id: 'm1',
                public_status: 'PLAN_REQUIRED',
                classification: 'SUBSCRIPTION_REQUIRED',
                last_check_at: null,
                last_latency_ms: null,
            },
        ];
        const withPaid = [
            ...freeOnly,
            {
                provider_id: 'ollama-paid',
                model_id: 'm1',
                public_status: 'OPERATIONAL',
                classification: 'SUCCESS',
                last_check_at: null,
                last_latency_ms: null,
            },
        ];
        expect(effectiveProvider('FREE', 'm1', withPaid)).toBe('ollama-free');
        expect(effectiveProvider('PAID', 'm1', freeOnly)).toBe('ollama-free');
        expect(effectiveProvider('PAID', 'm1', withPaid)).toBe('ollama-paid');
    });

    it('uses the most recent completed successful monitor run as the data update time', () => {
        expect(
            lastSuccessfulFinishedAt([
                { outcome: 'OK', finished_at: '2026-07-10T12:00:00.000Z' },
                { outcome: 'ERROR', finished_at: '2026-07-10T13:00:00.000Z' },
                { outcome: 'OK', finished_at: '2026-07-10T12:30:00.000Z' },
                { outcome: 'OK', finished_at: null },
            ]),
        ).toBe('2026-07-10T12:30:00.000Z');
        expect(
            lastSuccessfulFinishedAt([
                { outcome: 'ERROR', finished_at: '2026-07-10T13:00:00.000Z' },
            ]),
        ).toBeNull();
    });

    it('finds the earliest scheduled active check for each monitored tier', () => {
        expect(
            nextUpdatesForModels([
                { tier: 'FREE', next_check_at: '2026-07-10T12:10:00.000Z' },
                { tier: 'FREE', next_check_at: '2026-07-10T12:05:00.000Z' },
                { tier: 'PAID', next_check_at: '2026-07-10T12:15:00.000Z' },
                { tier: 'UNKNOWN', next_check_at: '2026-07-10T12:00:00.000Z' },
                { tier: 'PAID', next_check_at: null },
            ]),
        ).toEqual({ free: '2026-07-10T12:05:00.000Z', paid: '2026-07-10T12:15:00.000Z' });
        expect(nextUpdatesForModels([])).toEqual({ free: null, paid: null });
        expect(nextUpdatesForModels([{ tier: 'FREE', next_check_at: null }])).toEqual({
            free: null,
            paid: null,
        });
    });

    it('rounds checks to the next five-minute scheduler boundary and pauses countdowns while updating', () => {
        expect(roundUpToMonitorInterval('2026-07-10T12:01:01.000Z')).toBe(
            Date.parse('2026-07-10T12:05:00.000Z'),
        );
        expect(
            nextUpdateLabel(
                '2026-07-10T12:01:01.000Z',
                false,
                Date.parse('2026-07-10T12:00:00.000Z'),
            ),
        ).toBe('in 5m 0s');
        expect(
            nextUpdateLabel(
                '2026-07-10T12:01:01.000Z',
                true,
                Date.parse('2026-07-10T12:00:00.000Z'),
            ),
        ).toBe('Updating…');
        expect(nextUpdateLabel(null, false, Date.parse('2026-07-10T12:00:00.000Z'))).toBe(
            'No checks scheduled',
        );
    });

    it('keeps account failures distinct from model failures', () => {
        expect(classifyHttp(401)).toBe('AUTH_ERROR');
        expect(classifyHttp(429)).toBe('RATE_LIMITED');
        expect(classifyHttp(404)).toBe('MODEL_NOT_FOUND');
        expect(publicStatusFor('AUTH_ERROR')).toBe('AUTHENTICATION');
        expect(publicStatusFor('MODEL_NOT_FOUND')).toBe('MODEL_NOT_FOUND');
        expect(publicStatusFor('SUBSCRIPTION_REQUIRED')).toBe('PLAN_REQUIRED');
        expect(publicStatusFor('EMPTY_RESPONSE')).toBe('OUTAGE');
    });

    it('uses either the absolute latency threshold or a useful baseline multiplier', () => {
        expect(isLatencyAnomalous(10_001, 100_000)).toBe(true);
        expect(isLatencyAnomalous(10_000, 100_000)).toBe(false);
        expect(isLatencyAnomalous(9_000, 5_000)).toBe(true);
        expect(isLatencyAnomalous(8_750, 5_000)).toBe(false);
        expect(isLatencyAnomalous(8_000, 6_000)).toBe(false);
        expect(isLatencyAnomalous(10_501, 6_000)).toBe(true);
        expect(isLatencyAnomalous(9_000)).toBe(false);
        expect(isLatencyAnomalous(9_000, 0)).toBe(false);
        expect(isLatencyAnomalous(9_000, Number.NaN)).toBe(false);
    });

    it('requires failures to be current and high latency to be consecutive before materializing them', () => {
        const base = {
            priorStatus: 'OPERATIONAL',
            resultStatus: 'DEGRADED' as const,
            successes: 0,
            failures: 0,
            recentFailures: 3,
            highLatency: 0,
            hasActiveIncident: false,
        };
        expect(
            materializedStatus({ ...base, classification: 'HIGH_LATENCY', highLatency: 1 }),
        ).toBe('OPERATIONAL');
        expect(
            materializedStatus({ ...base, classification: 'HIGH_LATENCY', highLatency: 2 }),
        ).toBe('DEGRADED');
        expect(materializedStatus({ ...base, classification: 'SUCCESS', successes: 1 })).toBe(
            'OPERATIONAL',
        );
        expect(
            materializedStatus({
                ...base,
                classification: 'EMPTY_RESPONSE',
                resultStatus: 'OUTAGE',
                failures: 1,
            }),
        ).toBe('OUTAGE');
    });

    it('materializes an outage after exactly two consecutive empty responses', () => {
        expect(
            materializedStatus({
                priorStatus: 'OPERATIONAL',
                classification: 'EMPTY_RESPONSE',
                resultStatus: 'OUTAGE',
                successes: 0,
                failures: 2,
                recentFailures: 2,
                highLatency: 0,
                hasActiveIncident: false,
            }),
        ).toBe('OUTAGE');
    });

    it('renews a monitor lease only for its current owner', async () => {
        let sql = '';
        let bindings: unknown[] = [];
        const env = {
            DB: {
                prepare(statement: string) {
                    sql = statement;
                    return {
                        bind(...values: unknown[]) {
                            bindings = values;
                            return { run: async () => ({ meta: { changes: 1 } }) };
                        },
                    };
                },
            },
        } as unknown as Env;

        expect(await renewLock(env, 'monitor', 'owner-1')).toBe(true);
        expect(sql).toContain('WHERE name=? AND owner=?');
        expect(bindings.slice(2)).toEqual(['monitor', 'owner-1']);
        expect(Date.parse(bindings[0] as string)).toBeGreaterThan(
            Date.parse(bindings[1] as string),
        );
    });

    it('trims outliers only with enough samples', () => {
        expect(trimmedMean([1, 2, 3])).toBe(2);
        expect(trimmedMean([1, 2, 3, 4, 5, 6, 7, 8, 9, 1_000])).toBe(5.5);
    });

    it('backs off authentication and quota failures', () => {
        const now = Date.now();
        expect(
            new Date(nextCheckAt('AUTHENTICATION', false)).getTime() - now,
        ).toBeGreaterThanOrEqual(59 * 60_000);
        expect(
            new Date(nextCheckAt('RATE_LIMITED', false, 7200)).getTime() - now,
        ).toBeGreaterThanOrEqual(119 * 60_000);
    });

    it('recovers a self-inflicted rate limit on the next cycle instead of a full hour', () => {
        const now = Date.now();
        // No Retry-After header → short default (~5 min), not the old 60-minute lockout.
        const noHeader = new Date(nextCheckAt('RATE_LIMITED', false)).getTime() - now;
        expect(noHeader).toBeLessThanOrEqual(6 * 60_000);
        expect(noHeader).toBeGreaterThanOrEqual(4 * 60_000);
        // A shorter Retry-After is still floored to the 5-minute cron cadence.
        expect(
            new Date(nextCheckAt('RATE_LIMITED', false, 30)).getTime() - now,
        ).toBeGreaterThanOrEqual(4 * 60_000);
    });

    it('admits any check that comes due before the next cron tick so a late run does not drift the cadence', () => {
        const reference = Date.parse('2026-07-10T12:00:00.000Z');
        const grace = Date.parse(eligibilityCutoff(reference)) - reference;
        // Wide enough to absorb a full run's within-run processing drift...
        expect(grace).toBeGreaterThan(0);
        // ...but STRICTLY below one cron interval, or the 15-minute paid cadence would be pulled down to 10.
        expect(grace).toBeLessThan(CRON_INTERVAL_MS);
    });

    it('checks free models every five minutes and paid models every fifteen', () => {
        expect(nominalCheckIntervalMinutes('FREE')).toBe(5);
        expect(nominalCheckIntervalMinutes('UNKNOWN')).toBe(5);
        expect(nominalCheckIntervalMinutes('PAID')).toBe(15);
        expect(checkIntervalMinutes('OPERATIONAL', false, undefined, 'FREE')).toBe(5);
        expect(checkIntervalMinutes('OPERATIONAL', false, undefined, 'PAID')).toBe(15);
        expect(checkIntervalMinutes('DEGRADED', false, undefined, 'PAID')).toBe(5);
    });

    it('keeps the paid cadence after a paid-provider probe', () => {
        const paidProvider = {
            id: 'ollama-paid',
            name: 'Paid',
            base_url: 'https://example.test',
            secret_ref: 'OLLAMA_API_KEY_PAID' as const,
        };
        const unclassifiedModel = {
            id: 'm1',
            provider_id: 'ollama-free',
            remote_name: 'm1',
            digest: null,
            last_show_at: null,
            tier: 'UNKNOWN' as const,
        };
        const successfulProbe = {
            classification: 'SUCCESS' as const,
            publicStatus: 'OPERATIONAL' as const,
            rttMs: 1,
        };
        expect(nextCheckTier(paidProvider, unclassifiedModel, successfulProbe)).toBe('PAID');
        expect(
            checkIntervalMinutes(
                successfulProbe.publicStatus,
                false,
                undefined,
                nextCheckTier(paidProvider, unclassifiedModel, successfulProbe),
            ),
        ).toBe(15);
    });

    it('uses the free probe as the only entitlement decision', () => {
        expect(entitlementFromFreeProbe('SUCCESS')).toBe('FREE');
        expect(entitlementFromFreeProbe('SUBSCRIPTION_REQUIRED')).toBe('PAID');
        expect(entitlementFromFreeProbe('AUTH_ERROR')).toBe('UNKNOWN');
        expect(shouldProbePaid('SUCCESS', true)).toBe(false);
        expect(shouldProbePaid('SUBSCRIPTION_REQUIRED', false)).toBe(false);
        expect(shouldProbePaid('SUBSCRIPTION_REQUIRED', true)).toBe(true);
    });

    it('uses a bounded configured response-token limit', () => {
        expect(maxResponseTokens(undefined)).toBe(8);
        expect(maxResponseTokens('32')).toBe(32);
        expect(maxResponseTokens('0')).toBe(8);
        expect(maxResponseTokens('4097')).toBe(8);
    });

    it('accepts the first content chunk of an Ollama Chat stream', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () =>
            new Response(
                '{"model":"cloud","message":{"role":"assistant","content":"OK"},"done":false}\n',
                { status: 200 },
            );
        try {
            const provider = new OllamaProvider(
                {
                    id: 'ollama-free',
                    name: 'Free',
                    base_url: 'https://example.test/api',
                    secret_ref: 'OLLAMA_API_KEY_FREE',
                },
                'test-key',
            );
            const result = await provider.probe('cloud');
            expect(result.classification).toBe('SUCCESS');
            expect(result.totalDurationMs).toBeUndefined();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('classifies a Chat entitlement response before attempting to read its stream', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () =>
            new Response(
                `this model requires a subscription, upgrade for access${'x'.repeat(65 * 1024)}`,
                { status: 403 },
            );
        try {
            const provider = new OllamaProvider(
                {
                    id: 'ollama-free',
                    name: 'Free',
                    base_url: 'https://example.test/api',
                    secret_ref: 'OLLAMA_API_KEY_FREE',
                },
                'test-key',
            );
            expect((await provider.probe('paid-model')).classification).toBe(
                'SUBSCRIPTION_REQUIRED',
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('accepts a thinking fragment as evidence that inference started', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () =>
            new Response('{"message":{"thinking":"considering"},"done":false}\n', { status: 200 });
        try {
            const provider = new OllamaProvider(
                {
                    id: 'ollama-free',
                    name: 'Free',
                    base_url: 'https://example.test/api',
                    secret_ref: 'OLLAMA_API_KEY_FREE',
                },
                'test-key',
            );
            expect((await provider.probe('thinking-model')).classification).toBe('SUCCESS');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('classifies a completed stream without useful content as an outage', async () => {
        const originalFetch = globalThis.fetch;
        const streams = [
            '',
            '\n \r\n',
            `${JSON.stringify({ message: { content: '', thinking: '' }, done: false })}\n${JSON.stringify({ done: true })}\n`,
            `${JSON.stringify({ message: { content: '   ', thinking: '\t' }, done: true })}\n`,
        ];
        try {
            for (const stream of streams) {
                globalThis.fetch = async () => new Response(stream, { status: 200 });
                const provider = new OllamaProvider(
                    {
                        id: 'ollama-free',
                        name: 'Free',
                        base_url: 'https://example.test/api',
                        secret_ref: 'OLLAMA_API_KEY_FREE',
                    },
                    'test-key',
                );
                expect(await provider.probe('empty-model')).toMatchObject({
                    classification: 'EMPTY_RESPONSE',
                    publicStatus: 'OUTAGE',
                    errorCode: 'empty_response',
                });
            }
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('keeps malformed or explicitly failed streams as protocol errors', async () => {
        const originalFetch = globalThis.fetch;
        try {
            const invalidChunks = [
                {},
                { message: null },
                { message: { content: 1 } },
                { message: { thinking: false } },
                { done: 'true' },
                { error: null },
            ];
            const malformedStreams = [
                'not-json\n',
                'null\n',
                '[]\n',
                '1\n',
                '"text"\n',
                ...invalidChunks.map((chunk) => `${JSON.stringify(chunk)}\n`),
            ];
            for (const stream of malformedStreams) {
                globalThis.fetch = async () => new Response(stream, { status: 200 });
                const provider = new OllamaProvider(
                    {
                        id: 'ollama-free',
                        name: 'Free',
                        base_url: 'https://example.test/api',
                        secret_ref: 'OLLAMA_API_KEY_FREE',
                    },
                    'test-key',
                );
                expect(await provider.probe('broken-model')).toMatchObject({
                    classification: 'PROTOCOL_ERROR',
                    publicStatus: 'CONFIGURATION',
                    errorCode: 'invalid_stream',
                });
            }
            globalThis.fetch = async () =>
                new Response(`${JSON.stringify({ error: 'generation failed' })}\n`, {
                    status: 200,
                });
            const failedProvider = new OllamaProvider(
                {
                    id: 'ollama-free',
                    name: 'Free',
                    base_url: 'https://example.test/api',
                    secret_ref: 'OLLAMA_API_KEY_FREE',
                },
                'test-key',
            );
            expect(await failedProvider.probe('failed-model')).toMatchObject({
                classification: 'PROTOCOL_ERROR',
                publicStatus: 'CONFIGURATION',
                errorCode: 'stream_error',
            });
            globalThis.fetch = async () => new Response(null, { status: 200 });
            const provider = new OllamaProvider(
                {
                    id: 'ollama-free',
                    name: 'Free',
                    base_url: 'https://example.test/api',
                    secret_ref: 'OLLAMA_API_KEY_FREE',
                },
                'test-key',
            );
            expect(await provider.probe('missing-stream-model')).toMatchObject({
                classification: 'PROTOCOL_ERROR',
                publicStatus: 'CONFIGURATION',
                errorCode: 'missing_stream',
            });
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('rejects an oversized Chat stream as a bounded protocol error', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response('x'.repeat(65 * 1024), { status: 200 });
        try {
            const provider = new OllamaProvider(
                {
                    id: 'ollama-free',
                    name: 'Free',
                    base_url: 'https://example.test/api',
                    secret_ref: 'OLLAMA_API_KEY_FREE',
                },
                'test-key',
            );
            expect(await provider.probe('unbounded-model')).toMatchObject({
                classification: 'PROTOCOL_ERROR',
                publicStatus: 'CONFIGURATION',
                errorCode: 'stream_too_large',
            });
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

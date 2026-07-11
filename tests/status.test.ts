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
import { OllamaProvider, PROBE_TIMEOUT_MS } from '../src/worker/ollama';
import {
    effectiveProvider,
    findActiveRun,
    historyBuckets,
    isInfeasible,
    isStuckRun,
    lastSuccessfulFinishedAt,
    nextUpdatesForModels,
    RUN_STALE_AGE_MS,
    worstStatus,
} from '../src/worker/api';
import {
    acquireLock,
    materializeStatus,
    materializedStatus,
    nextCheckTier,
    probeConcurrency,
    probeDelayMs,
    renewLock,
    runDeadlineMs,
    runMonitor,
} from '../src/worker/monitor';
import { now } from '../src/worker/types';
import type { Env, Model, ProbeResult, Provider } from '../src/worker/types';
import { nextUpdateLabel, roundUpToMonitorInterval } from '../src/web/next-update';

describe('Ollama status classification', () => {
    it('uses a grid-aligned one-hour window with fixed 5-minute buckets for every tier', () => {
        // reference 13:34 sits in the 5-minute slot [13:30,13:35); the window is the 12 slots
        // ending at that slot, i.e. [12:35, 13:35) with bucket starts 12:35 .. 13:30.
        const reference = new Date('2026-07-10T13:34:00.000Z');
        const free = historyBuckets(
            [
                {
                    provider_id: 'ollama-free',
                    model_id: 'm1',
                    checked_at: '2026-07-10T12:40:05.000Z',
                    public_status: 'OPERATIONAL',
                    classification: 'SUCCESS',
                    total_duration_ms: 20,
                    rtt_ms: 25,
                },
                {
                    provider_id: 'ollama-free',
                    model_id: 'm1',
                    checked_at: '2026-07-10T13:30:05.000Z',
                    public_status: 'OPERATIONAL',
                    classification: 'SUCCESS',
                    total_duration_ms: null,
                    rtt_ms: 30,
                },
                {
                    provider_id: 'ollama-free',
                    model_id: 'm1',
                    checked_at: '2026-07-10T13:30:50.000Z',
                    public_status: 'OUTAGE',
                    classification: 'TIMEOUT',
                    total_duration_ms: null,
                    rtt_ms: 40,
                },
            ],
            null,
            reference,
        );
        // Bucket size is decoupled from cadence: both tiers get 12 fixed 5-minute buckets.
        const paid = historyBuckets([], '1h', reference);

        expect(free).toHaveLength(12);
        expect(paid).toHaveLength(12);
        // Grid-aligned boundaries: first bucket [12:35,12:40), last (current slot) [13:30,13:35).
        expect(free[0]).toMatchObject({ startAt: '2026-07-10T12:35:00.000Z', checks: 0 });
        expect(free.at(-1)?.startAt).toBe('2026-07-10T13:30:00.000Z');
        expect(paid[0].startAt).toBe('2026-07-10T12:35:00.000Z');
        expect(paid.at(-1)?.startAt).toBe('2026-07-10T13:30:00.000Z');
        // A check at 12:40:05 lands in the [12:40,12:45) bucket (one per slot, no redistribution).
        expect(free[1]).toMatchObject({
            startAt: '2026-07-10T12:40:00.000Z',
            checks: 1,
            status: 'OPERATIONAL',
        });
        // Two checks in the current slot [13:30,13:35) collapse to worst status (OUTAGE).
        expect(free.at(-1)).toMatchObject({
            startAt: '2026-07-10T13:30:00.000Z',
            checks: 2,
            status: 'OUTAGE',
        });
        expect(historyBuckets([], 'invalid', reference)).toHaveLength(12);
    });

    it('keeps each check in a stable, grid-aligned bucket across refreshes (no transient holes)', () => {
        // 12 checks at a 5-minute cadence with small jitter (one per slot at :05), reflecting
        // staggered execution. Two refreshes 90s apart (same slot) must assign every check to
        // the SAME bucket — the old sliding `start = now - 60min` calculation would shift
        // boundaries by 90s between these calls and redistribute checks, creating a hole that
        // later refills. Grid alignment pins each check to its clock slot regardless of `now`.
        const slotChecks = Array.from({ length: 12 }, (_, k) => {
            const start = new Date('2026-07-10T12:35:00.000Z').getTime() + k * 5 * 60_000;
            return {
                provider_id: 'ollama-free',
                model_id: 'm1',
                checked_at: new Date(start + 5_000).toISOString(),
                public_status: 'OPERATIONAL',
                classification: 'SUCCESS',
                total_duration_ms: 15,
                rtt_ms: 20,
            };
        });
        const now1 = new Date('2026-07-10T13:32:00.000Z');
        const now2 = new Date('2026-07-10T13:33:30.000Z'); // 90s later, still in slot [13:30,13:35)

        const atNow1 = historyBuckets(slotChecks, '1h', now1);
        const atNow2 = historyBuckets(slotChecks, '1h', now2);

        // Identical boundaries and counts across refreshes — no redistribution, no flit.
        expect(atNow1.map((b) => b.startAt)).toEqual(atNow2.map((b) => b.startAt));
        expect(atNow1.map((b) => b.checks)).toEqual(atNow2.map((b) => b.checks));
        // Every bucket holds exactly one check — no hole between filled buckets.
        expect(atNow1.every((b) => b.checks === 1)).toBe(true);
        // A fixed check stays in its clock slot regardless of `now`.
        const slotOfCheck = (buckets: typeof atNow1) =>
            buckets.find((b) => b.startAt === '2026-07-10T12:40:00.000Z')?.checks;
        expect(slotOfCheck(atNow1)).toBe(1);
        expect(slotOfCheck(atNow2)).toBe(1);
    });

    it('scrolls the 1h window by one slot when now crosses a 5-minute boundary', () => {
        // A check at 13:30:05 belongs to slot [13:30,13:35). While now is in that slot it is the
        // last bucket; after now crosses 13:35 it becomes the second-to-last — same clock slot,
        // only the window position changed (discrete scroll, not a redistribution).
        const check = {
            provider_id: 'ollama-free',
            model_id: 'm1',
            checked_at: '2026-07-10T13:30:05.000Z',
            public_status: 'OPERATIONAL',
            classification: 'SUCCESS',
            total_duration_ms: 10,
            rtt_ms: 12,
        };
        const before = historyBuckets([check], '1h', new Date('2026-07-10T13:34:59.999Z'));
        const after = historyBuckets([check], '1h', new Date('2026-07-10T13:35:00.000Z'));
        expect(before.at(-1)?.startAt).toBe('2026-07-10T13:30:00.000Z');
        expect(before.at(-1)?.checks).toBe(1);
        // After crossing the boundary the check is still in slot [13:30,13:35) (now second-to-last).
        expect(after.at(-2)?.startAt).toBe('2026-07-10T13:30:00.000Z');
        expect(after.at(-2)?.checks).toBe(1);
        // The new current slot [13:35,13:40) is empty → pending.
        expect(after.at(-1)).toMatchObject({
            startAt: '2026-07-10T13:35:00.000Z',
            checks: 0,
            pending: true,
        });
    });

    it('marks the empty bucket containing now as pending, older empty buckets as no data', () => {
        const reference = new Date('2026-07-10T13:34:00.000Z');
        const buckets = historyBuckets([], '1h', reference);

        expect(buckets).toHaveLength(12);
        // Only the last bucket (ends at `now`) is pending when empty.
        expect(buckets.at(-1)).toMatchObject({ checks: 0, pending: true });
        // Every older empty bucket is a genuine no-data gap, not pending.
        for (let i = 0; i < buckets.length - 1; i++) {
            expect(buckets[i]).toMatchObject({ checks: 0, pending: false });
        }
        // A check landing in the last bucket (current slot [13:30,13:35)) clears its pending flag.
        const withLastCheck = historyBuckets(
            [
                {
                    provider_id: 'ollama-free',
                    model_id: 'm1',
                    checked_at: '2026-07-10T13:30:30.000Z',
                    public_status: 'OPERATIONAL',
                    classification: 'SUCCESS',
                    total_duration_ms: 20,
                    rtt_ms: 25,
                },
            ],
            '1h',
            reference,
        );
        expect(withLastCheck.at(-1)).toMatchObject({ checks: 1, pending: false });
        // The bucket before it stays a no-data gap (still empty, not now).
        expect(withLastCheck.at(-2)).toMatchObject({ checks: 0, pending: false });
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
        // A PARTIAL run (budget exceeded, run completed without error) still counts as
        // successful: the monitor is alive, just couldn't probe every due model in budget.
        expect(
            lastSuccessfulFinishedAt([
                { outcome: 'OK', finished_at: '2026-07-10T12:30:00.000Z' },
                { outcome: 'PARTIAL', finished_at: '2026-07-10T13:00:00.000Z' },
            ]),
        ).toBe('2026-07-10T13:00:00.000Z');
    });

    it('flags infeasibility only when the last few completed runs are all PARTIAL', () => {
        // runs are ordered most-recent first (as monitorRuns returns them). A single transient
        // PARTIAL among OK runs is NOT infeasible; only sustained budget exhaustion is.
        const ok = { outcome: 'OK', finished_at: '2026-07-10T13:00:00.000Z' };
        const partial = { outcome: 'PARTIAL', finished_at: '2026-07-10T13:05:00.000Z' };
        const errored = { outcome: 'ERROR', finished_at: '2026-07-10T13:05:00.000Z' };
        expect(isInfeasible([partial, partial, partial])).toBe(true);
        // An OK run breaks the streak → not infeasible.
        expect(isInfeasible([partial, ok, partial])).toBe(false);
        // An ERROR run breaks the streak too (different problem, not budget infeasibility).
        expect(isInfeasible([partial, errored, partial])).toBe(false);
        // Fewer than 3 completed runs → insufficient evidence, not infeasible.
        expect(isInfeasible([partial, partial])).toBe(false);
        // In-flight (unfinished) runs don't count toward the streak.
        expect(
            isInfeasible([{ outcome: 'PARTIAL', finished_at: null }, partial, partial, partial]),
        ).toBe(true);
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

describe('probe throttle configuration', () => {
    const env = (overrides: Partial<Env> = {}) =>
        ({
            PROBE_CONCURRENCY: '1',
            PROBE_DELAY_MIN_MS: '0',
            PROBE_DELAY_MAX_MS: '5000',
            ...overrides,
        }) as unknown as Env;

    it('clamps probe concurrency to a safe range with sensible defaults', () => {
        expect(probeConcurrency(env())).toBe(1);
        expect(probeConcurrency(env({ PROBE_CONCURRENCY: '4' }))).toBe(4);
        expect(probeConcurrency(env({ PROBE_CONCURRENCY: '0' }))).toBe(1);
        expect(probeConcurrency(env({ PROBE_CONCURRENCY: '-3' }))).toBe(1);
        expect(probeConcurrency(env({ PROBE_CONCURRENCY: '999' }))).toBe(16);
        expect(probeConcurrency(env({ PROBE_CONCURRENCY: 'garbage' }))).toBe(1);
        expect(probeConcurrency(env({ PROBE_CONCURRENCY: undefined }))).toBe(1);
    });

    it('parses the configurable inter-probe delay range, swapping inverted bounds', () => {
        expect(probeDelayMs(env())).toEqual({ min: 0, max: 5000 });
        expect(
            probeDelayMs(env({ PROBE_DELAY_MIN_MS: '1000', PROBE_DELAY_MAX_MS: '3000' })),
        ).toEqual({
            min: 1000,
            max: 3000,
        });
        // Inverted bounds are normalized so min <= max.
        expect(
            probeDelayMs(env({ PROBE_DELAY_MIN_MS: '4000', PROBE_DELAY_MAX_MS: '500' })),
        ).toEqual({
            min: 500,
            max: 4000,
        });
        // Unparseable / missing values fall back to defaults.
        expect(probeDelayMs(env({ PROBE_DELAY_MIN_MS: 'nope', PROBE_DELAY_MAX_MS: '' }))).toEqual({
            min: 0,
            max: 5000,
        });
    });
});

describe('D1 write avoidance', () => {
    // Minimal D1 mock that routes each statement by SQL pattern and records every write (run)
    // so write-skip optimizations can be asserted directly. Reads use first()/all(); the code
    // only calls one of first/all/run per statement, so a single bound object suffices.
    const mockEnv = (routes: { match: RegExp; first?: () => unknown; all?: () => unknown }[]) => {
        const runs: string[] = [];
        const env = {
            DB: {
                prepare(sql: string) {
                    return {
                        bind(..._args: unknown[]) {
                            const route = routes.find((r) => r.match.test(sql));
                            return {
                                first: async () => route?.first?.() ?? null,
                                all: async () => route?.all?.() ?? { results: [] },
                                run: async () => {
                                    runs.push(sql);
                                    return { meta: { changes: 1 } };
                                },
                            };
                        },
                    };
                },
            },
        } as unknown as Env;
        return { env, runs };
    };

    it('skips rewriting models.tier when it already matches the probe classification', async () => {
        const { env, runs } = mockEnv([
            { match: /SELECT \* FROM provider_model_status/, first: () => null },
            { match: /SELECT classification FROM checks/, all: () => ({ results: [] }) },
        ]);
        const provider = { id: 'ollama-free' } as Provider;
        const result = {
            classification: 'SUCCESS',
            publicStatus: 'OPERATIONAL',
            totalDurationMs: 120,
            rttMs: 50,
        } as ProbeResult;
        // tier already FREE → the UPDATE must be skipped (no write).
        await materializeStatus(
            env,
            provider,
            { id: 'm1', remote_name: 'm1', tier: 'FREE' } as unknown as Model,
            result,
            now(),
        );
        expect(runs.some((sql) => /UPDATE models SET tier/.test(sql))).toBe(false);

        // tier differs from the probe-derived tier → the UPDATE must fire once.
        runs.length = 0;
        await materializeStatus(
            env,
            provider,
            { id: 'm2', remote_name: 'm2', tier: 'UNKNOWN' } as unknown as Model,
            result,
            now(),
        );
        const tierWrites = runs.filter((sql) => /UPDATE models SET tier/.test(sql));
        expect(tierWrites).toHaveLength(1);
    });

    it('keeps a 403 (SUBSCRIPTION_REQUIRED) as PLAN_REQUIRED without opening an incident', async () => {
        const { env, runs } = mockEnv([
            { match: /SELECT \* FROM provider_model_status/, first: () => null },
            { match: /SELECT classification FROM checks/, all: () => ({ results: [] }) },
        ]);
        const provider = { id: 'ollama-free' } as Provider;
        const result = {
            classification: 'SUBSCRIPTION_REQUIRED',
            publicStatus: 'PLAN_REQUIRED',
            totalDurationMs: null,
            rttMs: 40,
        } as unknown as ProbeResult;
        await materializeStatus(
            env,
            provider,
            { id: 'm3', remote_name: 'm3', tier: 'UNKNOWN' } as unknown as Model,
            result,
            now(),
        );
        // A 403 flips tier to PAID (one write) but must never insert an incident.
        expect(runs.some((sql) => /INSERT INTO incidents/.test(sql))).toBe(false);
        expect(runs.some((sql) => /UPDATE models SET tier/.test(sql))).toBe(true);
    });
});

describe('monitor run time-box (cadence preservation)', () => {
    const env = (overrides: Partial<Env> = {}) =>
        ({
            PROBE_CONCURRENCY: '1',
            PROBE_DELAY_MIN_MS: '0',
            PROBE_DELAY_MAX_MS: '5000',
            ...overrides,
        }) as unknown as Env;

    it('computes a deadline that leaves the lock free before the next cron tick', () => {
        const started = new Date('2026-07-10T13:00:00.000Z').getTime();
        const deadline = runDeadlineMs(started, env());
        // deadline = started + CRON_INTERVAL_MS - (PROBE_TIMEOUT_MS + maxDelay + 5s buffer)
        const expected =
            started + CRON_INTERVAL_MS - (PROBE_TIMEOUT_MS + probeDelayMs(env()).max + 5_000);
        expect(deadline).toBe(expected);
        // The deadline must sit strictly inside the 5-minute cron interval so a last in-flight
        // batch (up to PROBE_TIMEOUT_MS + maxDelay) can still finish before the next tick.
        expect(deadline).toBeGreaterThan(started);
        expect(deadline + PROBE_TIMEOUT_MS + probeDelayMs(env()).max).toBeLessThan(
            started + CRON_INTERVAL_MS,
        );
    });

    it('leaves a feasible budget for the default free-tier configuration', () => {
        const started = new Date('2026-07-10T13:00:00.000Z').getTime();
        const budget = runDeadlineMs(started, env()) - started;
        // 34 models at concurrency 1 with ~2.5s avg delay + ~1.5s probe ≈ 136s must fit comfortably.
        const nominalRunMs = 34 * ((0 + 5_000) / 2 + 1_500);
        expect(nominalRunMs).toBeLessThan(budget);
        expect(budget).toBeGreaterThan(3 * 60_000); // > 3 min of usable budget
    });

    it('flags infeasibility when a single probe+delay exceeds the cron interval', () => {
        // A huge configured delay makes one probe+delay longer than the whole tick: the deadline
        // falls at or before the start, so the run can't process any model and is marked PARTIAL
        // (explicit infeasibility detection instead of silently drifting cadence to ~10 min).
        const started = new Date('2026-07-10T13:00:00.000Z').getTime();
        const deadline = runDeadlineMs(started, env({ PROBE_DELAY_MAX_MS: '600000' }));
        expect(deadline).toBeLessThanOrEqual(started);
    });
});

describe('monitor run recovery', () => {
    it('prevents duplicate concurrent runs by keeping the lock for its first owner', async () => {
        // The first acquireLock inserts the row (changes=1, lock granted). A second caller while
        // the lease is still valid must NOT take the lock: the ON CONFLICT DO UPDATE WHERE clause
        // matches no row, so the driver reports changes=0 and acquireLock returns false — no
        // duplicate run is ever created by a racing cron tick.
        let calls = 0;
        const env = {
            DB: {
                prepare() {
                    return {
                        bind() {
                            // First call inserts the lock (changes=1); every later call finds the
                            // lease still valid and updates zero rows (changes=0).
                            return {
                                run: async () => ({ meta: { changes: ++calls === 1 ? 1 : 0 } }),
                            };
                        },
                    };
                },
            },
        } as unknown as Env;

        expect(await acquireLock(env, 'monitor', 'owner-A')).toBe(true);
        expect(await acquireLock(env, 'monitor', 'owner-B')).toBe(false);
    });

    it('treats an unfinished run older than one cron interval as stuck, not active', () => {
        const nowMs = Date.parse('2026-07-10T13:10:00.000Z');
        const recent = new Date(nowMs - 30_000).toISOString(); // 30s ago — genuinely in progress
        const old = new Date(nowMs - RUN_STALE_AGE_MS - 1).toISOString(); // just past one interval
        const runs = [
            { id: 'stuck', started_at: old, finished_at: null },
            { id: 'fresh', started_at: recent, finished_at: null },
            { id: 'done', started_at: new Date(nowMs - 60_000).toISOString(), finished_at: 'x' },
        ];

        // A fresh in-flight run is the active one; the old in-flight one is stuck, not active.
        const reconciled = findActiveRun(runs, nowMs);
        expect(reconciled.current?.id).toBe('fresh');
        expect(reconciled.stuck?.id).toBe('stuck');
        expect(isStuckRun(runs[0], nowMs)).toBe(true);
        expect(isStuckRun(runs[1], nowMs)).toBe(false);
        // A finished run, however old, is neither active nor stuck.
        expect(isStuckRun(runs[2], nowMs)).toBe(false);
    });

    it('reports no active and no stuck run when the latest run already finished', () => {
        const nowMs = Date.parse('2026-07-10T13:10:00.000Z');
        const runs = [
            { id: 'done', started_at: new Date(nowMs - 60_000).toISOString(), finished_at: 'x' },
        ];
        const reconciled = findActiveRun(runs, nowMs);
        expect(reconciled.current).toBeNull();
        expect(reconciled.stuck).toBeNull();
    });

    it('aborts a probe whose run-level signal fires, rethrowing instead of masking it as TIMEOUT', async () => {
        // When the run's hard stop aborts, a probe stuck on a stalled Ollama stream must not settle
        // for a TIMEOUT result (which would silently persist a check and hide the stuck run); it
        // must rethrow so runMonitor closes the run as abandoned.
        const originalFetch = globalThis.fetch;
        const runSignal = AbortSignal.abort();
        globalThis.fetch = async () => {
            throw new DOMException('aborted', 'AbortError');
        };
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
            await expect(provider.probe('cloud', undefined, runSignal)).rejects.toThrow();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('recovers on the next cycle: marks an orphaned prior run abandoned and starts a clean one', async () => {
        // Simulate a prior run that never finished (a stuck/evicted run) plus a catalog of one due
        // model. runMonitor must: (1) sweep the orphaned run to ABANDONED, (2) insert a new run,
        // (3) probe the model and complete the new run OK — recovering automatically without a
        // manual restart and without duplicating runs.
        const originalFetch = globalThis.fetch;
        const statements: string[] = [];
        const orphan = {
            id: 'run_old',
            started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
            finished_at: null,
            outcome: null,
            detail: null,
            phase: 'CHECKING',
            catalog_model_count: 1,
            scheduled_model_count: 1,
            completed_model_count: 0,
            free_probe_count: 0,
            paid_probe_count: 0,
            paid_skipped_count: 0,
            failed_probe_count: 0,
            current_model: null,
        };
        const env = {
            OLLAMA_BASE_URL: 'https://example.test/api',
            OLLAMA_API_KEY_FREE: 'k',
            PROBE_CONCURRENCY: '1',
            PROBE_DELAY_MIN_MS: '0',
            PROBE_DELAY_MAX_MS: '0',
            DB: {
                prepare(sql: string) {
                    const prepared = {
                        run: async () => {
                            statements.push(sql);
                            return { meta: { changes: 1 } };
                        },
                        all: async () => {
                            statements.push(sql);
                            if (/FROM models WHERE provider_id='ollama-free'/.test(sql))
                                return {
                                    results: [
                                        {
                                            id: 'ollama:m',
                                            provider_id: 'ollama-free',
                                            remote_name: 'm',
                                            digest: null,
                                            last_show_at: null,
                                            tier: 'UNKNOWN',
                                        },
                                    ],
                                };
                            if (/FROM providers WHERE active=1/.test(sql))
                                return {
                                    results: [
                                        {
                                            id: 'ollama-free',
                                            name: 'Free',
                                            base_url: 'https://example.test/api',
                                            secret_ref: 'OLLAMA_API_KEY_FREE',
                                        },
                                    ],
                                };
                            if (/FROM provider_model_status/.test(sql)) return { results: [] };
                            if (/FROM incidents WHERE id=/.test(sql)) return { results: [] };
                            if (/classification FROM checks/.test(sql)) return { results: [] };
                            if (/total_duration_ms FROM checks/.test(sql)) return { results: [] };
                            return { results: [orphan] }; // monitor_runs fallback
                        },
                        first: async () => {
                            statements.push(sql);
                            if (
                                /FROM models WHERE provider_id='ollama-free' AND remote_name=/.test(
                                    sql,
                                )
                            )
                                return null; // new model
                            if (/FROM provider_model_status/.test(sql)) return null;
                            if (/FROM incidents WHERE id=/.test(sql)) return null;
                            return null;
                        },
                        bind(..._b: unknown[]) {
                            return prepared; // bound and unbound access resolve to the same routes
                        },
                    };
                    return prepared;
                },
                batch(arr: { run: () => Promise<unknown> }[]) {
                    return Promise.all(arr.map((s) => s.run()));
                },
            },
        } as unknown as Env;
        const ctx = {
            waitUntil(p: Promise<unknown>) {
                void p.catch(() => {});
            },
        } as unknown as Parameters<typeof runMonitor>[1];
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input.toString();
            if (url.endsWith('/tags'))
                // Catalog listing with one model.
                return new Response(JSON.stringify({ models: [{ name: 'm', digest: 'd' }] }), {
                    status: 200,
                });
            if (url.endsWith('/show')) return new Response('{}', { status: 200 });
            // /chat stream: first content chunk proves inference started.
            return new Response('{"model":"m","message":{"content":"OK"},"done":true}\n', {
                status: 200,
            });
        }) as typeof fetch;
        try {
            await runMonitor(env, ctx);
        } finally {
            globalThis.fetch = originalFetch;
        }
        // (1) The orphaned in-flight run is swept to ABANDONED before any new run is created.
        expect(
            statements.some((s) => /finished_at=\?,outcome='ERROR',phase='ABANDONED'/.test(s)),
        ).toBe(true);
        // (2) A new run is inserted.
        expect(statements.some((s) => /INSERT INTO monitor_runs/.test(s))).toBe(true);
        // (3) The new run completes OK (not PARTIAL, not ERROR) after probing the due model.
        expect(statements.some((s) => /outcome=\?,phase='COMPLETED'/.test(s))).toBe(true);
    });
});

import { describe, expect, it, beforeEach } from 'vitest';
import { createTestDb, seedProvider, seedModel } from './helpers/ledger-fixture.ts';
import { materializeStatus } from '../src/worker/monitor.ts';
import { historyBuckets, latencyMetrics } from '../src/worker/api.ts';
import type { D1DatabaseLike, Env } from '../src/worker/types.ts';
import type { ProbeResult, Provider, Model } from '../src/worker/types.ts';
import type { HistoryCheck } from '../src/worker/api.ts';

function makeNow(): string {
    return new Date('2026-07-14T12:00:00Z').toISOString();
}

function makeProbeResult(overrides: Partial<ProbeResult> = {}): ProbeResult {
    return {
        classification: 'SUCCESS',
        publicStatus: 'OPERATIONAL',
        httpStatus: 200,
        rttMs: 500,
        ttftMs: 120,
        ...overrides,
    } as ProbeResult;
}

function makeCheck(overrides: Partial<HistoryCheck> = {}): HistoryCheck {
    return {
        provider_id: 'ollama-free',
        model_id: 'm1',
        checked_at: '2026-07-14T11:00:00.000Z',
        public_status: 'OPERATIONAL',
        classification: 'SUCCESS',
        total_duration_ms: 500,
        rtt_ms: 500,
        ttft_ms: 120,
        ...overrides,
    };
}

describe('ttftMs as canonical latency metric', () => {
    let db: D1DatabaseLike;
    let provider: Provider;
    let model: Model;

    beforeEach(async () => {
        db = createTestDb();
        const p = await seedProvider(db, { id: 'ollama-free', name: 'Free' });
        const m = await seedModel(db, { provider_id: p.id, remote_name: 'test-model' });
        provider = { id: p.id } as Provider;
        model = { id: m.id, remote_name: m.remote_name, tier: 'FREE' } as Model;
    });

    it('materializeStatus stores ttftMs as last_latency_ms on success', async () => {
        const env = { DB: db } as unknown as Env;
        const result = makeProbeResult({ classification: 'SUCCESS', ttftMs: 150, rttMs: 600 });
        await materializeStatus(env, provider, model, result, makeNow());

        const row = await db
            .prepare('SELECT last_latency_ms FROM provider_model_status WHERE provider_id=? AND model_id=?')
            .bind(provider.id, model.id)
            .first<{ last_latency_ms: number | null }>();

        expect(row).not.toBeNull();
        expect(row!.last_latency_ms).toBe(150);
    });

    it('materializeStatus stores null last_latency_ms when ttftMs is null', async () => {
        const env = { DB: db } as unknown as Env;
        const result = makeProbeResult({ classification: 'SUCCESS', ttftMs: null, rttMs: 600 });
        await materializeStatus(env, provider, model, result, makeNow());

        const row = await db
            .prepare('SELECT last_latency_ms FROM provider_model_status WHERE provider_id=? AND model_id=?')
            .bind(provider.id, model.id)
            .first<{ last_latency_ms: number | null }>();

        expect(row).not.toBeNull();
        expect(row!.last_latency_ms).toBeNull();
    });

    it('checkLatency prefers ttft_ms over total_duration_ms and rtt_ms', async () => {
        const { checkLatency } = await import('../src/worker/api.ts');

        const withTtft = makeCheck({ ttft_ms: 100, total_duration_ms: 500, rtt_ms: 500 });
        expect(checkLatency(withTtft)).toBe(100);

        const withoutTtft = makeCheck({ ttft_ms: null, total_duration_ms: 500, rtt_ms: 500 });
        expect(checkLatency(withoutTtft)).toBe(500);

        const onlyRtt = makeCheck({ ttft_ms: null, total_duration_ms: null, rtt_ms: 300 });
        expect(checkLatency(onlyRtt)).toBe(300);

        const allNull = makeCheck({ ttft_ms: null, total_duration_ms: null, rtt_ms: null });
        expect(checkLatency(allNull)).toBeNull();
    });

    it('latencyMetrics uses ttft_ms as primary source', async () => {
        const checks = [
            makeCheck({ checked_at: '2026-07-14T11:00:00.000Z', ttft_ms: 100, total_duration_ms: 500, rtt_ms: 500 }),
            makeCheck({ checked_at: '2026-07-14T11:05:00.000Z', ttft_ms: 200, total_duration_ms: 600, rtt_ms: 600 }),
            makeCheck({ checked_at: '2026-07-14T11:10:00.000Z', ttft_ms: 300, total_duration_ms: 700, rtt_ms: 700 }),
        ];

        const metrics = latencyMetrics(checks);
        expect(metrics.latencySource).toBe('TTFT');
        expect(metrics.samples).toBe(3);
        expect(metrics.p50LatencyMs).toBe(200);
        expect(metrics.p95LatencyMs).toBe(300);
    });

    it('latencyMetrics falls back to total_duration_ms when no ttft_ms', async () => {
        const checks = [
            makeCheck({ checked_at: '2026-07-14T11:00:00.000Z', ttft_ms: null, total_duration_ms: 500, rtt_ms: 500 }),
            makeCheck({ checked_at: '2026-07-14T11:05:00.000Z', ttft_ms: null, total_duration_ms: 600, rtt_ms: 600 }),
        ];

        const metrics = latencyMetrics(checks);
        expect(metrics.latencySource).toBe('TOTAL_DURATION');
        expect(metrics.samples).toBe(2);
    });

    it('latencyMetrics falls back to rtt_ms when no ttft_ms or total_duration_ms', async () => {
        const checks = [
            makeCheck({ checked_at: '2026-07-14T11:00:00.000Z', ttft_ms: null, total_duration_ms: null, rtt_ms: 300 }),
            makeCheck({ checked_at: '2026-07-14T11:05:00.000Z', ttft_ms: null, total_duration_ms: null, rtt_ms: 400 }),
        ];

        const metrics = latencyMetrics(checks);
        expect(metrics.latencySource).toBe('RTT');
        expect(metrics.samples).toBe(2);
    });

    it('historyBuckets uses ttft_ms for bucket averages when available', async () => {
        const checks = [
            makeCheck({ checked_at: '2026-07-13T14:10:00.000Z', ttft_ms: 100, total_duration_ms: 500, rtt_ms: 500 }),
            makeCheck({ checked_at: '2026-07-13T14:15:00.000Z', ttft_ms: 200, total_duration_ms: 600, rtt_ms: 600 }),
        ];

        const buckets = historyBuckets(checks, '24h', new Date('2026-07-14T12:00:00.000Z'));
        expect(buckets.length).toBeGreaterThan(0);
        const bucket = buckets.find((b) => b.checks > 0);
        expect(bucket).toBeDefined();
        expect(bucket!.averageLatencyMs).toBe(150);
        expect(bucket!.latencySamples).toBe(2);
    });

    it('rttMs alias is still populated for backward compatibility', async () => {
        const { OllamaProvider } = await import('../src/worker/ollama.ts');
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () =>
            new Response(
                '{"model":"cloud","message":{"role":"assistant","content":"OK"},"done":false}\n',
                { status: 200 },
            );

        const provider = new OllamaProvider(
            { id: 'ollama-free', name: 'Free', base_url: 'https://example.test/api', secret_ref: 'OLLAMA_API_KEY_FREE' },
            'test-key',
        );
        const result = await provider.probe('cloud');

        expect(result.rttMs).toBeGreaterThanOrEqual(0);
        expect(result.ttftMs).toBeGreaterThanOrEqual(0);

        globalThis.fetch = originalFetch;
    });
});

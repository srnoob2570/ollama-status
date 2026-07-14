import { describe, expect, it, beforeEach, beforeAll } from 'vitest';
import { createTestDb, seedModel, seedExpectation } from './helpers/ledger-fixture.ts';
import type { ApiEnv, D1DatabaseLike } from '../src/worker/types.ts';

interface CadenceModel {
    modelId: string;
    modelName: string;
    tier: string;
    nominalExpected: number;
    satisfied: number;
    suppressed: number;
    missed: number;
    nominalCoverage: number;
    policyAdherence: number;
    state: string;
    dominantReason: string | null;
}

interface CadenceResponse {
    window: string;
    evaluatedAt: string;
    models: CadenceModel[];
    summary: {
        totalModels: number;
        degradedCount: number;
        breachedCount: number;
        reasonDistribution: Record<string, number>;
    };
}

function minutesAgo(minutes: number): string {
    return new Date(Date.now() - minutes * 60_000).toISOString();
}

// The api() function calls defaultCache() which references the Workers global `caches`.
// In test environments that global does not exist, so we provide a no-op stub.
beforeAll(() => {
    (globalThis as Record<string, unknown>).caches = {
        default: {
            match: async () => undefined,
            put: async () => {},
        },
    };
});

const { api } = await import('../src/worker/api.ts');

const ctx = {
    waitUntil(promise: Promise<unknown>) {
        void promise;
    },
} as unknown as ExecutionContext;

function makeEnv(db: D1DatabaseLike): ApiEnv {
    return { DB: db } as unknown as ApiEnv;
}

function call(url: string, env: ApiEnv): Promise<Response> {
    const parsed = new URL(`http://localhost${url}`);
    return api(new Request(parsed), env, ctx, parsed.pathname);
}

describe('GET /api/v1/monitor/cadence', () => {
    let db: D1DatabaseLike;

    beforeEach(() => {
        db = createTestDb();
    });

    it('returns 200 with empty models when no data exists', async () => {
        const response = await call('/api/v1/monitor/cadence', makeEnv(db));
        expect(response.status).toBe(200);

        const body = (await response.json()) as CadenceResponse;
        expect(body).toMatchObject({
            window: '1h',
            evaluatedAt: expect.any(String),
            models: [],
            summary: {
                totalModels: 0,
                degradedCount: 0,
                breachedCount: 0,
                reasonDistribution: {},
            },
        });
    });

    it('returns per-model cadence data for active models', async () => {
        await seedModel(db, { id: 'm1', remote_name: 'model-alpha', tier: 'FREE' });
        await seedModel(db, { id: 'm2', remote_name: 'model-beta', tier: 'PAID' });

        // m1: 4 satisfied, 2 missed → 0.67 coverage → DEGRADED
        for (let i = 1; i <= 4; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'SATISFIED',
            });
        }
        for (let i = 1; i <= 2; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5 + 25),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'MISSED',
                reason_code: 'probe_timeout',
            });
        }

        // m2: 6 satisfied, 0 missed → 1.0 coverage → HEALTHY
        for (let i = 1; i <= 6; i++) {
            await seedExpectation(db, {
                model_id: 'm2',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'PAID',
                interval_minutes: 5,
                state: 'SATISFIED',
            });
        }

        const response = await call('/api/v1/monitor/cadence', makeEnv(db));
        expect(response.status).toBe(200);

        const body = (await response.json()) as CadenceResponse;
        expect(body.window).toBe('1h');
        expect(body.models).toHaveLength(2);

        const m1 = body.models.find((m) => m.modelId === 'm1')!;
        expect(m1).toBeDefined();
        expect(m1.modelName).toBe('model-alpha');
        expect(m1.tier).toBe('FREE');
        expect(m1.nominalExpected).toBe(6);
        expect(m1.satisfied).toBe(4);
        expect(m1.suppressed).toBe(0);
        expect(m1.missed).toBe(2);
        expect(m1.nominalCoverage).toBeCloseTo(0.6667, 3);
        expect(m1.policyAdherence).toBeCloseTo(0.6667, 3);
        expect(m1.state).toBe('DEGRADED');
        expect(m1.dominantReason).toBe('probe_timeout');

        const m2 = body.models.find((m) => m.modelId === 'm2')!;
        expect(m2).toBeDefined();
        expect(m2.modelName).toBe('model-beta');
        expect(m2.tier).toBe('PAID');
        expect(m2.nominalExpected).toBe(6);
        expect(m2.satisfied).toBe(6);
        expect(m2.state).toBe('HEALTHY');

        expect(body.summary.totalModels).toBe(2);
        expect(body.summary.degradedCount).toBe(1);
        expect(body.summary.breachedCount).toBe(0);
        expect(body.summary.reasonDistribution).toEqual({ probe_timeout: 1 });
    });

    it('accepts window=24h parameter', async () => {
        await seedModel(db, { id: 'm1', remote_name: 'model-alpha', tier: 'FREE' });
        await seedExpectation(db, {
            model_id: 'm1',
            purpose: 'AVAILABILITY',
            due_at: minutesAgo(60),
            tier: 'FREE',
            interval_minutes: 5,
            state: 'SATISFIED',
        });

        const response = await call('/api/v1/monitor/cadence?window=24h', makeEnv(db));
        expect(response.status).toBe(200);

        const body = (await response.json()) as CadenceResponse;
        expect(body.window).toBe('24h');
    });

    it('defaults to 1h for invalid window values', async () => {
        await seedModel(db, { id: 'm1', remote_name: 'model-alpha', tier: 'FREE' });
        await seedExpectation(db, {
            model_id: 'm1',
            purpose: 'AVAILABILITY',
            due_at: minutesAgo(5),
            tier: 'FREE',
            interval_minutes: 5,
            state: 'SATISFIED',
        });

        const response = await call('/api/v1/monitor/cadence?window=invalid', makeEnv(db));
        expect(response.status).toBe(200);

        const body = (await response.json()) as CadenceResponse;
        expect(body.window).toBe('1h');
    });

    it('returns 404 for unknown path', async () => {
        const response = await call('/api/v1/monitor/cadence/unknown', makeEnv(db));
        expect(response.status).toBe(404);
    });
});

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createTestDb, seedProvider, seedModel, seedExpectation } from './helpers/ledger-fixture.ts';
import type { D1DatabaseLike } from '../src/worker/types.ts';

// Mock the Cache API global that Cloudflare Workers provide but Node does not.
const mockCache = {
    match: vi.fn().mockResolvedValue(undefined),
    put: vi.fn(),
};
vi.stubGlobal('caches', { default: mockCache });

// Pin now() to a fixed timestamp so cadence analysis uses a deterministic window.
vi.mock('../src/worker/types.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/worker/types.ts')>();
    return {
        ...actual,
        now: () => '2026-07-14T12:00:00Z',
    };
});

const { api } = await import('../src/worker/api.ts');

const NOW = '2026-07-14T12:00:00Z';

function minutesAgo(minutes: number): string {
    return new Date(new Date(NOW).getTime() - minutes * 60_000).toISOString();
}

const ctx = {
    waitUntil(promise: Promise<unknown>) {
        void promise;
    },
} as unknown as ExecutionContext;

describe('GET /api/v1/status — cadence block per model', () => {
    let db: D1DatabaseLike;

    beforeEach(async () => {
        db = createTestDb();
        // Seed the ollama-free provider that the status query expects
        await seedProvider(db, { id: 'ollama-free', name: 'Ollama Free' });
    });

    function makeEnv(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
        return {
            DB: db,
            ASSETS: {
                fetch() {
                    return new Response('not found', { status: 404 });
                },
            },
            ...overrides,
        };
    }

    it('includes cadence block with HEALTHY state when all expectations are satisfied', async () => {
        await seedModel(db, { id: 'm1', remote_name: 'test-model-1', tier: 'FREE', provider_id: 'ollama-free' });

        // 12 satisfied expectations in the last hour
        for (let i = 1; i <= 12; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'SATISFIED',
            });
        }

        const response = await api(
            new Request(`http://localhost/api/v1/status`),
            makeEnv() as never,
            ctx,
            '/api/v1/status',
        );

        expect(response.status).toBe(200);
        const body = await response.json() as { models: unknown[] };
        expect(body.models).toHaveLength(1);

        const model = body.models[0] as Record<string, unknown>;
        expect(model).toHaveProperty('cadence');
        expect(model.cadence).not.toBeNull();

        const cadence = model.cadence as Record<string, unknown>;
        expect(cadence).toMatchObject({
            window: '1h',
            nominalExpected: 12,
            satisfied: 12,
            suppressed: 0,
            missed: 0,
            nominalCoverage: 1,
            policyAdherence: 1,
            state: 'HEALTHY',
            dominantReason: null,
        });
        expect(cadence).toHaveProperty('evaluatedAt');
        expect(typeof cadence.evaluatedAt).toBe('string');
    });

    it('includes cadence block with DEGRADED state when coverage is below target', async () => {
        await seedModel(db, { id: 'm2', remote_name: 'test-model-2', tier: 'FREE', provider_id: 'ollama-free' });

        // 8 satisfied, 4 missed → 0.67 coverage (DEGRADED)
        for (let i = 1; i <= 8; i++) {
            await seedExpectation(db, {
                model_id: 'm2',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'SATISFIED',
            });
        }
        for (let i = 9; i <= 12; i++) {
            await seedExpectation(db, {
                model_id: 'm2',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'MISSED',
                reason_code: 'network_error',
            });
        }

        const response = await api(
            new Request(`http://localhost/api/v1/status`),
            makeEnv() as never,
            ctx,
            '/api/v1/status',
        );

        expect(response.status).toBe(200);
        const body = await response.json() as { models: unknown[] };
        const model = body.models[0] as Record<string, unknown>;
        const cadence = model.cadence as Record<string, unknown>;

        expect(cadence.nominalExpected).toBe(12);
        expect(cadence.satisfied).toBe(8);
        expect(cadence.missed).toBe(4);
        expect(cadence.nominalCoverage).toBeCloseTo(0.6667, 3);
        expect(cadence.state).toBe('DEGRADED');
        expect(cadence.dominantReason).toBe('network_error');
    });

    it('includes cadence block with INSUFFICIENT_DATA when no expectations exist', async () => {
        await seedModel(db, { id: 'm3', remote_name: 'test-model-3', tier: 'FREE', provider_id: 'ollama-free' });

        const response = await api(
            new Request(`http://localhost/api/v1/status`),
            makeEnv() as never,
            ctx,
            '/api/v1/status',
        );

        expect(response.status).toBe(200);
        const body = await response.json() as { models: unknown[] };
        const model = body.models[0] as Record<string, unknown>;
        const cadence = model.cadence as Record<string, unknown>;

        expect(cadence.nominalExpected).toBe(0);
        expect(cadence.state).toBe('INSUFFICIENT_DATA');
        expect(cadence.dominantReason).toBeNull();
    });

    it('includes cadence block per model when multiple models exist', async () => {
        await seedModel(db, { id: 'm4', remote_name: 'healthy-model', tier: 'FREE', provider_id: 'ollama-free' });
        await seedModel(db, { id: 'm5', remote_name: 'degraded-model', tier: 'FREE', provider_id: 'ollama-free' });

        // m4: all satisfied
        for (let i = 1; i <= 6; i++) {
            await seedExpectation(db, {
                model_id: 'm4',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 10),
                tier: 'FREE',
                interval_minutes: 10,
                state: 'SATISFIED',
            });
        }

        // m5: 3 satisfied, 3 missed
        for (let i = 1; i <= 3; i++) {
            await seedExpectation(db, {
                model_id: 'm5',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 10),
                tier: 'FREE',
                interval_minutes: 10,
                state: 'SATISFIED',
            });
        }
        for (let i = 4; i <= 6; i++) {
            await seedExpectation(db, {
                model_id: 'm5',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 10),
                tier: 'FREE',
                interval_minutes: 10,
                state: 'MISSED',
                reason_code: 'timeout_before_headers',
            });
        }

        const response = await api(
            new Request(`http://localhost/api/v1/status`),
            makeEnv() as never,
            ctx,
            '/api/v1/status',
        );

        expect(response.status).toBe(200);
        const body = await response.json() as { models: unknown[] };
        expect(body.models).toHaveLength(2);

        const m4 = body.models.find((m: unknown) => (m as Record<string, unknown>).id === 'm4') as Record<string, unknown>;
        const m5 = body.models.find((m: unknown) => (m as Record<string, unknown>).id === 'm5') as Record<string, unknown>;

        expect(m4).toBeDefined();
        expect(m5).toBeDefined();

        const c4 = m4.cadence as Record<string, unknown>;
        const c5 = m5.cadence as Record<string, unknown>;

        expect(c4.state).toBe('HEALTHY');
        expect(c4.nominalExpected).toBe(6);
        expect(c4.satisfied).toBe(6);

        expect(c5.state).toBe('DEGRADED');
        expect(c5.nominalExpected).toBe(6);
        expect(c5.satisfied).toBe(3);
        expect(c5.missed).toBe(3);
        expect(c5.dominantReason).toBe('timeout_before_headers');
    });

    it('does not expose sensitive fields in cadence block', async () => {
        await seedModel(db, { id: 'm6', remote_name: 'test-model-6', tier: 'FREE', provider_id: 'ollama-free' });

        for (let i = 1; i <= 3; i++) {
            await seedExpectation(db, {
                model_id: 'm6',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 10),
                tier: 'FREE',
                interval_minutes: 10,
                state: 'SATISFIED',
            });
        }

        const response = await api(
            new Request(`http://localhost/api/v1/status`),
            makeEnv() as never,
            ctx,
            '/api/v1/status',
        );

        expect(response.status).toBe(200);
        const body = await response.json() as { models: unknown[] };
        const model = body.models[0] as Record<string, unknown>;
        const cadence = model.cadence as Record<string, unknown>;

        // Must NOT expose these sensitive/internal fields
        expect(cadence).not.toHaveProperty('detail');
        expect(cadence).not.toHaveProperty('credentials');
        expect(cadence).not.toHaveProperty('nodeId');
        expect(cadence).not.toHaveProperty('errorBody');
    });
});

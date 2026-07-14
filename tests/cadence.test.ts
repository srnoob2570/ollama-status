import { describe, expect, it, beforeEach } from 'vitest';
import { createTestDb, seedModel, seedExpectation } from './helpers/ledger-fixture.ts';
import { analyzeCadence } from '../src/worker/cadence.ts';
import type { D1DatabaseLike } from '../src/worker/types.ts';

const NOW = '2026-07-14T12:00:00Z';

function minutesAgo(minutes: number): string {
    return new Date(new Date(NOW).getTime() - minutes * 60_000).toISOString();
}

function minutesFromNow(minutes: number): string {
    return new Date(new Date(NOW).getTime() + minutes * 60_000).toISOString();
}

describe('analyzeCadence', () => {
    let db: D1DatabaseLike;

    beforeEach(() => {
        db = createTestDb();
    });

    // ── Basic scenarios ──────────────────────────────────────────────────────

    it('returns INSUFFICIENT_DATA when no expectations exist in window', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

        const result = await analyzeCadence(db, 'm1', '1h', { nowIso: NOW });

        expect(result.nominalExpected).toBe(0);
        expect(result.satisfied).toBe(0);
        expect(result.suppressed).toBe(0);
        expect(result.missed).toBe(0);
        expect(result.cancelled).toBe(0);
        expect(result.nominalCoverage).toBe(0);
        expect(result.policyAdherence).toBe(0);
        expect(result.state).toBe('INSUFFICIENT_DATA');
        expect(result.dominantReason).toBeNull();
    });

    it('returns HEALTHY when all slots are SATISFIED', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

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

        const result = await analyzeCadence(db, 'm1', '1h', { nowIso: NOW });

        expect(result.nominalExpected).toBe(12);
        expect(result.satisfied).toBe(12);
        expect(result.suppressed).toBe(0);
        expect(result.missed).toBe(0);
        expect(result.cancelled).toBe(0);
        expect(result.nominalCoverage).toBe(1);
        expect(result.policyAdherence).toBe(1);
        expect(result.state).toBe('HEALTHY');
        expect(result.dominantReason).toBeNull();
    });

    it('returns DEGRADED when coverage is between 0.5 and target', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

        // 8 satisfied, 4 missed → 0.67 coverage
        for (let i = 1; i <= 8; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'SATISFIED',
            });
        }
        for (let i = 9; i <= 12; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'MISSED',
            });
        }

        const result = await analyzeCadence(db, 'm1', '1h', { nowIso: NOW });

        expect(result.nominalExpected).toBe(12);
        expect(result.satisfied).toBe(8);
        expect(result.missed).toBe(4);
        expect(result.nominalCoverage).toBe(0.6667);
        expect(result.state).toBe('DEGRADED');
    });

    it('returns BREACHED when coverage is below 0.5', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

        // 3 satisfied, 9 missed → 0.25 coverage
        for (let i = 1; i <= 3; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'SATISFIED',
            });
        }
        for (let i = 4; i <= 12; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'MISSED',
            });
        }

        const result = await analyzeCadence(db, 'm1', '1h', { nowIso: NOW });

        expect(result.nominalExpected).toBe(12);
        expect(result.satisfied).toBe(3);
        expect(result.missed).toBe(9);
        expect(result.nominalCoverage).toBe(3 / 12);
        expect(result.state).toBe('BREACHED');
    });

    // ── CANCELLED exclusion ──────────────────────────────────────────────────

    it('excludes CANCELLED from nominalExpected denominator', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

        // 6 satisfied, 6 cancelled → denominator = 6, coverage = 1.0
        for (let i = 1; i <= 6; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'SATISFIED',
            });
        }
        for (let i = 7; i <= 12; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'CANCELLED',
            });
        }

        const result = await analyzeCadence(db, 'm1', '1h', { nowIso: NOW });

        expect(result.nominalExpected).toBe(6);
        expect(result.satisfied).toBe(6);
        expect(result.cancelled).toBe(6);
        expect(result.nominalCoverage).toBe(1);
        expect(result.state).toBe('HEALTHY');
    });

    // ── SUPPRESSED vs policyAdherence ────────────────────────────────────────

    it('separates nominalCoverage from policyAdherence with SUPPRESSED slots', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

        // 6 satisfied, 3 suppressed, 3 missed
        for (let i = 1; i <= 6; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'SATISFIED',
            });
        }
        for (let i = 7; i <= 9; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'SUPPRESSED',
            });
        }
        for (let i = 10; i <= 12; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'MISSED',
            });
        }

        const result = await analyzeCadence(db, 'm1', '1h', { nowIso: NOW });

        expect(result.nominalExpected).toBe(12);
        expect(result.satisfied).toBe(6);
        expect(result.suppressed).toBe(3);
        expect(result.missed).toBe(3);
        expect(result.nominalCoverage).toBe(0.5); // 6/12
        expect(result.policyAdherence).toBe(0.75); // 9/12
        expect(result.state).toBe('DEGRADED');
    });

    // ── Dominant reason ──────────────────────────────────────────────────────

    it('reports dominant reason from non-satisfied slots', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

        // 6 satisfied, 4 missed with timeout, 2 suppressed with rate_limit
        for (let i = 1; i <= 6; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'SATISFIED',
            });
        }
        for (let i = 7; i <= 10; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'MISSED',
            });
            // Set reason_code via raw SQL since seedExpectation doesn't expose it
            await db
                .prepare(
                    `UPDATE model_check_expectations SET reason_code = 'timeout_before_headers' WHERE model_id = ? AND due_at = ?`,
                )
                .bind('m1', minutesAgo(i * 5))
                .run();
        }
        for (let i = 11; i <= 12; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'SUPPRESSED',
            });
            await db
                .prepare(
                    `UPDATE model_check_expectations SET reason_code = 'credential_rate_limited' WHERE model_id = ? AND due_at = ?`,
                )
                .bind('m1', minutesAgo(i * 5))
                .run();
        }

        const result = await analyzeCadence(db, 'm1', '1h', { nowIso: NOW });

        expect(result.dominantReason).toBe('timeout_before_headers');
    });

    it('treats UNATTRIBUTED as instrumentation defect and still reports it', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

        for (let i = 1; i <= 6; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'MISSED',
            });
            await db
                .prepare(
                    `UPDATE model_check_expectations SET reason_code = 'unattributed' WHERE model_id = ? AND due_at = ?`,
                )
                .bind('m1', minutesAgo(i * 5))
                .run();
        }

        const result = await analyzeCadence(db, 'm1', '1h', { nowIso: NOW });

        expect(result.dominantReason).toBe('unattributed');
        expect(result.state).toBe('BREACHED');
    });

    // ── PAID model: one slot per purpose ─────────────────────────────────────

    it('counts PAID model AVAILABILITY + ENTITLEMENT as separate slots, not double', async () => {
        await seedModel(db, { id: 'm1', tier: 'PAID' });

        // 6 AVAILABILITY satisfied, 6 ENTITLEMENT satisfied → 12 slots
        for (let i = 1; i <= 6; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 10),
                tier: 'PAID',
                interval_minutes: 10,
                state: 'SATISFIED',
            });
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'ENTITLEMENT',
                due_at: minutesAgo(i * 10),
                tier: 'PAID',
                interval_minutes: 10,
                state: 'SATISFIED',
            });
        }

        const result = await analyzeCadence(db, 'm1', '1h', { nowIso: NOW });

        expect(result.nominalExpected).toBe(12);
        expect(result.satisfied).toBe(12);
        expect(result.nominalCoverage).toBe(1);
        expect(result.state).toBe('HEALTHY');
    });

    // ── Duration windows ─────────────────────────────────────────────────────

    it('accepts 24h duration window', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

        // 24h at 5min interval = 288 slots, seed a few
        for (let i = 1; i <= 100; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: new Date(new Date(NOW).getTime() - i * 5 * 60_000).toISOString(),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'SATISFIED',
            });
        }

        const result = await analyzeCadence(db, 'm1', '24h', { nowIso: NOW });

        expect(result.nominalExpected).toBe(100);
        expect(result.satisfied).toBe(100);
        expect(result.state).toBe('HEALTHY');
    });

    it('accepts 7d duration window', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

        for (let i = 1; i <= 50; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: new Date(new Date(NOW).getTime() - i * 5 * 60_000).toISOString(),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'SATISFIED',
            });
        }

        const result = await analyzeCadence(db, 'm1', '7d', { nowIso: NOW });

        expect(result.nominalExpected).toBe(50);
        expect(result.satisfied).toBe(50);
        expect(result.state).toBe('HEALTHY');
    });

    it('accepts ISO range window', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

        const from = '2026-07-14T11:00:00Z';
        const to = '2026-07-14T12:00:00Z';

        for (let i = 1; i <= 6; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: new Date(new Date(from).getTime() + i * 5 * 60_000).toISOString(),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'SATISFIED',
            });
        }

        const result = await analyzeCadence(db, 'm1', `${from}/${to}`, { nowIso: NOW });

        expect(result.nominalExpected).toBe(6);
        expect(result.satisfied).toBe(6);
        expect(result.state).toBe('HEALTHY');
    });

    // ── Custom target ─────────────────────────────────────────────────────────

    it('respects custom target threshold', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

        // 8 satisfied, 4 missed → 0.67 coverage
        for (let i = 1; i <= 8; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'SATISFIED',
            });
        }
        for (let i = 9; i <= 12; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'MISSED',
            });
        }

        // With target 0.95 → DEGRADED (0.67 < 0.95)
        const strict = await analyzeCadence(db, 'm1', '1h', { nowIso: NOW, target: 0.95 });
        expect(strict.state).toBe('DEGRADED');

        // With target 0.60 → HEALTHY (0.67 >= 0.60)
        const loose = await analyzeCadence(db, 'm1', '1h', { nowIso: NOW, target: 0.6 });
        expect(loose.state).toBe('HEALTHY');
    });

    // ── Unresolved slots drag down coverage ───────────────────────────────────

    it('counts unresolved EXPECTED slots in nominalExpected, dragging coverage down', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

        // 6 satisfied, 6 still EXPECTED (unresolved) → 6/12 = 0.5
        for (let i = 1; i <= 6; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'SATISFIED',
            });
        }
        for (let i = 7; i <= 12; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'EXPECTED',
            });
        }

        const result = await analyzeCadence(db, 'm1', '1h', { nowIso: NOW });

        expect(result.nominalExpected).toBe(12);
        expect(result.satisfied).toBe(6);
        expect(result.nominalCoverage).toBe(0.5);
        expect(result.state).toBe('DEGRADED');
    });

    // ── Error/timeout/degradation observations leave slot SATISFIED ───────────

    it('treats error observations as SATISFIED (cadence measures check occurrence)', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

        // All slots SATISFIED even though the actual checks may have errored
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

        const result = await analyzeCadence(db, 'm1', '1h', { nowIso: NOW });

        expect(result.nominalCoverage).toBe(1);
        expect(result.state).toBe('HEALTHY');
    });

    // ── Edge: future expectations excluded ───────────────────────────────────

    it('excludes future expectations from the window', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

        // 6 satisfied in the past hour, 6 EXPECTED in the future
        for (let i = 1; i <= 6; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesAgo(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'SATISFIED',
            });
        }
        for (let i = 1; i <= 6; i++) {
            await seedExpectation(db, {
                model_id: 'm1',
                purpose: 'AVAILABILITY',
                due_at: minutesFromNow(i * 5),
                tier: 'FREE',
                interval_minutes: 5,
                state: 'EXPECTED',
            });
        }

        const result = await analyzeCadence(db, 'm1', '1h', { nowIso: NOW });

        expect(result.nominalExpected).toBe(6);
        expect(result.satisfied).toBe(6);
        expect(result.nominalCoverage).toBe(1);
        expect(result.state).toBe('HEALTHY');
    });

    // ── Edge: exact boundary ──────────────────────────────────────────────────

    it('includes slots at the lower boundary and excludes at the upper boundary', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

        const from = '2026-07-14T11:00:00Z';
        const to = '2026-07-14T12:00:00Z';

        // Exactly at lower boundary → included
        await seedExpectation(db, {
            model_id: 'm1',
            purpose: 'AVAILABILITY',
            due_at: from,
            tier: 'FREE',
            interval_minutes: 5,
            state: 'SATISFIED',
        });
        // Exactly at upper boundary → excluded (due_at < to)
        await seedExpectation(db, {
            model_id: 'm1',
            purpose: 'AVAILABILITY',
            due_at: to,
            tier: 'FREE',
            interval_minutes: 5,
            state: 'SATISFIED',
        });

        const result = await analyzeCadence(db, 'm1', `${from}/${to}`, { nowIso: NOW });

        expect(result.nominalExpected).toBe(1);
        expect(result.satisfied).toBe(1);
    });

    // ── Edge: invalid window ──────────────────────────────────────────────────

    it('throws on invalid window format', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

        await expect(analyzeCadence(db, 'm1', 'garbage', { nowIso: NOW })).rejects.toThrow(
            'Invalid cadence window',
        );
    });

    // ── evaluatedAt ──────────────────────────────────────────────────────────

    it('records evaluatedAt from nowIso', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

        const result = await analyzeCadence(db, 'm1', '1h', { nowIso: NOW });

        expect(result.evaluatedAt).toBe(NOW);
    });

    // ── modelId and window label ─────────────────────────────────────────────

    it('returns modelId and window label in result', async () => {
        await seedModel(db, { id: 'm1', tier: 'FREE' });

        const result = await analyzeCadence(db, 'm1', '1h', { nowIso: NOW });

        expect(result.modelId).toBe('m1');
        expect(result.window).toBe('1h');
    });
});

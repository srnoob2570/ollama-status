import { describe, expect, it, beforeEach } from 'vitest';
import { createTestDb, seedModel, seedExpectation } from './helpers/ledger-fixture.ts';
import { computeHourlyRollup, upsertHourlyExecutionRollup } from '../src/worker/rollups.ts';
import type { D1DatabaseLike } from '../src/worker/types.ts';

describe('rollups', () => {
    let db: D1DatabaseLike;

    beforeEach(() => {
        db = createTestDb();
    });

    describe('computeHourlyRollup', () => {
        it('returns zeros when no expectations exist', async () => {
            const r = await computeHourlyRollup(db, 'nonexistent', '2026-07-14T10:00:00.000Z', 'AVAILABILITY');
            expect(r.nominalExpected).toBe(0);
            expect(r.satisfied).toBe(0);
            expect(r.suppressed).toBe(0);
            expect(r.missed).toBe(0);
            expect(r.cancelled).toBe(0);
            expect(r.nominalCoverage).toBeNull();
            expect(r.policyAdherence).toBeNull();
            expect(r.dominantReason).toBeNull();
            expect(r.tier).toBe('FREE');
        });

        it('counts all SATISFIED expectations in the hour', async () => {
            const m = await seedModel(db, { id: 'm1', tier: 'FREE' });
            const h = '2026-07-14T10:00:00.000Z';

            for (let i = 0; i < 4; i++) {
                const due = new Date(new Date(h).getTime() + i * 5 * 60_000).toISOString();
                await seedExpectation(db, {
                    model_id: m.id,
                    purpose: 'AVAILABILITY',
                    due_at: due,
                    tier: 'FREE',
                    state: 'SATISFIED',
                });
            }

            const r = await computeHourlyRollup(db, m.id, h, 'AVAILABILITY');
            expect(r.nominalExpected).toBe(4);
            expect(r.satisfied).toBe(4);
            expect(r.suppressed).toBe(0);
            expect(r.missed).toBe(0);
            expect(r.cancelled).toBe(0);
            expect(r.nominalCoverage).toBe(1);
            expect(r.policyAdherence).toBe(1);
            expect(r.dominantReason).toBeNull();
        });

        it('counts mixed states correctly', async () => {
            const m = await seedModel(db, { id: 'm2', tier: 'PAID' });
            const h = '2026-07-14T10:00:00.000Z';

            // 10 total: 4 SATISFIED, 2 SUPPRESSED, 3 MISSED, 1 CANCELLED
            const states: Array<{ state: string; reason?: string }> = [
                { state: 'SATISFIED' },
                { state: 'SATISFIED' },
                { state: 'SATISFIED' },
                { state: 'SATISFIED' },
                { state: 'SUPPRESSED', reason: 'credential_rate_limited' },
                { state: 'SUPPRESSED', reason: 'credential_rate_limited' },
                { state: 'MISSED', reason: 'timeout_before_headers' },
                { state: 'MISSED', reason: 'provider_overloaded' },
                { state: 'MISSED', reason: 'provider_overloaded' },
                { state: 'CANCELLED', reason: 'lease_expired' },
            ];

            for (let i = 0; i < states.length; i++) {
                const due = new Date(new Date(h).getTime() + i * 6 * 60_000).toISOString();
                await seedExpectation(db, {
                    model_id: m.id,
                    purpose: 'AVAILABILITY',
                    due_at: due,
                    tier: 'PAID',
                    state: states[i].state,
                    reason_code: states[i].reason ?? null,
                });
            }

            const r = await computeHourlyRollup(db, m.id, h, 'AVAILABILITY');
            expect(r.nominalExpected).toBe(10);
            expect(r.satisfied).toBe(4);
            expect(r.suppressed).toBe(2);
            expect(r.missed).toBe(3);
            expect(r.cancelled).toBe(1);
            expect(r.nominalCoverage).toBe(0.4);
            expect(r.policyAdherence).toBe(0.6);
            expect(r.dominantReason).toBe('provider_overloaded');
            expect(r.tier).toBe('PAID');
        });

        it('only counts expectations within the exact hour boundary', async () => {
            const m = await seedModel(db, { id: 'm3', tier: 'FREE' });
            const h = '2026-07-14T10:00:00.000Z';

            // One at 09:59 (before hour), one at 10:00 (in hour), one at 10:59 (in hour), one at 11:00 (after hour)
            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T09:59:00.000Z',
                tier: 'FREE',
                state: 'SATISFIED',
            });
            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T10:00:00.000Z',
                tier: 'FREE',
                state: 'SATISFIED',
            });
            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T10:59:00.000Z',
                tier: 'FREE',
                state: 'MISSED',
            });
            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T11:00:00.000Z',
                tier: 'FREE',
                state: 'SATISFIED',
            });

            const r = await computeHourlyRollup(db, m.id, h, 'AVAILABILITY');
            expect(r.nominalExpected).toBe(2);
            expect(r.satisfied).toBe(1);
            expect(r.missed).toBe(1);
        });

        it('isolates by purpose', async () => {
            const m = await seedModel(db, { id: 'm4', tier: 'PAID' });
            const h = '2026-07-14T10:00:00.000Z';

            // 3 AVAILABILITY + 2 ENTITLEMENT
            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T10:00:00.000Z',
                tier: 'PAID',
                state: 'SATISFIED',
            });
            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T10:10:00.000Z',
                tier: 'PAID',
                state: 'MISSED',
            });
            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T10:20:00.000Z',
                tier: 'PAID',
                state: 'SATISFIED',
            });
            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'ENTITLEMENT',
                due_at: '2026-07-14T10:00:00.000Z',
                tier: 'PAID',
                state: 'SATISFIED',
            });
            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'ENTITLEMENT',
                due_at: '2026-07-14T10:10:00.000Z',
                tier: 'PAID',
                state: 'SUPPRESSED',
            });

            const avail = await computeHourlyRollup(db, m.id, h, 'AVAILABILITY');
            expect(avail.nominalExpected).toBe(3);
            expect(avail.satisfied).toBe(2);
            expect(avail.missed).toBe(1);

            const ent = await computeHourlyRollup(db, m.id, h, 'ENTITLEMENT');
            expect(ent.nominalExpected).toBe(2);
            expect(ent.satisfied).toBe(1);
            expect(ent.suppressed).toBe(1);
        });

        it('dominantReason is null when all expectations are SATISFIED', async () => {
            const m = await seedModel(db, { id: 'm5', tier: 'FREE' });
            const h = '2026-07-14T10:00:00.000Z';

            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T10:00:00.000Z',
                tier: 'FREE',
                state: 'SATISFIED',
            });
            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T10:05:00.000Z',
                tier: 'FREE',
                state: 'SATISFIED',
            });

            const r = await computeHourlyRollup(db, m.id, h, 'AVAILABILITY');
            expect(r.dominantReason).toBeNull();
        });

        it('dominantReason picks the most frequent reason among non-satisfied', async () => {
            const m = await seedModel(db, { id: 'm6', tier: 'FREE' });
            const h = '2026-07-14T10:00:00.000Z';

            // 3 MISSED with reason_a, 2 MISSED with reason_b, 1 CANCELLED with reason_c
            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T10:00:00.000Z',
                tier: 'FREE',
                state: 'MISSED',
                reason_code: 'reason_a',
            });
            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T10:05:00.000Z',
                tier: 'FREE',
                state: 'MISSED',
                reason_code: 'reason_a',
            });
            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T10:10:00.000Z',
                tier: 'FREE',
                state: 'MISSED',
                reason_code: 'reason_a',
            });
            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T10:15:00.000Z',
                tier: 'FREE',
                state: 'MISSED',
                reason_code: 'reason_b',
            });
            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T10:20:00.000Z',
                tier: 'FREE',
                state: 'MISSED',
                reason_code: 'reason_b',
            });
            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T10:25:00.000Z',
                tier: 'FREE',
                state: 'CANCELLED',
                reason_code: 'reason_c',
            });

            const r = await computeHourlyRollup(db, m.id, h, 'AVAILABILITY');
            expect(r.dominantReason).toBe('reason_a');
        });
    });

    describe('upsertHourlyExecutionRollup', () => {
        it('persists a rollup row and returns it', async () => {
            const m = await seedModel(db, { id: 'm7', tier: 'FREE' });
            const h = '2026-07-14T10:00:00.000Z';

            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T10:00:00.000Z',
                tier: 'FREE',
                state: 'SATISFIED',
            });

            const r = await upsertHourlyExecutionRollup(db, m.id, h, 'AVAILABILITY');

            expect(r.nominalExpected).toBe(1);
            expect(r.satisfied).toBe(1);

            // Verify it was persisted
            const row = await db
                .prepare(
                    'SELECT * FROM hourly_execution_rollups WHERE model_id = ? AND hour_at = ? AND purpose = ?',
                )
                .bind(m.id, h, 'AVAILABILITY')
                .first<Record<string, unknown>>();
            expect(row).not.toBeNull();
            expect(row!.nominal_expected).toBe(1);
            expect(row!.satisfied).toBe(1);
        });

        it('is idempotent — re-computing same hour produces same result', async () => {
            const m = await seedModel(db, { id: 'm8', tier: 'FREE' });
            const h = '2026-07-14T10:00:00.000Z';

            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T10:00:00.000Z',
                tier: 'FREE',
                state: 'SATISFIED',
            });

            const r1 = await upsertHourlyExecutionRollup(db, m.id, h, 'AVAILABILITY');
            const r2 = await upsertHourlyExecutionRollup(db, m.id, h, 'AVAILABILITY');

            expect(r1).toEqual(r2);

            // Only one row in the table
            const rows = await db
                .prepare(
                    'SELECT COUNT(*) as c FROM hourly_execution_rollups WHERE model_id = ? AND hour_at = ? AND purpose = ?',
                )
                .bind(m.id, h, 'AVAILABILITY')
                .first<{ c: number }>();
            expect(rows?.c).toBe(1);
        });

        it('updates when expectations change between calls', async () => {
            const m = await seedModel(db, { id: 'm9', tier: 'FREE' });
            const h = '2026-07-14T10:00:00.000Z';

            // First call: 1 SATISFIED
            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T10:00:00.000Z',
                tier: 'FREE',
                state: 'SATISFIED',
            });

            const r1 = await upsertHourlyExecutionRollup(db, m.id, h, 'AVAILABILITY');
            expect(r1.nominalExpected).toBe(1);
            expect(r1.satisfied).toBe(1);

            // Add another expectation and re-compute
            await seedExpectation(db, {
                model_id: m.id,
                purpose: 'AVAILABILITY',
                due_at: '2026-07-14T10:05:00.000Z',
                tier: 'FREE',
                state: 'MISSED',
            });

            const r2 = await upsertHourlyExecutionRollup(db, m.id, h, 'AVAILABILITY');
            expect(r2.nominalExpected).toBe(2);
            expect(r2.satisfied).toBe(1);
            expect(r2.missed).toBe(1);
        });
    });
});

import { describe, expect, it, beforeEach } from 'vitest';
import { createTestDb, seedProvider, seedModel } from './helpers/ledger-fixture.ts';
import {
    materializeExpectations,
    getWatermark,
    setWatermark,
    cancelExpectationsForPolicyChange,
    reconcilePaidAvailability,
} from '../src/worker/expectations.ts';
import type { D1DatabaseLike } from '../src/worker/types.ts';

function makeNow(): string {
    return new Date('2026-07-13T12:00:00Z').toISOString();
}

function minutesFromNow(minutes: number): string {
    return new Date(new Date('2026-07-13T12:00:00Z').getTime() + minutes * 60_000).toISOString();
}

describe('expectations', () => {
    let db: D1DatabaseLike;

    beforeEach(() => {
        db = createTestDb();
    });

    describe('getWatermark / setWatermark', () => {
        it('returns null when no watermark exists', async () => {
            const w = await getWatermark(db, 'v1');
            expect(w).toBeNull();
        });

        it('persists and retrieves a watermark', async () => {
            await setWatermark(db, 'v1', '2026-07-13T12:00:00Z');
            const w = await getWatermark(db, 'v1');
            expect(w).toBe('2026-07-13T12:00:00Z');
        });

        it('updates an existing watermark', async () => {
            await setWatermark(db, 'v1', '2026-07-13T12:00:00Z');
            await setWatermark(db, 'v1', '2026-07-13T13:00:00Z');
            const w = await getWatermark(db, 'v1');
            expect(w).toBe('2026-07-13T13:00:00Z');
        });

        it('isolates watermarks by policy version', async () => {
            await setWatermark(db, 'v1', '2026-07-13T12:00:00Z');
            await setWatermark(db, 'v2', '2026-07-13T14:00:00Z');
            expect(await getWatermark(db, 'v1')).toBe('2026-07-13T12:00:00Z');
            expect(await getWatermark(db, 'v2')).toBe('2026-07-13T14:00:00Z');
        });
    });

    describe('materializeExpectations', () => {
        it('generates 12 slots for a FREE model at 5min interval over 60min horizon', async () => {
            await seedModel(db, { id: 'm1', tier: 'FREE' });
            const count = await materializeExpectations(db, {
                policyVersion: 'v1',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });
            expect(count).toBe(12);

            const rows = await db
                .prepare(
                    'SELECT * FROM model_check_expectations WHERE model_id = ? ORDER BY due_at',
                )
                .bind('m1')
                .all<Record<string, unknown>>();
            expect(rows.results.length).toBe(12);
            for (const r of rows.results) {
                expect(r.purpose).toBe('AVAILABILITY');
                expect(r.tier).toBe('FREE');
                expect(r.interval_minutes).toBe(5);
                expect(r.state).toBe('EXPECTED');
                expect(r.policy_version).toBe('v1');
            }
        });

        it('generates 6 AVAILABILITY + 6 ENTITLEMENT slots for a PAID model at 10min over 60min', async () => {
            await seedModel(db, { id: 'm2', tier: 'PAID' });
            const count = await materializeExpectations(db, {
                policyVersion: 'v1',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });
            expect(count).toBe(12);

            const avail = await db
                .prepare(
                    'SELECT COUNT(*) as c FROM model_check_expectations WHERE model_id = ? AND purpose = ?',
                )
                .bind('m2', 'AVAILABILITY')
                .first<{ c: number }>();
            expect(avail?.c).toBe(6);

            const ent = await db
                .prepare(
                    'SELECT COUNT(*) as c FROM model_check_expectations WHERE model_id = ? AND purpose = ?',
                )
                .bind('m2', 'ENTITLEMENT')
                .first<{ c: number }>();
            expect(ent?.c).toBe(6);
        });

        it('handles >40 models', async () => {
            for (let i = 0; i < 50; i++) {
                await seedModel(db, { id: `m${i}`, tier: i % 2 === 0 ? 'FREE' : 'PAID' });
            }
            const count = await materializeExpectations(db, {
                policyVersion: 'v1',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });
            expect(count).toBeGreaterThan(0);

            const modelCount = await db
                .prepare('SELECT COUNT(DISTINCT model_id) as c FROM model_check_expectations')
                .first<{ c: number }>();
            expect(modelCount?.c).toBe(50);
        });

        it('is idempotent on repeated calls', async () => {
            await seedModel(db, { id: 'm1', tier: 'FREE' });
            const c1 = await materializeExpectations(db, {
                policyVersion: 'v1',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });
            await materializeExpectations(db, {
                policyVersion: 'v1',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });
            expect(c1).toBeGreaterThan(0);

            const rows = await db
                .prepare('SELECT COUNT(*) as c FROM model_check_expectations')
                .first<{ c: number }>();
            expect(rows?.c).toBe(c1);
        });

        it('backfills from watermark after a gap', async () => {
            await seedModel(db, { id: 'm1', tier: 'FREE' });

            await materializeExpectations(db, {
                policyVersion: 'v1',
                nowIso: makeNow(),
                horizonMinutes: 30,
            });

            const futureNow = minutesFromNow(60);
            await materializeExpectations(db, {
                policyVersion: 'v1',
                nowIso: futureNow,
                horizonMinutes: 30,
            });

            const rows = await db
                .prepare(
                    'SELECT due_at FROM model_check_expectations WHERE model_id = ? ORDER BY due_at',
                )
                .bind('m1')
                .all<{ due_at: string }>();

            const firstDue = new Date(rows.results[0].due_at).getTime();
            const lastDue = new Date(rows.results[rows.results.length - 1].due_at).getTime();
            const futureMs = new Date(futureNow).getTime();

            expect(firstDue).toBe(new Date(makeNow()).getTime());
            expect(lastDue).toBeGreaterThanOrEqual(futureMs);
        });

        it('respects cutoverAt — no slots before cutover', async () => {
            await seedModel(db, { id: 'm1', tier: 'FREE' });
            const cutover = minutesFromNow(30);

            await materializeExpectations(db, {
                policyVersion: 'v1',
                nowIso: makeNow(),
                horizonMinutes: 60,
                cutoverAt: cutover,
            });

            const rows = await db
                .prepare(
                    'SELECT due_at FROM model_check_expectations WHERE model_id = ? ORDER BY due_at',
                )
                .bind('m1')
                .all<{ due_at: string }>();

            for (const r of rows.results) {
                expect(new Date(r.due_at).getTime()).toBeGreaterThanOrEqual(
                    new Date(cutover).getTime(),
                );
            }
        });

        it('suppresses slots inside cooldown windows', async () => {
            const provider = await seedProvider(db);
            await seedModel(db, { id: 'm1', tier: 'FREE', provider_id: provider.id });

            const cooldownUntil = minutesFromNow(20);
            await db
                .prepare(
                    `INSERT INTO provider_model_status
                     (provider_id, model_id, public_status, classification, next_check_at, updated_at)
                     VALUES (?, ?, 'RATE_LIMITED', 'RATE_LIMITED', ?, ?)`,
                )
                .bind(provider.id, 'm1', cooldownUntil, makeNow())
                .run();

            await materializeExpectations(db, {
                policyVersion: 'v1',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });

            const suppressed = await db
                .prepare(
                    `SELECT due_at, state, reason_code
                     FROM model_check_expectations
                     WHERE model_id = ? AND state = 'SUPPRESSED'
                     ORDER BY due_at`,
                )
                .bind('m1')
                .all<{ due_at: string; state: string; reason_code: string }>();

            expect(suppressed.results.length).toBeGreaterThan(0);
            for (const r of suppressed.results) {
                expect(new Date(r.due_at).getTime()).toBeLessThan(
                    new Date(cooldownUntil).getTime(),
                );
                expect(r.reason_code).toBe('credential_rate_limited');
            }

            const expected = await db
                .prepare(
                    `SELECT due_at, state FROM model_check_expectations
                     WHERE model_id = ? AND state = 'EXPECTED'
                     ORDER BY due_at`,
                )
                .bind('m1')
                .all<{ due_at: string }>();

            for (const r of expected.results) {
                expect(new Date(r.due_at).getTime()).toBeGreaterThanOrEqual(
                    new Date(cooldownUntil).getTime(),
                );
            }
        });

        it('handles AUTHENTICATION cooldown with credential_auth_failed reason', async () => {
            const provider = await seedProvider(db);
            await seedModel(db, { id: 'm1', tier: 'FREE', provider_id: provider.id });

            const cooldownUntil = minutesFromNow(15);
            await db
                .prepare(
                    `INSERT INTO provider_model_status
                     (provider_id, model_id, public_status, classification, next_check_at, updated_at)
                     VALUES (?, ?, 'AUTHENTICATION', 'AUTH_ERROR', ?, ?)`,
                )
                .bind(provider.id, 'm1', cooldownUntil, makeNow())
                .run();

            await materializeExpectations(db, {
                policyVersion: 'v1',
                nowIso: makeNow(),
                horizonMinutes: 30,
            });

            const suppressed = await db
                .prepare(
                    `SELECT reason_code FROM model_check_expectations
                     WHERE model_id = ? AND state = 'SUPPRESSED'`,
                )
                .bind('m1')
                .all<{ reason_code: string }>();

            for (const r of suppressed.results) {
                expect(r.reason_code).toBe('credential_auth_failed');
            }
        });

        it('suppresses PAID model slots up front when paidAvailable is false', async () => {
            await seedModel(db, { id: 'm1', tier: 'FREE' });
            await seedModel(db, { id: 'm2', tier: 'PAID' });

            await materializeExpectations(db, {
                policyVersion: 'v1',
                nowIso: makeNow(),
                horizonMinutes: 60,
                paidAvailable: false,
            });

            const free = await db
                .prepare(`SELECT state FROM model_check_expectations WHERE model_id = ?`)
                .bind('m1')
                .all<{ state: string }>();
            expect(free.results.length).toBeGreaterThan(0);
            for (const r of free.results) expect(r.state).toBe('EXPECTED');

            const paid = await db
                .prepare(`SELECT state, reason_code FROM model_check_expectations WHERE model_id = ?`)
                .bind('m2')
                .all<{ state: string; reason_code: string }>();
            expect(paid.results.length).toBeGreaterThan(0);
            for (const r of paid.results) {
                expect(r.state).toBe('SUPPRESSED');
                expect(r.reason_code).toBe('paid_key_not_configured');
            }
        });
    });

    describe('reconcilePaidAvailability', () => {
        it('suppresses pending PAID expectations when the key is unavailable', async () => {
            await seedModel(db, { id: 'm1', tier: 'PAID' });
            await materializeExpectations(db, {
                policyVersion: 'v1',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });

            await reconcilePaidAvailability(db, false);

            const rows = await db
                .prepare(`SELECT state, reason_code FROM model_check_expectations WHERE model_id = ?`)
                .bind('m1')
                .all<{ state: string; reason_code: string }>();
            expect(rows.results.length).toBeGreaterThan(0);
            for (const r of rows.results) {
                expect(r.state).toBe('SUPPRESSED');
                expect(r.reason_code).toBe('paid_key_not_configured');
            }
        });

        it('does not touch FREE model expectations', async () => {
            await seedModel(db, { id: 'm1', tier: 'FREE' });
            await materializeExpectations(db, {
                policyVersion: 'v1',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });

            await reconcilePaidAvailability(db, false);

            const rows = await db
                .prepare(`SELECT state FROM model_check_expectations WHERE model_id = ?`)
                .bind('m1')
                .all<{ state: string }>();
            for (const r of rows.results) expect(r.state).toBe('EXPECTED');
        });

        it('resumes suppressed PAID expectations once the key is available again', async () => {
            await seedModel(db, { id: 'm1', tier: 'PAID' });
            await materializeExpectations(db, {
                policyVersion: 'v1',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });
            await reconcilePaidAvailability(db, false);

            await reconcilePaidAvailability(db, true);

            const rows = await db
                .prepare(`SELECT state, reason_code FROM model_check_expectations WHERE model_id = ?`)
                .bind('m1')
                .all<{ state: string; reason_code: string | null }>();
            expect(rows.results.length).toBeGreaterThan(0);
            for (const r of rows.results) {
                expect(r.state).toBe('EXPECTED');
                expect(r.reason_code).toBeNull();
            }
        });

        it('leaves non-paid-key suppressions alone when the key becomes available', async () => {
            const provider = await seedProvider(db);
            await seedModel(db, { id: 'm1', tier: 'FREE', provider_id: provider.id });

            const cooldownUntil = minutesFromNow(20);
            await db
                .prepare(
                    `INSERT INTO provider_model_status
                     (provider_id, model_id, public_status, classification, next_check_at, updated_at)
                     VALUES (?, ?, 'RATE_LIMITED', 'RATE_LIMITED', ?, ?)`,
                )
                .bind(provider.id, 'm1', cooldownUntil, makeNow())
                .run();

            await materializeExpectations(db, {
                policyVersion: 'v1',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });

            await reconcilePaidAvailability(db, true);

            const suppressed = await db
                .prepare(
                    `SELECT reason_code FROM model_check_expectations
                     WHERE model_id = ? AND state = 'SUPPRESSED'`,
                )
                .bind('m1')
                .all<{ reason_code: string }>();
            expect(suppressed.results.length).toBeGreaterThan(0);
            for (const r of suppressed.results) expect(r.reason_code).toBe('credential_rate_limited');
        });
    });

    describe('cancelExpectationsForPolicyChange', () => {
        it('cancels future EXPECTED/SCHEDULED expectations under old policy', async () => {
            await seedModel(db, { id: 'm1', tier: 'FREE' });

            await materializeExpectations(db, {
                policyVersion: 'v1',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });

            const beforeCount = await db
                .prepare('SELECT COUNT(*) as c FROM model_check_expectations')
                .first<{ c: number }>();

            const cancelled = await cancelExpectationsForPolicyChange(db, 'v1', 'v2', makeNow());
            expect(cancelled).toBeGreaterThan(0);

            const afterCount = await db
                .prepare('SELECT COUNT(*) as c FROM model_check_expectations')
                .first<{ c: number }>();
            expect(afterCount?.c).toBe(beforeCount?.c ?? 0);

            const cancelledRows = await db
                .prepare(
                    `SELECT state, reason_code, resolved_at
                     FROM model_check_expectations
                     WHERE policy_version = 'v1' AND state = 'CANCELLED'`,
                )
                .all<{ state: string; reason_code: string; resolved_at: string }>();
            expect(cancelledRows.results.length).toBe(cancelled);
            for (const r of cancelledRows.results) {
                expect(r.reason_code).toBe('policy_change');
                expect(r.resolved_at).toBe(makeNow());
            }

            const remaining = await db
                .prepare(
                    `SELECT state FROM model_check_expectations
                     WHERE policy_version = 'v1' AND state IN ('EXPECTED', 'SCHEDULED')`,
                )
                .all();
            expect(remaining.results.length).toBe(0);
        });

        it('does not touch already closed expectations', async () => {
            await seedModel(db, { id: 'm1', tier: 'FREE' });

            await materializeExpectations(db, {
                policyVersion: 'v1',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });

            await db
                .prepare(
                    `UPDATE model_check_expectations
                     SET state = 'SATISFIED', resolved_at = ?
                     WHERE model_id = ? AND due_at = (SELECT MIN(due_at) FROM model_check_expectations WHERE model_id = ?)`,
                )
                .bind(makeNow(), 'm1', 'm1')
                .run();

            await cancelExpectationsForPolicyChange(db, 'v1', 'v2', makeNow());

            const satisfied = await db
                .prepare(
                    `SELECT COUNT(*) as c FROM model_check_expectations
                     WHERE model_id = ? AND state = 'SATISFIED'`,
                )
                .bind('m1')
                .first<{ c: number }>();
            expect(satisfied?.c).toBe(1);
        });

        it('allows regeneration under new policy after cancellation', async () => {
            await seedModel(db, { id: 'm1', tier: 'FREE' });

            await materializeExpectations(db, {
                policyVersion: 'v1',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });

            await cancelExpectationsForPolicyChange(db, 'v1', 'v2', makeNow());

            const count = await materializeExpectations(db, {
                policyVersion: 'v2',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });

            expect(count).toBeGreaterThan(0);

            const v2Rows = await db
                .prepare(
                    `SELECT COUNT(*) as c FROM model_check_expectations WHERE policy_version = 'v2'`,
                )
                .first<{ c: number }>();
            expect(v2Rows?.c).toBe(count);
        });
    });
});

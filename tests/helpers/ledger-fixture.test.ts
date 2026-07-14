import { describe, expect, it } from 'vitest';
import {
    createTestDb,
    seedProvider,
    seedModel,
    seedMonitorRun,
    seedExpectation,
    seedAttempt,
    seedTick,
    seedExecution,
    assertProbeEvent,
} from './ledger-fixture.ts';

describe('ledger fixture helpers', () => {
    describe('createTestDb', () => {
        it('creates an in-memory DB with all migrations applied', async () => {
            const db = createTestDb();
            const row = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providers'").first<{ name: string }>();
            expect(row?.name).toBe('providers');
        });

        it('includes the 0009 ledger tables', async () => {
            const db = createTestDb();
            const tables = ['scheduler_ticks', 'model_check_expectations', 'probe_attempts', 'probe_events'];
            for (const t of tables) {
                const row = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(t).first<{ name: string }>();
                expect(row?.name).toBe(t);
            }
        });
    });

    describe('seedProvider', () => {
        it('inserts a provider with defaults', async () => {
            const db = createTestDb();
            const p = await seedProvider(db);
            const row = await db.prepare('SELECT * FROM providers WHERE id = ?').bind(p.id).first<{ name: string }>();
            expect(row).not.toBeNull();
            expect(row!.name).toBe('test-provider');
        });

        it('accepts overrides', async () => {
            const db = createTestDb();
            const p = await seedProvider(db, { name: 'custom-provider' });
            expect(p.name).toBe('custom-provider');
            const row = await db.prepare('SELECT * FROM providers WHERE id = ?').bind(p.id).first<{ name: string }>();
            expect(row!.name).toBe('custom-provider');
        });
    });

    describe('seedModel', () => {
        it('inserts a model with a default provider', async () => {
            const db = createTestDb();
            const m = await seedModel(db);
            expect(m.remote_name).toBe('test-model');
            expect(m.tier).toBe('FREE');
            const row = await db.prepare('SELECT * FROM models WHERE id = ?').bind(m.id).first<{ remote_name: string }>();
            expect(row!.remote_name).toBe('test-model');
        });
    });

    describe('seedMonitorRun', () => {
        it('inserts a monitor run', async () => {
            const db = createTestDb();
            const r = await seedMonitorRun(db);
            const row = await db.prepare('SELECT * FROM monitor_runs WHERE id = ?').bind(r.id).first<{ started_at: string }>();
            expect(row).not.toBeNull();
        });
    });

    describe('seedExpectation', () => {
        it('inserts a model_check_expectations row with defaults', async () => {
            const db = createTestDb();
            const e = await seedExpectation(db);
            expect(e.purpose).toBe('AVAILABILITY');
            expect(e.tier).toBe('FREE');
            expect(e.state).toBe('EXPECTED');
            const row = await db.prepare('SELECT * FROM model_check_expectations WHERE id = ?').bind(e.id).first<{ purpose: string; interval_minutes: number }>();
            expect(row!.purpose).toBe('AVAILABILITY');
            expect(row!.interval_minutes).toBe(5);
        });
    });

    describe('seedAttempt', () => {
        it('inserts a probe_attempts row with defaults', async () => {
            const db = createTestDb();
            const a = await seedAttempt(db);
            expect(a.attempt_no).toBe(1);
            expect(a.state).toBe('LEASED');
            const row = await db.prepare('SELECT * FROM probe_attempts WHERE id = ?').bind(a.id).first<{ attempt_no: number }>();
            expect(row!.attempt_no).toBe(1);
        });
    });

    describe('seedTick', () => {
        it('inserts a scheduler_ticks row with defaults', async () => {
            const db = createTestDb();
            const t = await seedTick(db);
            expect(t.trigger).toBe('CRON');
            expect(t.state).toBe('RECEIVED');
            expect(t.tick_key).toMatch(/^cron:/);
            const row = await db.prepare('SELECT * FROM scheduler_ticks WHERE id = ?').bind(t.id).first<{ trigger: string }>();
            expect(row!.trigger).toBe('CRON');
        });
    });

    describe('seedExecution', () => {
        it('inserts a model_check_executions row linked to an expectation', async () => {
            const db = createTestDb();
            const e = await seedExecution(db);
            expect(e.expectation_id).not.toBeNull();
            const row = await db.prepare('SELECT * FROM model_check_executions WHERE id = ?').bind(e.id).first<{ expectation_id: string; purpose: string }>();
            expect(row!.expectation_id).toBe(e.expectation_id);
            expect(row!.purpose).toBe('AVAILABILITY');
        });
    });

    describe('assertProbeEvent', () => {
        it('passes when matching event exists with expected fields', async () => {
            const db = createTestDb();
            const now = new Date().toISOString();
            const tick = await seedTick(db);
            const run = await seedMonitorRun(db);
            const model = await seedModel(db);
            const expectRow = await seedExpectation(db, { model_id: model.id });
            const exec = await seedExecution(db, { model_id: model.id, expectation_id: expectRow.id });
            const attempt = await seedAttempt(db, { model_id: model.id, run_id: run.id });

            await db
                .prepare(
                    `INSERT INTO probe_events
                     (id, event_type, event_version, occurred_at, recorded_at,
                      actor_type, actor_id, subject_type, subject_id,
                      scheduler_tick_id, run_id, expectation_id, execution_id, attempt_id,
                      detail_json)
                     VALUES (?, 'probe.attempt.leased', '1.0', ?, ?,
                             'scheduler', ?, 'probe_attempt', ?,
                             ?, ?, ?, ?, ?,
                             ?)`,
                )
                .bind(
                    `evt_${crypto.randomUUID()}`,
                    now,
                    now,
                    tick.id,
                    attempt.id,
                    tick.id,
                    run.id,
                    expectRow.id,
                    exec.id,
                    attempt.id,
                    JSON.stringify({ attempt_no: 1, model_id: model.id }),
                )
                .run();

            await expect(
                assertProbeEvent(db, 'probe.attempt.leased', {
                    actor_type: 'scheduler',
                    subject_type: 'probe_attempt',
                    detail_json: { attempt_no: 1 },
                }),
            ).resolves.toBeUndefined();
        });

        it('throws when no matching event exists', async () => {
            const db = createTestDb();
            await expect(
                assertProbeEvent(db, 'nonexistent.event', {}),
            ).rejects.toThrow("No probe_event found with event_type = 'nonexistent.event'");
        });

        it('throws on field mismatch', async () => {
            const db = createTestDb();
            const now = new Date().toISOString();
            await db
                .prepare(
                    `INSERT INTO probe_events
                     (id, event_type, event_version, occurred_at, recorded_at,
                      actor_type, actor_id, subject_type, subject_id, detail_json)
                     VALUES (?, 'test.event', '1.0', ?, ?,
                             'scheduler', 'sched-1', 'model', 'model-1', ?)`,
                )
                .bind(`evt_${crypto.randomUUID()}`, now, now, JSON.stringify({ key: 'val' }))
                .run();

            await expect(
                assertProbeEvent(db, 'test.event', { actor_type: 'wrong-value' }),
            ).rejects.toThrow(/mismatch/);
        });
    });
});

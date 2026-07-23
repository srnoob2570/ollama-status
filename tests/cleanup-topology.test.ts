import { describe, expect, it, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { SqliteD1Adapter } from '../src/node/sqlite-d1-adapter.ts';
import type { Env } from '../src/worker/types.ts';

// ── Mock-based topological order test ────────────────────────────────────────

describe('cleanup topological order', () => {
    beforeEach(() => { vi.resetModules(); });

    it('issues DELETE statements in correct dependency order with correct retention periods', async () => {
        const { cleanup } = await import('../src/worker/monitor.ts');
        const writes: Array<{ sql: string; bindings: unknown[] }> = [];
        const env = {
            DB: {
                prepare(sql: string) {
                    let bindings: unknown[] = [];
                    return {
                        bind(...values: unknown[]) {
                            bindings = values;
                            return this;
                        },
                        async run() {
                            writes.push({ sql, bindings });
                            return { meta: { changes: 1 } };
                        },
                    };
                },
            },
        } as unknown as Env;

        const reference = Date.parse('2035-02-03T12:00:00.000Z');
        await cleanup(env, reference);

        // Verify all 10 DELETE statements are present
        const tables = [
            'probe_outbox',
            'probe_events',
            'result_submissions',
            'checks',
            'probe_attempts',
            'scheduler_ticks',
            'model_check_executions',
            'model_check_expectations',
            'hourly_model_rollups',
            'hourly_execution_rollups',
        ];

        for (const table of tables) {
            const idx = writes.findIndex((w) => new RegExp(`DELETE FROM ${table}`).test(w.sql));
            expect(idx).toBeGreaterThanOrEqual(0);
        }

        // Verify topological order (children before parents)

        // probe_outbox before probe_events (FK event_id)
        const outboxIdx = writes.findIndex((w) => /DELETE FROM probe_outbox/.test(w.sql));
        const eventsIdx = writes.findIndex((w) => /DELETE FROM probe_events/.test(w.sql));
        expect(outboxIdx).toBeLessThan(eventsIdx);

        // probe_events before probe_attempts (FK attempt_id)
        expect(eventsIdx).toBeLessThan(
            writes.findIndex((w) => /DELETE FROM probe_attempts/.test(w.sql)),
        );

        // result_submissions before probe_attempts (FK attempt_id)
        const submissionsIdx = writes.findIndex((w) => /DELETE FROM result_submissions/.test(w.sql));
        const attemptsIdx = writes.findIndex((w) => /DELETE FROM probe_attempts/.test(w.sql));
        expect(submissionsIdx).toBeLessThan(attemptsIdx);

        // checks before probe_attempts (FK attempt_id)
        const checksIdx = writes.findIndex((w) => /DELETE FROM checks[^_]/.test(w.sql));
        expect(checksIdx).toBeLessThan(attemptsIdx);

        // checks before model_check_executions (FK execution_id)
        const executionsIdx = writes.findIndex((w) => /DELETE FROM model_check_executions/.test(w.sql));
        expect(checksIdx).toBeLessThan(executionsIdx);

        // model_check_executions before model_check_expectations (FK expectation_id)
        const expectationsIdx = writes.findIndex((w) => /DELETE FROM model_check_expectations/.test(w.sql));
        expect(executionsIdx).toBeLessThan(expectationsIdx);

        // Verify retention periods
        const expected14d = new Date(reference - 14 * 24 * 60 * 60_000).toISOString();
        const expected90d = new Date(reference - 90 * 24 * 60 * 60_000).toISOString();
        const expected730d = new Date(reference - 730 * 24 * 60 * 60_000).toISOString();

        // 14d tables
        expect(writes[outboxIdx].bindings).toEqual([expected14d]);
        expect(writes[eventsIdx].bindings).toEqual([expected14d]);

        // 90d tables
        expect(writes[submissionsIdx].bindings).toEqual([expected90d]);
        expect(writes[checksIdx].bindings).toEqual([expected90d]);
        expect(writes[attemptsIdx].bindings).toEqual([expected90d]);
        const ticksIdx = writes.findIndex((w) => /DELETE FROM scheduler_ticks/.test(w.sql));
        expect(writes[ticksIdx].bindings).toEqual([expected90d]);
        expect(writes[executionsIdx].bindings).toEqual([expected90d]);
        expect(writes[expectationsIdx].bindings).toEqual([expected90d]);

        // 730d tables
        const rollupsIdx = writes.findIndex((w) => /DELETE FROM hourly_model_rollups/.test(w.sql));
        expect(writes[rollupsIdx].bindings).toEqual([expected730d]);
        const execRollupsIdx = writes.findIndex((w) => /DELETE FROM hourly_execution_rollups/.test(w.sql));
        expect(writes[execRollupsIdx].bindings).toEqual([expected730d]);

        // Verify NOT EXISTS guards on child-safe deletes
        expect(writes[attemptsIdx].sql).toContain('NOT EXISTS');
        expect(writes[executionsIdx].sql).toContain('NOT EXISTS');
        expect(writes[expectationsIdx].sql).toContain('NOT EXISTS');
    });
});

// ── Real SQLite integration test ──────────────────────────────────────────────

describe('cleanup data retention', () => {
    beforeEach(() => { vi.resetModules(); });

    function migratedDb(): DatabaseSync {
        const db = new DatabaseSync(':memory:');
        for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort())
            db.exec(readFileSync(`migrations/${file}`, 'utf8'));
        return db;
    }

    function makeEnv(db: DatabaseSync): Env {
        return { DB: new SqliteD1Adapter(db) } as unknown as Env;
    }

    function seedData(db: DatabaseSync, baseTime: number): void {
        const now_ = new Date(baseTime).toISOString();
        const old14d = new Date(baseTime - 20 * 24 * 60 * 60_000).toISOString();
        const old90d = new Date(baseTime - 100 * 24 * 60 * 60_000).toISOString();
        const old730d = new Date(baseTime - 800 * 24 * 60 * 60_000).toISOString();
        const recent = new Date(baseTime - 1 * 24 * 60 * 60_000).toISOString();

        // Seed base tables
        db.exec(`
            INSERT INTO providers (id, name, kind, base_url, secret_ref, created_at)
                VALUES ('prov-test', 'Test', 'ollama', 'https://test', 'SECRET', '${now_}');
            INSERT INTO models (id, provider_id, remote_name, active, excluded, created_at, updated_at)
                VALUES ('model-a', 'prov-test', 'test-model', 1, 0, '${now_}', '${now_}');
            INSERT INTO monitor_runs (id, started_at)
                VALUES ('run-1', '${now_}');
            INSERT INTO monitor_runs (id, started_at)
                VALUES ('run-2', '${now_}');
        `);

        // Seed expectations (old and recent)
        db.exec(`
            INSERT INTO model_check_expectations (id, model_id, purpose, due_at, deadline_at, tier, interval_minutes, cutover_at, state)
                VALUES ('expect-old', 'model-a', 'AVAILABILITY', '${old90d}', '${old90d}', 'FREE', 5, '${now_}', 'MISSED');
            INSERT INTO model_check_expectations (id, model_id, purpose, due_at, deadline_at, tier, interval_minutes, cutover_at, state)
                VALUES ('expect-recent', 'model-a', 'AVAILABILITY', '${recent}', '${recent}', 'FREE', 5, '${now_}', 'EXPECTED');
        `);

        // Seed executions (old and recent) — use different run_ids to avoid UNIQUE(run_id, model_id)
        db.exec(`
            INSERT INTO model_check_executions (id, run_id, model_id, tier, interval_minutes, scheduled_at, state, expectation_id, purpose, due_at, deadline_at)
                VALUES ('exec-old', 'run-1', 'model-a', 'FREE', 5, '${old90d}', 'COMPLETED', 'expect-old', 'AVAILABILITY', '${old90d}', '${old90d}');
            INSERT INTO model_check_executions (id, run_id, model_id, tier, interval_minutes, scheduled_at, state, expectation_id, purpose, due_at, deadline_at)
                VALUES ('exec-recent', 'run-2', 'model-a', 'FREE', 5, '${recent}', 'COMPLETED', 'expect-recent', 'AVAILABILITY', '${recent}', '${recent}');
        `);

        // Seed checks (old and recent) — use rtt_ms not ttft_ms
        db.exec(`
            INSERT INTO checks (id, model_id, provider_id, classification, public_status, rtt_ms, checked_at, execution_id)
                VALUES ('check-old', 'model-a', 'prov-test', 'SUCCESS', 'OPERATIONAL', 100, '${old90d}', 'exec-old');
            INSERT INTO checks (id, model_id, provider_id, classification, public_status, rtt_ms, checked_at, execution_id)
                VALUES ('check-recent', 'model-a', 'prov-test', 'SUCCESS', 'OPERATIONAL', 100, '${recent}', 'exec-recent');
        `);

        // Seed probe_attempts (old and recent)
        db.exec(`
            INSERT INTO probe_attempts (id, run_id, model_id, provider_id, state, finished_at)
                VALUES ('attempt-old', 'run-1', 'model-a', 'prov-test', 'COMPLETED', '${old90d}');
            INSERT INTO probe_attempts (id, run_id, model_id, provider_id, state, finished_at)
                VALUES ('attempt-recent', 'run-2', 'model-a', 'prov-test', 'COMPLETED', '${recent}');
        `);

        // Seed probe_events (old and recent)
        db.exec(`
            INSERT INTO probe_events (id, event_type, event_version, occurred_at, recorded_at)
                VALUES ('event-old', 'PROBE_STARTED', '1.0', '${old14d}', '${old14d}');
            INSERT INTO probe_events (id, event_type, event_version, occurred_at, recorded_at)
                VALUES ('event-recent', 'PROBE_STARTED', '1.0', '${recent}', '${recent}');
        `);

        // Seed probe_outbox (old)
        db.exec(`
            INSERT INTO probe_outbox (id, event_id)
                VALUES ('outbox-old', 'event-old');
        `);

        // Seed result_submissions (old and recent)
        db.exec(`
            INSERT INTO result_submissions (id, attempt_id, received_at, idempotency_key, canonical_payload_hash, disposition)
                VALUES ('sub-old', 'attempt-old', '${old90d}', 'key-old', 'hash-old', 'ACCEPTED');
            INSERT INTO result_submissions (id, attempt_id, received_at, idempotency_key, canonical_payload_hash, disposition)
                VALUES ('sub-recent', 'attempt-recent', '${recent}', 'key-recent', 'hash-recent', 'ACCEPTED');
        `);

        // Seed scheduler_ticks (old and recent)
        db.exec(`
            INSERT INTO scheduler_ticks (id, tick_key, scheduled_at, trigger, state)
                VALUES ('tick-old', 'tick-old-key', '${old90d}', 'CRON', 'COMPLETED');
            INSERT INTO scheduler_ticks (id, tick_key, scheduled_at, trigger, state)
                VALUES ('tick-recent', 'tick-recent-key', '${recent}', 'CRON', 'COMPLETED');
        `);

        // Seed rollups (old and recent)
        db.exec(`
            INSERT INTO hourly_model_rollups (model_id, hour_at, sample_count, success_count, avg_latency_ms)
                VALUES ('model-a', '${old730d.slice(0, 13)}:00:00.000Z', 10, 8, 100.0);
            INSERT INTO hourly_model_rollups (model_id, hour_at, sample_count, success_count, avg_latency_ms)
                VALUES ('model-a', '${recent.slice(0, 13)}:00:00.000Z', 10, 8, 100.0);
            INSERT INTO hourly_execution_rollups (model_id, hour_at, purpose, tier, nominal_expected, satisfied)
                VALUES ('model-a', '${old730d.slice(0, 13)}:00:00.000Z', 'AVAILABILITY', 'FREE', 12, 10);
            INSERT INTO hourly_execution_rollups (model_id, hour_at, purpose, tier, nominal_expected, satisfied)
                VALUES ('model-a', '${recent.slice(0, 13)}:00:00.000Z', 'AVAILABILITY', 'FREE', 12, 10);
        `);
    }

    function count(db: DatabaseSync, table: string): number {
        const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number };
        return row.cnt;
    }

    it('deletes data beyond retention windows and preserves recent data', async () => {
        const { cleanup } = await import('../src/worker/monitor.ts');
        const reference = Date.parse('2035-02-03T12:00:00.000Z');
        const db = migratedDb();
        seedData(db, reference);
        const env = makeEnv(db);

        // Verify data was seeded
        expect(count(db, 'probe_events')).toBe(2);
        expect(count(db, 'probe_outbox')).toBe(1);
        expect(count(db, 'result_submissions')).toBe(2);
        expect(count(db, 'checks')).toBe(2);
        expect(count(db, 'probe_attempts')).toBe(2);
        expect(count(db, 'scheduler_ticks')).toBe(2);
        expect(count(db, 'model_check_executions')).toBe(2);
        expect(count(db, 'model_check_expectations')).toBe(2);
        expect(count(db, 'hourly_model_rollups')).toBe(2);
        expect(count(db, 'hourly_execution_rollups')).toBe(2);

        await cleanup(env, reference);

        // 14d tables: old events deleted, recent kept
        expect(count(db, 'probe_events')).toBe(1);
        expect(count(db, 'probe_outbox')).toBe(0);

        // 90d tables: old rows deleted, recent kept
        expect(count(db, 'result_submissions')).toBe(1);
        expect(count(db, 'checks')).toBe(1);
        expect(count(db, 'probe_attempts')).toBe(1);
        expect(count(db, 'scheduler_ticks')).toBe(1);
        expect(count(db, 'model_check_executions')).toBe(1);
        expect(count(db, 'model_check_expectations')).toBe(1);

        // 730d tables: old rollups deleted, recent kept
        expect(count(db, 'hourly_model_rollups')).toBe(1);
        expect(count(db, 'hourly_execution_rollups')).toBe(1);
    });

    it('preserves probe_attempts still referenced by checks (attempt_id)', async () => {
        const { cleanup } = await import('../src/worker/monitor.ts');
        const reference = Date.parse('2035-02-03T12:00:00.000Z');
        const old90d = new Date(reference - 100 * 24 * 60 * 60_000).toISOString();
        const recent = new Date(reference - 1 * 24 * 60 * 60_000).toISOString();
        const db = migratedDb();
        const env = makeEnv(db);

        db.exec(`
            INSERT INTO providers (id, name, kind, base_url, secret_ref, created_at)
                VALUES ('prov-test', 'Test', 'ollama', 'https://test', 'SECRET', '${old90d}');
            INSERT INTO models (id, provider_id, remote_name, active, excluded, created_at, updated_at)
                VALUES ('model-a', 'prov-test', 'test-model', 1, 0, '${old90d}', '${old90d}');
            INSERT INTO monitor_runs (id, started_at)
                VALUES ('run-1', '${old90d}');
            -- Old attempt (would be deleted by retention)
            INSERT INTO probe_attempts (id, run_id, model_id, provider_id, state, finished_at)
                VALUES ('attempt-ref', 'run-1', 'model-a', 'prov-test', 'COMPLETED', '${old90d}');
            -- Recent check still referencing the old attempt → preserves it
            INSERT INTO checks (id, model_id, provider_id, classification, public_status, rtt_ms, checked_at, attempt_id)
                VALUES ('check-ref', 'model-a', 'prov-test', 'SUCCESS', 'OPERATIONAL', 100, '${recent}', 'attempt-ref');
        `);

        await cleanup(env, reference);

        // The attempt should be preserved because check-ref (recent) still references it
        expect(count(db, 'probe_attempts')).toBe(1);
        expect(count(db, 'checks')).toBe(1);
    });

    it('preserves model_check_executions still referenced by checks (execution_id)', async () => {
        const { cleanup } = await import('../src/worker/monitor.ts');
        const reference = Date.parse('2035-02-03T12:00:00.000Z');
        const old90d = new Date(reference - 100 * 24 * 60 * 60_000).toISOString();
        const recent = new Date(reference - 1 * 24 * 60 * 60_000).toISOString();
        const db = migratedDb();
        const env = makeEnv(db);

        db.exec(`
            INSERT INTO providers (id, name, kind, base_url, secret_ref, created_at)
                VALUES ('prov-test', 'Test', 'ollama', 'https://test', 'SECRET', '${old90d}');
            INSERT INTO models (id, provider_id, remote_name, active, excluded, created_at, updated_at)
                VALUES ('model-a', 'prov-test', 'test-model', 1, 0, '${old90d}', '${old90d}');
            INSERT INTO monitor_runs (id, started_at)
                VALUES ('run-1', '${old90d}');
            -- Old execution (would be deleted by retention)
            INSERT INTO model_check_executions (id, run_id, model_id, tier, interval_minutes, scheduled_at, state, purpose, due_at, deadline_at)
                VALUES ('exec-ref', 'run-1', 'model-a', 'FREE', 5, '${old90d}', 'COMPLETED', 'AVAILABILITY', '${old90d}', '${old90d}');
            -- Recent check still referencing the old execution → preserves it
            INSERT INTO checks (id, model_id, provider_id, classification, public_status, rtt_ms, checked_at, execution_id)
                VALUES ('check-ref', 'model-a', 'prov-test', 'SUCCESS', 'OPERATIONAL', 100, '${recent}', 'exec-ref');
        `);

        await cleanup(env, reference);

        expect(count(db, 'model_check_executions')).toBe(1);
        expect(count(db, 'checks')).toBe(1);
    });

    it('preserves model_check_expectations still referenced by executions (expectation_id)', async () => {
        const { cleanup } = await import('../src/worker/monitor.ts');
        const reference = Date.parse('2035-02-03T12:00:00.000Z');
        const old90d = new Date(reference - 100 * 24 * 60 * 60_000).toISOString();
        const recent = new Date(reference - 1 * 24 * 60 * 60_000).toISOString();
        const db = migratedDb();
        const env = makeEnv(db);

        db.exec(`
            INSERT INTO providers (id, name, kind, base_url, secret_ref, created_at)
                VALUES ('prov-test', 'Test', 'ollama', 'https://test', 'SECRET', '${old90d}');
            INSERT INTO models (id, provider_id, remote_name, active, excluded, created_at, updated_at)
                VALUES ('model-a', 'prov-test', 'test-model', 1, 0, '${old90d}', '${old90d}');
            INSERT INTO monitor_runs (id, started_at)
                VALUES ('run-1', '${old90d}');
            -- Old expectation (would be deleted by retention)
            INSERT INTO model_check_expectations (id, model_id, purpose, due_at, deadline_at, tier, interval_minutes, cutover_at, state)
                VALUES ('expect-ref', 'model-a', 'AVAILABILITY', '${old90d}', '${old90d}', 'FREE', 5, '${old90d}', 'MISSED');
            -- Recent execution still referencing the old expectation → preserves it
            INSERT INTO model_check_executions (id, run_id, model_id, tier, interval_minutes, scheduled_at, state, expectation_id, purpose, due_at, deadline_at)
                VALUES ('exec-ref', 'run-1', 'model-a', 'FREE', 5, '${recent}', 'COMPLETED', 'expect-ref', 'AVAILABILITY', '${recent}', '${recent}');
        `);

        await cleanup(env, reference);

        expect(count(db, 'model_check_expectations')).toBe(1);
        expect(count(db, 'model_check_executions')).toBe(1);
    });
});

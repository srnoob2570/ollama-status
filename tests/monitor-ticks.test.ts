import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { SqliteD1Adapter } from '../src/node/sqlite-d1-adapter.ts';
import { recordSchedulerTick, updateSchedulerTick, updateExecutionState } from '../src/worker/ledger.ts';
import { id, now } from '../src/worker/types.ts';
import type { D1DatabaseLike } from '../src/worker/types.ts';

function migratedDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort())
        db.exec(readFileSync(`migrations/${file}`, 'utf8'));
    return db;
}

function makeDb(): D1DatabaseLike {
    return new SqliteD1Adapter(migratedDb());
}

function seedBase(db: D1DatabaseLike): { providerId: string; modelId: string; runId: string } {
    const providerId = 'prov-test';
    const modelId = 'model-test';
    const runId = id('run');
    const now_ = now();

    db.prepare(
        "INSERT INTO providers (id, name, kind, base_url, secret_ref, created_at) VALUES (?, ?, 'ollama', ?, ?, ?)",
    ).bind(providerId, 'Test Provider', 'https://test.example/api', 'OLLAMA_API_KEY_FREE', now_).run();

    db.prepare(
        'INSERT INTO models (id, provider_id, remote_name, active, excluded, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?)',
    ).bind(modelId, providerId, 'test-model', now_, now_).run();

    db.prepare(
        'INSERT INTO monitor_runs (id, started_at) VALUES (?, ?)',
    ).bind(runId, now_).run();

    return { providerId, modelId, runId };
}

describe('scheduler_tick recording', () => {
    it('records a tick with CRON trigger and derives tick_key from scheduled_at', async () => {
        const db = makeDb();
        const scheduledAt = new Date('2026-07-14T12:00:00.000Z').toISOString();
        const tickKey = `cron:${scheduledAt}`;

        const tick = await recordSchedulerTick(db, {
            tickKey,
            scheduledAt,
            startedAt: null,
            finishedAt: null,
            trigger: 'CRON',
            state: 'RECEIVED',
            outcome: null,
            runId: null,
            reasonCode: null,
            policyVersion: 0,
        });

        expect(tick.tickKey).toBe(tickKey);
        expect(tick.trigger).toBe('CRON');
        expect(tick.state).toBe('RECEIVED');
        expect(tick.outcome).toBeNull();
        expect(tick.runId).toBeNull();
    });

    it('records a tick with MANUAL trigger and derives tick_key from job_id', async () => {
        const db = makeDb();
        const jobId = 'manual_job_123';
        const tickKey = `manual:${jobId}`;

        const tick = await recordSchedulerTick(db, {
            tickKey,
            scheduledAt: now(),
            startedAt: null,
            finishedAt: null,
            trigger: 'MANUAL',
            state: 'RECEIVED',
            outcome: null,
            runId: null,
            reasonCode: null,
            policyVersion: 0,
        });

        expect(tick.tickKey).toBe(tickKey);
        expect(tick.trigger).toBe('MANUAL');
    });

    it('records a tick with RECOVERY trigger and derives tick_key from watermark', async () => {
        const db = makeDb();
        const watermark = '2026-07-14T12:00:00.000Z';
        const tickKey = `recovery:${watermark}`;

        const tick = await recordSchedulerTick(db, {
            tickKey,
            scheduledAt: watermark,
            startedAt: null,
            finishedAt: null,
            trigger: 'RECOVERY',
            state: 'RECEIVED',
            outcome: null,
            runId: null,
            reasonCode: null,
            policyVersion: 0,
        });

        expect(tick.tickKey).toBe(tickKey);
        expect(tick.trigger).toBe('RECOVERY');
    });

    it('is idempotent: two calls with the same tick_key produce one row', async () => {
        const rawDb = migratedDb();
        const db = new SqliteD1Adapter(rawDb);
        const tickKey = 'cron:2026-07-14T12:00:00.000Z';

        const first = await recordSchedulerTick(db, {
            tickKey,
            scheduledAt: now(),
            startedAt: null,
            finishedAt: null,
            trigger: 'CRON',
            state: 'RECEIVED',
            outcome: null,
            runId: null,
            reasonCode: null,
            policyVersion: 0,
        });

        const second = await recordSchedulerTick(db, {
            tickKey,
            scheduledAt: now(),
            startedAt: null,
            finishedAt: null,
            trigger: 'CRON',
            state: 'RECEIVED',
            outcome: null,
            runId: null,
            reasonCode: null,
            policyVersion: 0,
        });

        expect(second.id).toBe(first.id);
        expect(second.tickKey).toBe(first.tickKey);

        const rows = rawDb.prepare('SELECT COUNT(*) AS cnt FROM scheduler_ticks WHERE tick_key = ?').all(tickKey) as { cnt: number }[];
        expect(rows[0]?.cnt).toBe(1);
    });
});

describe('updateSchedulerTick', () => {
    it('updates state, outcome, and finished_at on an existing tick (no run_id)', async () => {
        const rawDb = migratedDb();
        const db = new SqliteD1Adapter(rawDb);
        const tickKey = 'cron:2026-07-14T12:00:00.000Z';

        await recordSchedulerTick(db, {
            tickKey,
            scheduledAt: now(),
            startedAt: null,
            finishedAt: null,
            trigger: 'CRON',
            state: 'RECEIVED',
            outcome: null,
            runId: null,
            reasonCode: null,
            policyVersion: 0,
        });

        await updateSchedulerTick(db, tickKey, {
            state: 'COMPLETED',
            outcome: 'SUCCEEDED',
            finishedAt: now(),
        });

        const row = rawDb.prepare('SELECT * FROM scheduler_ticks WHERE tick_key = ?').get(tickKey) as Record<string, unknown> | undefined;
        expect(row?.state).toBe('COMPLETED');
        expect(row?.outcome).toBe('SUCCEEDED');
        expect(row?.finished_at).not.toBeNull();
    });

    it('records LOCK_CONTENDED outcome when lock is lost', async () => {
        const rawDb = migratedDb();
        const db = new SqliteD1Adapter(rawDb);
        const tickKey = 'cron:2026-07-14T12:00:00.000Z';

        await recordSchedulerTick(db, {
            tickKey,
            scheduledAt: now(),
            startedAt: null,
            finishedAt: null,
            trigger: 'CRON',
            state: 'RECEIVED',
            outcome: null,
            runId: null,
            reasonCode: null,
            policyVersion: 0,
        });

        await updateSchedulerTick(db, tickKey, {
            state: 'COMPLETED',
            outcome: 'LOCK_CONTENDED',
            finishedAt: now(),
        });

        const row = rawDb.prepare('SELECT * FROM scheduler_ticks WHERE tick_key = ?').get(tickKey) as Record<string, unknown> | undefined;
        expect(row?.outcome).toBe('LOCK_CONTENDED');
    });

    it('records DUPLICATE outcome with a valid run_id', async () => {
        const rawDb = migratedDb();
        const db = new SqliteD1Adapter(rawDb);
        const { runId } = seedBase(db);
        const tickKey = 'cron:2026-07-14T12:00:00.000Z';

        await recordSchedulerTick(db, {
            tickKey,
            scheduledAt: now(),
            startedAt: null,
            finishedAt: null,
            trigger: 'CRON',
            state: 'RECEIVED',
            outcome: null,
            runId: null,
            reasonCode: null,
            policyVersion: 0,
        });

        await updateSchedulerTick(db, tickKey, {
            state: 'COMPLETED',
            outcome: 'DUPLICATE',
            runId,
            finishedAt: now(),
        });

        const row = rawDb.prepare('SELECT * FROM scheduler_ticks WHERE tick_key = ?').get(tickKey) as Record<string, unknown> | undefined;
        expect(row?.outcome).toBe('DUPLICATE');
    });

    it('records PARTIAL outcome with a valid run_id', async () => {
        const rawDb = migratedDb();
        const db = new SqliteD1Adapter(rawDb);
        const { runId } = seedBase(db);
        const tickKey = 'cron:2026-07-14T12:00:00.000Z';

        await recordSchedulerTick(db, {
            tickKey,
            scheduledAt: now(),
            startedAt: null,
            finishedAt: null,
            trigger: 'CRON',
            state: 'RECEIVED',
            outcome: null,
            runId: null,
            reasonCode: null,
            policyVersion: 0,
        });

        await updateSchedulerTick(db, tickKey, {
            state: 'COMPLETED',
            outcome: 'PARTIAL',
            runId,
            finishedAt: now(),
        });

        const row = rawDb.prepare('SELECT * FROM scheduler_ticks WHERE tick_key = ?').get(tickKey) as Record<string, unknown> | undefined;
        expect(row?.outcome).toBe('PARTIAL');
    });

    it('records FAILED outcome with a valid run_id', async () => {
        const rawDb = migratedDb();
        const db = new SqliteD1Adapter(rawDb);
        const { runId } = seedBase(db);
        const tickKey = 'cron:2026-07-14T12:00:00.000Z';

        await recordSchedulerTick(db, {
            tickKey,
            scheduledAt: now(),
            startedAt: null,
            finishedAt: null,
            trigger: 'CRON',
            state: 'RECEIVED',
            outcome: null,
            runId: null,
            reasonCode: null,
            policyVersion: 0,
        });

        await updateSchedulerTick(db, tickKey, {
            state: 'COMPLETED',
            outcome: 'FAILED',
            runId,
            finishedAt: now(),
        });

        const row = rawDb.prepare('SELECT * FROM scheduler_ticks WHERE tick_key = ?').get(tickKey) as Record<string, unknown> | undefined;
        expect(row?.outcome).toBe('FAILED');
    });

    it('records FULFILLED_BY_MANUAL outcome for manual jobs', async () => {
        const rawDb = migratedDb();
        const db = new SqliteD1Adapter(rawDb);
        const { runId } = seedBase(db);
        const tickKey = 'manual:job_456';

        await recordSchedulerTick(db, {
            tickKey,
            scheduledAt: now(),
            startedAt: null,
            finishedAt: null,
            trigger: 'MANUAL',
            state: 'RECEIVED',
            outcome: null,
            runId: null,
            reasonCode: null,
            policyVersion: 0,
        });

        await updateSchedulerTick(db, tickKey, {
            state: 'COMPLETED',
            outcome: 'FULFILLED_BY_MANUAL',
            runId,
            finishedAt: now(),
        });

        const row = rawDb.prepare('SELECT * FROM scheduler_ticks WHERE tick_key = ?').get(tickKey) as Record<string, unknown> | undefined;
        expect(row?.outcome).toBe('FULFILLED_BY_MANUAL');
    });
});

describe('failExecution with terminal_reason_code', () => {
    it('writes terminal_reason_code instead of free-string detail', async () => {
        const rawDb = migratedDb();
        const db = new SqliteD1Adapter(rawDb);
        const { modelId, runId } = seedBase(db);
        const executionId = id('exec');
        const now_ = now();

        rawDb.prepare(
            `INSERT INTO model_check_executions (id, run_id, model_id, tier, interval_minutes, scheduled_at, state)
             VALUES (?, ?, ?, 'FREE', 5, ?, 'RUNNING')`,
        ).run(executionId, runId, modelId, now_);

        await updateExecutionState(db, executionId, 'FAILED', 'unattributed', null);

        const row = rawDb.prepare('SELECT * FROM model_check_executions WHERE id = ?').get(executionId) as Record<string, unknown> | undefined;
        expect(row?.state).toBe('FAILED');
        expect(row?.terminal_reason_code).toBe('unattributed');
    });

    it('writes ABANDONED state with run_hard_stop reason', async () => {
        const rawDb = migratedDb();
        const db = new SqliteD1Adapter(rawDb);
        const { modelId, runId } = seedBase(db);
        const executionId = id('exec');
        const now_ = now();

        rawDb.prepare(
            `INSERT INTO model_check_executions (id, run_id, model_id, tier, interval_minutes, scheduled_at, state)
             VALUES (?, ?, ?, 'FREE', 5, ?, 'RUNNING')`,
        ).run(executionId, runId, modelId, now_);

        await updateExecutionState(db, executionId, 'ABANDONED', 'run_hard_stop', null);

        const row = rawDb.prepare('SELECT * FROM model_check_executions WHERE id = ?').get(executionId) as Record<string, unknown> | undefined;
        expect(row?.state).toBe('ABANDONED');
        expect(row?.terminal_reason_code).toBe('run_hard_stop');
    });

    it('writes ABANDONED state with lease_expired reason', async () => {
        const rawDb = migratedDb();
        const db = new SqliteD1Adapter(rawDb);
        const { modelId, runId } = seedBase(db);
        const executionId = id('exec');
        const now_ = now();

        rawDb.prepare(
            `INSERT INTO model_check_executions (id, run_id, model_id, tier, interval_minutes, scheduled_at, state)
             VALUES (?, ?, ?, 'FREE', 5, ?, 'RUNNING')`,
        ).run(executionId, runId, modelId, now_);

        await updateExecutionState(db, executionId, 'ABANDONED', 'lease_expired', null);

        const row = rawDb.prepare('SELECT * FROM model_check_executions WHERE id = ?').get(executionId) as Record<string, unknown> | undefined;
        expect(row?.state).toBe('ABANDONED');
        expect(row?.terminal_reason_code).toBe('lease_expired');
    });
});

describe('expectation-based scheduling', () => {
    it('creates executions from EXPECTED expectations and marks them SCHEDULED', async () => {
        const rawDb = migratedDb();
        const db = new SqliteD1Adapter(rawDb);
        const { modelId, runId } = seedBase(db);
        const expectationId = id('expect');
        const dueAt = new Date('2026-07-14T11:00:00.000Z').toISOString();
        const deadlineAt = new Date('2026-07-14T13:00:00.000Z').toISOString();
        const now_ = now();

        rawDb.prepare(
            `INSERT INTO model_check_expectations (id, model_id, purpose, due_at, deadline_at, tier, interval_minutes, cutover_at, state)
             VALUES (?, ?, 'AVAILABILITY', ?, ?, 'FREE', 5, ?, 'EXPECTED')`,
        ).run(expectationId, modelId, dueAt, deadlineAt, now_);

        // Query expectations that are due
        const due = await db.prepare(
            `SELECT e.id AS expectation_id, e.model_id, e.purpose, e.due_at, e.deadline_at,
                    e.tier, e.interval_minutes, e.config_snapshot_json, e.policy_version,
                    m.id, m.provider_id, m.remote_name, m.digest, m.last_show_at, m.tier AS model_tier
             FROM model_check_expectations e
             JOIN models m ON m.id = e.model_id
             WHERE e.state IN ('EXPECTED', 'SCHEDULED')
               AND e.due_at <= ?
             ORDER BY e.due_at
             LIMIT 40`,
        ).bind(deadlineAt).all<Record<string, unknown>>();

        expect(due.results.length).toBe(1);
        expect(due.results[0].expectation_id).toBe(expectationId);
        expect(due.results[0].model_id).toBe(modelId);
        expect(due.results[0].purpose).toBe('AVAILABILITY');

        // Create execution and mark expectation SCHEDULED
        const executionId = id('exec');
        await db.prepare(
            `INSERT INTO model_check_executions(id,run_id,model_id,expectation_id,purpose,due_at,deadline_at,tier,interval_minutes,policy_version,scheduled_at,state)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,'SCHEDULED')`,
        ).bind(executionId, runId, modelId, expectationId, 'AVAILABILITY', dueAt, deadlineAt, 'FREE', 5, '0', now_).run();

        await db.prepare(
            "UPDATE model_check_expectations SET state = 'SCHEDULED' WHERE id = ? AND state IN ('EXPECTED', 'SCHEDULED')",
        ).bind(expectationId).run();

        const execRow = rawDb.prepare('SELECT * FROM model_check_executions WHERE id = ?').get(executionId) as Record<string, unknown> | undefined;
        expect(execRow?.state).toBe('SCHEDULED');
        expect(execRow?.expectation_id).toBe(expectationId);

        const expRow = rawDb.prepare('SELECT * FROM model_check_expectations WHERE id = ?').get(expectationId) as Record<string, unknown> | undefined;
        expect(expRow?.state).toBe('SCHEDULED');
    });

    it('does not create executions for expectations with future due_at', async () => {
        const rawDb = migratedDb();
        const db = new SqliteD1Adapter(rawDb);
        const { modelId } = seedBase(db);
        const expectationId = id('expect');
        const futureDue = new Date('2099-01-01T00:00:00.000Z').toISOString();
        const now_ = now();

        rawDb.prepare(
            `INSERT INTO model_check_expectations (id, model_id, purpose, due_at, deadline_at, tier, interval_minutes, cutover_at, state)
             VALUES (?, ?, 'AVAILABILITY', ?, ?, 'FREE', 5, ?, 'EXPECTED')`,
        ).run(expectationId, modelId, futureDue, futureDue, now_);

        const due = await db.prepare(
            `SELECT e.id AS expectation_id
             FROM model_check_expectations e
             JOIN models m ON m.id = e.model_id
             WHERE e.state IN ('EXPECTED', 'SCHEDULED')
               AND e.due_at <= ?
             ORDER BY e.due_at
             LIMIT 40`,
        ).bind(now_).all<Record<string, unknown>>();

        expect(due.results.length).toBe(0);
    });
});

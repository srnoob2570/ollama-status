import { describe, expect, it, beforeEach } from 'vitest';
import { createTestDb, seedProvider, seedModel } from './helpers/ledger-fixture.ts';
import { materializeExpectations } from '../src/worker/expectations.ts';
import {
    recordSchedulerTick,
    updateSchedulerTick,
    recordProbeAttempt,
    completeProbeAttempt,
    updateExpectationState,
    updateExecutionState,
} from '../src/worker/ledger.ts';
import { materializeStatus } from '../src/worker/monitor.ts';
import { analyzeCadence } from '../src/worker/cadence.ts';
import { id, now } from '../src/worker/types.ts';
import type { D1DatabaseLike, Env, ProbeResult, ProbeAttempt } from '../src/worker/types.ts';

// Use the real wall clock so expectations materialized here have deadlines in
// the future relative to `now()` used internally by `completeProbeAttempt`.
// A fixed past date caused the ledger's STALE guard (receivedAt > deadline_at)
// to mark every attempt STALE -> MISSED.
function makeNow(): string {
    return new Date().toISOString();
}

function minutesFromNow(minutes: number): string {
    return new Date(Date.now() + minutes * 60_000).toISOString();
}

function makeResult(overrides?: Partial<ProbeResult>): ProbeResult {
    return {
        classification: 'SUCCESS',
        publicStatus: 'OPERATIONAL',
        httpStatus: 200,
        totalDurationMs: 150,
        rttMs: 100,
        loadDurationMs: 50,
        ttftMs: 120,
        contributesToStatus: true,
        ...overrides,
    };
}

function makeAttempt(
    overrides: Partial<ProbeAttempt> & { runId: string; modelId: string; providerId: string },
): ProbeAttempt {
    const now_ = now();
    const { runId, modelId, providerId, ...rest } = overrides;
    return {
        id: id('att'),
        runId,
        taskId: '',
        parentType: 'execution',
        parentId: '',
        modelId,
        attemptNo: 1,
        purpose: 'AVAILABILITY',
        providerId,
        credentialAccountId: '',
        credentialKeyId: '',
        credentialBindingId: '',
        nodeId: 'monitor-worker',
        region: '',
        queuedAt: now_,
        leasedAt: now_,
        startedAt: now_,
        headersAt: null,
        firstByteAt: null,
        firstTokenAt: null,
        finishedAt: null,
        receivedAt: null,
        state: 'LEASED',
        classification: 'UNKNOWN',
        publicStatus: 'UNKNOWN',
        contributesToStatus: true,
        failureDomain: null,
        reasonCode: null,
        evidenceSource: null,
        retryability: null,
        timeoutStage: null,
        timeoutBudgetMs: 45000,
        httpStatus: null,
        retryAfterSeconds: null,
        retryAt: null,
        bytesRead: null,
        queueWaitMs: null,
        ttftMs: null,
        totalElapsedMs: null,
        loadDurationMs: null,
        errorFingerprint: null,
        classifierRuleVersion: null,
        policyVersion: 0,
        agentVersion: null,
        experimentId: null,
        assignedArm: null,
        warmupAttemptId: null,
        wasWarmed: false,
        warmupAgeMs: null,
        experimentConfigVersion: null,
        ...rest,
    };
}

describe('monitor e2e integration', () => {
    let db: D1DatabaseLike;
    let providerId: string;
    let modelId: string;

    beforeEach(async () => {
        db = createTestDb();
        const provider = await seedProvider(db, {
            id: 'ollama-free',
            name: 'Ollama Cloud Free',
            base_url: 'https://api.ollama.com',
            secret_ref: 'OLLAMA_API_KEY_FREE',
        });
        providerId = provider.id;
        const model = await seedModel(db, {
            id: 'ollama:llama3.2',
            provider_id: providerId,
            remote_name: 'llama3.2',
            tier: 'FREE',
        });
        modelId = model.id;
    });

    describe('scheduler_tick → materialize expectations → select due', () => {
        it('records a scheduler tick and materializes expectations', async () => {
            const tickKey = `cron:${makeNow()}`;
            const tick = await recordSchedulerTick(db, {
                tickKey,
                scheduledAt: makeNow(),
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
            expect(tick.state).toBe('RECEIVED');

            const count = await materializeExpectations(db, {
                policyVersion: '1',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });
            expect(count).toBeGreaterThan(0);

            const due = await db
                .prepare(
                    `SELECT * FROM model_check_expectations
                     WHERE state IN ('EXPECTED', 'SCHEDULED')
                       AND due_at <= ?`,
                )
                .bind(minutesFromNow(5))
                .all<Record<string, unknown>>();
            expect(due.results.length).toBeGreaterThan(0);
        });

        it('selects due expectations without LIMIT 40', async () => {
            await materializeExpectations(db, {
                policyVersion: '1',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });

            const due = await db
                .prepare(
                    `SELECT e.id AS expectation_id, e.model_id, e.purpose, e.due_at, e.deadline_at,
                            e.tier, e.interval_minutes, e.config_snapshot_json, e.policy_version,
                            m.id, m.provider_id, m.remote_name, m.digest, m.last_show_at, m.tier AS model_tier
                     FROM model_check_expectations e
                     JOIN models m ON m.id = e.model_id
                     WHERE e.state IN ('EXPECTED', 'SCHEDULED')
                       AND e.due_at <= ?
                     ORDER BY e.due_at`,
                )
                .bind(minutesFromNow(60))
                .all<Record<string, unknown>>();

            expect(due.results.length).toBeGreaterThan(0);
        });
    });

    describe('create executions/attempts → probe with timeline → classify', () => {
        it('creates execution, records attempt, completes with result', async () => {
            const runId = id('run');
            const now_ = now();
            await db.prepare(
                'INSERT INTO monitor_runs (id, started_at) VALUES (?, ?)',
            ).bind(runId, now_).run();

            await materializeExpectations(db, {
                policyVersion: '1',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });

            const due = await db
                .prepare(
                    `SELECT e.id AS expectation_id, e.model_id, e.purpose, e.due_at, e.deadline_at,
                            e.tier, e.interval_minutes
                     FROM model_check_expectations e
                     WHERE e.state = 'EXPECTED'
                     ORDER BY e.due_at
                     LIMIT 1`,
                )
                .first<Record<string, unknown>>();
            expect(due).not.toBeNull();

            const executionId = id('exec');
            await db.prepare(
                `INSERT INTO model_check_executions (id, run_id, model_id, expectation_id, purpose, due_at, deadline_at, tier, interval_minutes, policy_version, scheduled_at, state)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '0', ?, 'SCHEDULED')`,
            ).bind(
                executionId,
                runId,
                modelId,
                due!.expectation_id,
                due!.purpose,
                due!.due_at,
                due!.deadline_at,
                due!.tier,
                due!.interval_minutes,
                now_,
            ).run();

            await updateExpectationState(db, due!.expectation_id as string, 'SCHEDULED', null);

            const attempt = makeAttempt({
                runId,
                modelId,
                providerId,
                parentType: 'execution',
                parentId: executionId,
                purpose: (due!.purpose as string) || 'AVAILABILITY',
            });
            await recordProbeAttempt(db, attempt);

            const result = makeResult({
                classification: 'SUCCESS',
                publicStatus: 'OPERATIONAL',
                httpStatus: 200,
                ttftMs: 120,
                headersAt: now_,
                firstByteAt: now_,
                firstTokenAt: now_,
            });

            const completed = await completeProbeAttempt(db, attempt.id, result, {
                idempotencyKey: `${executionId}:1`,
                canonicalPayloadHash: 'SUCCESS:200',
                taskId: executionId,
                nodeId: 'monitor-worker',
                fencingToken: runId,
            });

            expect(completed.state).toBe('COMPLETED');
            expect(completed.classification).toBe('SUCCESS');

            await updateExecutionState(db, executionId, 'COMPLETED', null, null);

            const exec = await db
                .prepare('SELECT state FROM model_check_expectations WHERE id = ?')
                .bind(due!.expectation_id as string)
                .first<{ state: string }>();
            expect(exec?.state).toBe('SATISFIED');
        });
    });

    describe('ledger writer persists → outbox consumer processes', () => {
        it('creates probe_event and probe_outbox on attempt completion', async () => {
            const runId = id('run');
            const now_ = now();
            await db.prepare(
                'INSERT INTO monitor_runs (id, started_at) VALUES (?, ?)',
            ).bind(runId, now_).run();

            await materializeExpectations(db, {
                policyVersion: '1',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });

            const due = await db
                .prepare(
                    `SELECT id AS expectation_id, model_id, purpose, due_at, deadline_at, tier, interval_minutes
                     FROM model_check_expectations WHERE state = 'EXPECTED' LIMIT 1`,
                )
                .first<Record<string, unknown>>();
            expect(due).not.toBeNull();

            const executionId = id('exec');
            await db.prepare(
                `INSERT INTO model_check_executions (id, run_id, model_id, expectation_id, purpose, due_at, deadline_at, tier, interval_minutes, policy_version, scheduled_at, state)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '0', ?, 'SCHEDULED')`,
            ).bind(executionId, runId, modelId, due!.expectation_id, due!.purpose, due!.due_at, due!.deadline_at, due!.tier, due!.interval_minutes, now_).run();

            const attempt = makeAttempt({
                runId,
                modelId,
                providerId,
                parentType: 'execution',
                parentId: executionId,
                purpose: (due!.purpose as string) || 'AVAILABILITY',
            });
            await recordProbeAttempt(db, attempt);

            const result = makeResult({ classification: 'SUCCESS', publicStatus: 'OPERATIONAL' });
            await completeProbeAttempt(db, attempt.id, result, {
                idempotencyKey: `${executionId}:1`,
                canonicalPayloadHash: 'SUCCESS:200',
                taskId: executionId,
                nodeId: 'monitor-worker',
                fencingToken: runId,
            });

            const events = await db
                .prepare('SELECT * FROM probe_events WHERE attempt_id = ?')
                .bind(attempt.id)
                .all<Record<string, unknown>>();
            expect(events.results.length).toBeGreaterThan(0);

            const outbox = await db
                .prepare('SELECT * FROM probe_outbox WHERE event_id = ?')
                .bind(events.results[0].id as string)
                .all<Record<string, unknown>>();
            expect(outbox.results.length).toBe(1);
        });
    });

    describe('cadence analyzed → API exposes', () => {
        it('analyzes cadence from expectations', async () => {
            const t = makeNow();
            await materializeExpectations(db, {
                policyVersion: '1',
                nowIso: t,
                horizonMinutes: 60,
            });

            const window = await analyzeCadence(db, modelId, '1h', {
                nowIso: t,
            });

            expect(window.modelId).toBe(modelId);
            expect(window.window).toBe('1h');
            expect(window.nominalExpected).toBe(0);
            expect(window.state).toBe('INSUFFICIENT_DATA');
        });

        it('reports HEALTHY when all slots satisfied', async () => {
            const runId = id('run');
            const now_ = now();
            await db.prepare(
                'INSERT INTO monitor_runs (id, started_at) VALUES (?, ?)',
            ).bind(runId, now_).run();

            await materializeExpectations(db, {
                policyVersion: '1',
                nowIso: makeNow(),
                horizonMinutes: 30,
            });

            const expectations = await db
                .prepare(
                    `SELECT id, model_id, purpose, due_at, deadline_at, tier, interval_minutes
                     FROM model_check_expectations WHERE state = 'EXPECTED' ORDER BY due_at`,
                )
                .all<Record<string, unknown>>();

            let offset = 0;
            for (const exp of expectations.results) {
                const executionId = id('exec');
                const scheduledAt = new Date(new Date(makeNow()).getTime() + offset * 1000).toISOString();
                const execRunId = id('run');
                await db.prepare(
                    'INSERT INTO monitor_runs (id, started_at) VALUES (?, ?)',
                ).bind(execRunId, now_).run();
                await db.prepare(
                    `INSERT INTO model_check_executions (id, run_id, model_id, expectation_id, purpose, due_at, deadline_at, tier, interval_minutes, policy_version, scheduled_at, state)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '0', ?, 'SCHEDULED')`,
                ).bind(executionId, execRunId, modelId, exp.id, exp.purpose, exp.due_at, exp.deadline_at, exp.tier, exp.interval_minutes, scheduledAt).run();

                const attempt = makeAttempt({
                    runId: execRunId,
                    modelId,
                    providerId,
                    parentType: 'execution',
                    parentId: executionId,
                    purpose: (exp.purpose as string) || 'AVAILABILITY',
                });
                await recordProbeAttempt(db, attempt);

                const result = makeResult({ classification: 'SUCCESS', publicStatus: 'OPERATIONAL' });
                await completeProbeAttempt(db, attempt.id, result, {
                    idempotencyKey: `${executionId}:1`,
                    canonicalPayloadHash: 'SUCCESS:200',
                    taskId: executionId,
                    nodeId: 'monitor-worker',
                    fencingToken: execRunId,
                });
                offset++;
            }

            const window = await analyzeCadence(db, modelId, '2h', {
                nowIso: minutesFromNow(60),
            });

            expect(window.state).toBe('HEALTHY');
            expect(window.nominalCoverage).toBeGreaterThanOrEqual(0.9);
        });
    });

    describe('contributes_to_status guard', () => {
        it('does not materialize status when contributesToStatus is false', async () => {
            const result = makeResult({
                classification: 'AUTH_ERROR',
                publicStatus: 'AUTHENTICATION',
                httpStatus: 401,
                contributesToStatus: false,
            });

            const provider = { id: providerId, name: 'Test', base_url: 'https://test.example', secret_ref: 'OLLAMA_API_KEY_FREE' as const };
            const model = { id: modelId, provider_id: providerId, remote_name: 'test-model', digest: null, last_show_at: null, tier: 'FREE' as const };

            const env = { DB: db } as unknown as Env;
            await materializeStatus(env, provider, model, result, makeNow());

            const status = await db
                .prepare('SELECT public_status FROM provider_model_status WHERE provider_id = ? AND model_id = ?')
                .bind(providerId, modelId)
                .first<{ public_status: string }>();
            expect(status).toBeNull();
        });

        it('materializes status when contributesToStatus is true', async () => {
            const result = makeResult({
                classification: 'SUCCESS',
                publicStatus: 'OPERATIONAL',
                httpStatus: 200,
                contributesToStatus: true,
            });

            const provider = { id: providerId, name: 'Test', base_url: 'https://test.example', secret_ref: 'OLLAMA_API_KEY_FREE' as const };
            const model = { id: modelId, provider_id: providerId, remote_name: 'test-model', digest: null, last_show_at: null, tier: 'FREE' as const };

            const env = { DB: db } as unknown as Env;
            await materializeStatus(env, provider, model, result, makeNow());

            const status = await db
                .prepare('SELECT public_status FROM provider_model_status WHERE provider_id = ? AND model_id = ?')
                .bind(providerId, modelId)
                .first<{ public_status: string }>();
            expect(status?.public_status).toBe('OPERATIONAL');
        });

        it('does not materialize outage for 429 rate limited probe', async () => {
            const result = makeResult({
                classification: 'RATE_LIMITED',
                publicStatus: 'RATE_LIMITED',
                httpStatus: 429,
                contributesToStatus: false,
            });

            const provider = { id: providerId, name: 'Test', base_url: 'https://test.example', secret_ref: 'OLLAMA_API_KEY_FREE' as const };
            const model = { id: modelId, provider_id: providerId, remote_name: 'test-model', digest: null, last_show_at: null, tier: 'FREE' as const };

            const env = { DB: db } as unknown as Env;
            await materializeStatus(env, provider, model, result, makeNow());

            const status = await db
                .prepare('SELECT public_status FROM provider_model_status WHERE provider_id = ? AND model_id = ?')
                .bind(providerId, modelId)
                .first<{ public_status: string }>();
            expect(status).toBeNull();
        });
    });

    describe('cleanup runs', () => {
        it('cleanup deletes old probe_outbox rows', async () => {
            const runId = id('run');
            const now_ = now();
            await db.prepare(
                'INSERT INTO monitor_runs (id, started_at) VALUES (?, ?)',
            ).bind(runId, now_).run();

            await materializeExpectations(db, {
                policyVersion: '1',
                nowIso: makeNow(),
                horizonMinutes: 60,
            });

            const due = await db
                .prepare('SELECT id AS expectation_id, model_id, purpose, due_at, deadline_at, tier, interval_minutes FROM model_check_expectations WHERE state = \'EXPECTED\' LIMIT 1')
                .first<Record<string, unknown>>();
            expect(due).not.toBeNull();

            const executionId = id('exec');
            await db.prepare(
                `INSERT INTO model_check_executions (id, run_id, model_id, expectation_id, purpose, due_at, deadline_at, tier, interval_minutes, policy_version, scheduled_at, state)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '0', ?, 'SCHEDULED')`,
            ).bind(executionId, runId, modelId, due!.expectation_id, due!.purpose, due!.due_at, due!.deadline_at, due!.tier, due!.interval_minutes, now_).run();

            const attempt = makeAttempt({
                runId,
                modelId,
                providerId,
                parentType: 'execution',
                parentId: executionId,
                purpose: (due!.purpose as string) || 'AVAILABILITY',
            });
            await recordProbeAttempt(db, attempt);

            const result = makeResult({ classification: 'SUCCESS', publicStatus: 'OPERATIONAL' });
            await completeProbeAttempt(db, attempt.id, result, {
                idempotencyKey: `${executionId}:1`,
                canonicalPayloadHash: 'SUCCESS:200',
                taskId: executionId,
                nodeId: 'monitor-worker',
                fencingToken: runId,
            });

            const outboxBefore = await db
                .prepare('SELECT COUNT(*) as c FROM probe_outbox')
                .first<{ c: number }>();
            expect(outboxBefore?.c).toBeGreaterThan(0);

            const threshold14d = new Date(Date.now() - 15 * 24 * 60 * 60_000).toISOString();
            await db.prepare(
                `DELETE FROM probe_outbox WHERE event_id IN (
                    SELECT id FROM probe_events WHERE occurred_at < ?
                )`,
            ).bind(threshold14d).run();

            const outboxAfter = await db
                .prepare('SELECT COUNT(*) as c FROM probe_outbox')
                .first<{ c: number }>();
            expect(outboxAfter?.c).toBe(outboxBefore?.c);
        });
    });

    describe('metrics emitted', () => {
        it('records scheduler tick with metrics', async () => {
            const tickKey = `cron:${makeNow()}`;
            const tick = await recordSchedulerTick(db, {
                tickKey,
                scheduledAt: makeNow(),
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

            const runId = id('run');
            const now_ = now();
            await db.prepare(
                'INSERT INTO monitor_runs (id, started_at) VALUES (?, ?)',
            ).bind(runId, now_).run();

            await updateSchedulerTick(db, tickKey, {
                state: 'RUNNING',
                runId,
                startedAt: now_,
            });

            const updated = await db
                .prepare('SELECT state FROM scheduler_ticks WHERE tick_key = ?')
                .bind(tickKey)
                .first<{ state: string }>();
            expect(updated?.state).toBe('RUNNING');
        });
    });
});

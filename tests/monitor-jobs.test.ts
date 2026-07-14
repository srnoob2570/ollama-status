import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteD1Adapter } from '../src/node/sqlite-d1-adapter.ts';
import type { ExecutionContext, MonitorEnv } from '../src/worker/types.ts';

const monitor = vi.hoisted(() => ({ runMonitor: vi.fn() }));
vi.mock('../src/worker/monitor.ts', () => monitor);
const { drainManualMonitorJobs, enqueueManualMonitorJob } = await import('../src/worker/monitor-jobs.ts');

function env(): MonitorEnv {
    const db = new DatabaseSync(':memory:');
    for (const file of readdirSync('migrations').filter((name) => name.endsWith('.sql')).sort())
        db.exec(readFileSync(`migrations/${file}`, 'utf8'));
    return {
        DB: new SqliteD1Adapter(db),
        ASSETS: undefined as never,
        OLLAMA_BASE_URL: 'https://example.test/api',
        OLLAMA_API_KEY_FREE: 'free',
        OLLAMA_API_KEY_PAID: 'paid',
    };
}

const ctx = { waitUntil(promise: Promise<unknown>) { void promise; } } as ExecutionContext;

describe('manual monitor jobs', () => {
    beforeEach(() => monitor.runMonitor.mockReset());

    it('deduplicates active manual jobs and expires abandoned work', async () => {
        const runnerEnv = env();
        const first = await enqueueManualMonitorJob(runnerEnv);
        const second = await enqueueManualMonitorJob(runnerEnv);
        expect(second).toEqual({ jobId: first.jobId, deduplicated: true });

        await runnerEnv.DB.prepare(
            "UPDATE monitor_jobs SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
        )
            .bind(first.jobId)
            .run();
        const replacement = await enqueueManualMonitorJob(runnerEnv);
        expect(replacement.jobId).not.toBe(first.jobId);
        await expect(
            runnerEnv.DB.prepare('SELECT state FROM monitor_jobs WHERE id=?').bind(first.jobId).first(),
        ).resolves.toEqual({ state: 'EXPIRED' });
    });

    it('claims a queued job once, retries only a lock, and persists failures', async () => {
        const runnerEnv = env();
        const queued = await enqueueManualMonitorJob(runnerEnv);
        monitor.runMonitor.mockResolvedValueOnce({ kind: 'LOCKED' });
        await drainManualMonitorJobs(runnerEnv, ctx);
        await expect(
            runnerEnv.DB.prepare('SELECT state,error FROM monitor_jobs WHERE id=?').bind(queued.jobId).first(),
        ).resolves.toEqual({ state: 'QUEUED', error: 'monitor_locked' });

        await runnerEnv.DB.prepare("INSERT INTO monitor_runs(id,started_at,phase) VALUES (?,'2026-01-01T00:00:00.000Z','CATALOG')")
            .bind('run_failed')
            .run();
        monitor.runMonitor.mockResolvedValueOnce({ kind: 'FAILED', runId: 'run_failed' });
        await drainManualMonitorJobs(runnerEnv, ctx);
        await expect(
            runnerEnv.DB.prepare('SELECT state,run_id,error FROM monitor_jobs WHERE id=?').bind(queued.jobId).first(),
        ).resolves.toEqual({ state: 'FAILED', run_id: 'run_failed', error: 'monitor_failed' });

        const next = await enqueueManualMonitorJob(runnerEnv);
        await runnerEnv.DB.prepare("INSERT INTO monitor_runs(id,started_at,phase) VALUES (?,'2026-01-01T00:00:00.000Z','CATALOG')")
            .bind('run_ok')
            .run();
        monitor.runMonitor.mockResolvedValue({ kind: 'COMPLETED', runId: 'run_ok', result: 'OK' });
        const claims = await Promise.all([
            drainManualMonitorJobs(runnerEnv, ctx),
            drainManualMonitorJobs(runnerEnv, ctx),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(monitor.runMonitor).toHaveBeenCalledTimes(3);
        await expect(
            runnerEnv.DB.prepare('SELECT state,run_id FROM monitor_jobs WHERE id=?').bind(next.jobId).first(),
        ).resolves.toEqual({ state: 'SUCCEEDED', run_id: 'run_ok' });
    });
});

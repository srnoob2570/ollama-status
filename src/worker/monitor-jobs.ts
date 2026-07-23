import { runMonitor, type MonitorRunResult } from './monitor.ts';
import { id, now, type ApiEnv, type ExecutionContext, type MonitorEnv } from './types.ts';

const JOB_TTL_MS = 15 * 60_000;

export type ManualMonitorJob = {
    id: string;
    state: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';
    expires_at: string;
};

/**
 * Enqueue a manual monitor job, deduplicating concurrent requests.
 *
 * Expires any stale queued/running jobs first, then inserts a new job.
 * When another active job already exists, returns its id with `deduplicated: true`.
 * The partial unique index on monitor_jobs is the authoritative deduplication
 * mechanism under concurrent requests.
 */
export async function enqueueManualMonitorJob(env: ApiEnv): Promise<{ jobId: string; deduplicated: boolean }> {
    const timestamp = now();
    await expireManualMonitorJobs(env, timestamp);
    const active = await activeManualMonitorJob(env);
    if (active) return { jobId: active.id, deduplicated: true };

    const jobId = id('manual_monitor');
    try {
        await env.DB.prepare(
            `INSERT INTO monitor_jobs(id,kind,state,created_at,updated_at,expires_at)
             VALUES (?,'MANUAL','QUEUED',?,?,?)`,
        )
            .bind(jobId, timestamp, timestamp, new Date(Date.now() + JOB_TTL_MS).toISOString())
            .run();
        return { jobId, deduplicated: false };
    } catch (error) {
        // The partial unique index is the authoritative deduplication mechanism under concurrent
        // requests. A competing request may have inserted after our initial read.
        const concurrent = await activeManualMonitorJob(env);
        if (concurrent) return { jobId: concurrent.id, deduplicated: true };
        throw error;
    }
}

async function activeManualMonitorJob(env: ApiEnv): Promise<ManualMonitorJob | null> {
    return env.DB.prepare(
        `SELECT id,state,expires_at FROM monitor_jobs
         WHERE kind='MANUAL' AND state IN ('QUEUED','RUNNING')
         ORDER BY created_at LIMIT 1`,
    ).first<ManualMonitorJob>();
}

/**
 * Transition every QUEUED or RUNNING manual monitor job past its expiry
 * timestamp to EXPIRED. Idempotent, safe to call on every tick.
 */
export async function expireManualMonitorJobs(env: ApiEnv, timestamp = now()): Promise<void> {
    await env.DB.prepare(
        `UPDATE monitor_jobs SET state='EXPIRED',updated_at=?
         WHERE kind='MANUAL' AND state IN ('QUEUED','RUNNING') AND expires_at <= ?`,
    )
        .bind(timestamp, timestamp)
        .run();
}

async function claimManualMonitorJob(env: MonitorEnv): Promise<ManualMonitorJob | null> {
    const timestamp = now();
    await expireManualMonitorJobs(env, timestamp);
    const candidate = await env.DB.prepare(
        `SELECT id,state,expires_at FROM monitor_jobs
         WHERE kind='MANUAL' AND state='QUEUED' AND expires_at > ?
         ORDER BY created_at LIMIT 1`,
    )
        .bind(timestamp)
        .first<ManualMonitorJob>();
    if (!candidate) return null;
    const claimed = await env.DB.prepare(
        `UPDATE monitor_jobs SET state='RUNNING',updated_at=?,error=NULL
         WHERE id=? AND state='QUEUED' AND expires_at > ?`,
    )
        .bind(timestamp, candidate.id, timestamp)
        .run();
    return claimed.meta.changes === 1 ? { ...candidate, state: 'RUNNING' } : null;
}

/**
 * Claim and execute one manual monitor job, if queued.
 *
 * Returns the job that was executed, or null when the queue is empty.
 * Lock-contended runs are re-queued for the next poll cycle;
 * failed and completed runs settle to their terminal state immediately.
 */
export async function drainManualMonitorJobs(
    env: MonitorEnv,
    ctx: ExecutionContext,
): Promise<ManualMonitorJob | null> {
    const job = await claimManualMonitorJob(env);
    if (!job) return null;

    const result = await runMonitor(env, ctx, Date.now(), 'MANUAL', job.id);
    await settleManualMonitorJob(env, job.id, result);
    return job;
}

async function settleManualMonitorJob(
    env: MonitorEnv,
    jobId: string,
    result: MonitorRunResult,
): Promise<void> {
    const timestamp = now();
    if (result.kind === 'LOCKED') {
        // Only lock contention is retried. The job remains eligible until its fixed expiry.
        await env.DB.prepare(
            `UPDATE monitor_jobs SET state='QUEUED',updated_at=?,error='monitor_locked'
             WHERE id=? AND expires_at > ?`,
        )
            .bind(timestamp, jobId, timestamp)
            .run();
        return;
    }
    if (result.kind === 'FAILED') {
        await env.DB.prepare(
            `UPDATE monitor_jobs SET state='FAILED',updated_at=?,run_id=?,error='monitor_failed'
             WHERE id=?`,
        )
            .bind(timestamp, result.runId, jobId)
            .run();
        return;
    }
    await env.DB.prepare(
        `UPDATE monitor_jobs SET state='SUCCEEDED',updated_at=?,run_id=?,error=NULL WHERE id=?`,
    )
        .bind(timestamp, result.kind === 'COMPLETED' ? result.runId : null, jobId)
        .run();
}

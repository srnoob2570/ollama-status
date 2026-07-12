import { serve } from 'srvx';
import cron from 'node-cron';
import { Pool } from 'pg';
import { drainManualMonitorJobs } from '../worker/monitor-jobs.ts';
import { runMonitor } from '../worker/monitor.ts';
import { PostgresD1Adapter } from './postgres-d1-adapter.ts';
import { buildRunnerEnv } from './env.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const env = buildRunnerEnv(new PostgresD1Adapter(pool));
const ctx = {
    waitUntil(promise: Promise<unknown>) {
        void promise.catch((error: unknown) => console.error('runner background task failed', error));
    },
} as ExecutionContext;

let draining = false;
async function drainQueue(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
        await drainManualMonitorJobs(env, ctx);
    } catch (error) {
        console.error('manual monitor queue failed', error);
    } finally {
        draining = false;
    }
}

cron.schedule(
    '*/5 * * * *',
    async () => {
        const job = await drainManualMonitorJobs(env, ctx);
        if (!job) await runMonitor(env, ctx, Date.now());
    },
    { timezone: 'UTC' },
);
setInterval(drainQueue, 5_000).unref();
void drainQueue();

const health = serve({
    hostname: '127.0.0.1',
    port: Number(process.env.RUNNER_HEALTH_PORT ?? 3001),
    fetch: (request) =>
        new URL(request.url).pathname === '/api/health'
            ? Response.json({ ok: true, role: 'runner' })
            : new Response('Not found', { status: 404 }),
});
await health.ready();
console.log(`ollama-status runner health listening on ${health.url}`);

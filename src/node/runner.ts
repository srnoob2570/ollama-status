import { serve } from 'srvx';
import cron from 'node-cron';
import { drainManualMonitorJobs } from '../worker/monitor-jobs.ts';
import { lastMonitorSettledMs, recoverOrphanedRuns, runMonitor } from '../worker/monitor.ts';
import { PostgresD1Adapter } from './postgres-d1-adapter.ts';
import { createPostgresPool } from './postgres-pool.ts';
import { buildRunnerEnv } from './env.ts';

// A monitor attempt settles every cron interval (5 min) and a legitimate run can take up to one
// interval more, so the gap between settles never legitimately exceeds ~10 min. Past three
// intervals the scheduler has stopped making progress: report it via /api/health (Docker marks
// the container unhealthy), and past four exit outright so `restart: unless-stopped` replaces
// the process — recovery must not depend on someone watching the dashboard. Note a prolonged DB
// outage also trips the watchdog: the periodic restart is harmless there and self-resolves once
// the DB returns.
const HEALTH_STALE_MS = 15 * 60_000;
const WATCHDOG_EXIT_MS = 20 * 60_000;
const bootMs = Date.now();

function schedulerStaleMs(): number {
    return Date.now() - (lastMonitorSettledMs() ?? bootMs);
}

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
const pool = createPostgresPool(process.env.DATABASE_URL);
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
        try {
            const job = await drainManualMonitorJobs(env, ctx);
            if (!job) await runMonitor(env, ctx, Date.now());
        } catch (error) {
            // An uncaught rejection here would kill the process, leaving the open run behind as
            // "monitor stuck" until the container restarts. Log and let the next tick retry.
            console.error('scheduled monitor tick failed', error);
        }
    },
    { timezone: 'UTC' },
);
setInterval(drainQueue, 5_000).unref();
void drainQueue();

// A previous process that died mid-run left its run open ("monitor stuck"); close it now instead
// of waiting for the first cron tick to reclaim the lock. False means the lock is still leased
// and the cron path will recover once it expires.
void recoverOrphanedRuns(env)
    .then((recovered) => {
        if (recovered) console.log('recovered orphaned monitor runs at boot');
    })
    .catch((error: unknown) => console.warn('boot run recovery failed', error));

setInterval(() => {
    if (schedulerStaleMs() > WATCHDOG_EXIT_MS) {
        console.error(
            `no monitor attempt settled in ${Math.round(schedulerStaleMs() / 60_000)} min, exiting for container restart`,
        );
        process.exit(1);
    }
}, 60_000).unref();

const health = serve({
    hostname: '127.0.0.1',
    port: Number(process.env.RUNNER_HEALTH_PORT ?? 3001),
    fetch: (request) => {
        if (new URL(request.url).pathname !== '/api/health')
            return new Response('Not found', { status: 404 });
        const stale = schedulerStaleMs() > HEALTH_STALE_MS;
        return Response.json(
            {
                ok: !stale,
                role: 'runner',
                lastMonitorSettledAt: new Date(
                    lastMonitorSettledMs() ?? bootMs,
                ).toISOString(),
            },
            { status: stale ? 503 : 200 },
        );
    },
});
await health.ready();
console.log(`ollama-status runner health listening on ${health.url}`);

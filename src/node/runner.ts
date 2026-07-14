import { serve } from 'srvx';
import cron from 'node-cron';
import { drainManualMonitorJobs } from '../worker/monitor-jobs.ts';
import { hasRecoverableStuckRun, lastMonitorSettledMs, runMonitor } from '../worker/monitor.ts';
import { PostgresD1Adapter } from './postgres-d1-adapter.ts';
import { createPostgresPool } from './postgres-pool.ts';
import { buildRunnerEnv } from './env.ts';
import type { ExecutionContext } from '../worker/types.ts';
import { startOutboxConsumer } from './outbox-consumer.ts';

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

// Recovery supervisor: a run left open by a dead or wedged owner (crash, lost lease) would
// otherwise wait for the next cron tick to be reclaimed — up to a full extra check cadence of
// missed data. Poll for that state and run the monitor immediately: openRun abandons the orphan
// and the recovery run probes every due model on the spot. The boot invocation covers restarts,
// so recovery latency is bounded by the lock lease plus this poll interval, not by cron.
let supervising = false;
async function superviseMonitor(): Promise<void> {
    if (supervising) return;
    supervising = true;
    try {
        if (!(await hasRecoverableStuckRun(env))) return;
        console.warn('stuck monitor run detected, recovering now');
        const result = await runMonitor(env, ctx, Date.now());
        console.log(`recovery monitor run finished: ${result.kind}`);
    } catch (error) {
        console.error('monitor recovery supervision failed', error);
    } finally {
        supervising = false;
    }
}
setInterval(() => void superviseMonitor(), 30_000).unref();
void superviseMonitor();

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

// ── Outbox consumer ──────────────────────────────────────────────────────────
const db = new PostgresD1Adapter(pool);
const outboxConsumer = startOutboxConsumer(db, {
    consumerId: 'node-1',
    pollIntervalMs: 1_000,
    batchSize: 10,
    onError: (error, event) => {
        console.error(`outbox consumer: error processing ${event.outbox.id} (${event.event.event_type})`, error);
    },
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
    console.log(`received ${signal}, shutting down...`);
    await outboxConsumer.stop();
    await health.close();
    console.log('shutdown complete');
    process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

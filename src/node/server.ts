/**
 * ollama-status web server entrypoint.
 *
 * Sets up the Workers Cache API polyfill (MemoryCache), creates the
 * PostgreSQL-backed D1 adapter, and starts an srvx server that routes
 * `/api/*` requests through the shared worker API layer and serves the
 * built React SPA as a fallback for all other paths.
 */
import { serve } from 'srvx';
import { serveStatic } from 'srvx/static';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { api } from '../worker/api.ts';
import { PostgresD1Adapter } from './postgres-d1-adapter.ts';
import { createPostgresPool } from './postgres-pool.ts';
import { MemoryCache } from './memory-cache.ts';
import { buildWebEnv } from './env.ts';
import { startLiveProgress, type LiveProgressHandle } from './live-progress.ts';
import type { CacheStorage, ExecutionContext } from '../worker/types.ts';

const DIST_DIR = join(import.meta.dirname, '../../dist');

(globalThis as unknown as { caches: CacheStorage }).caches = {
    default: new MemoryCache(),
} as unknown as CacheStorage;

const pool = createPostgresPool(requiredDatabaseUrl());
const env = buildWebEnv(new PostgresD1Adapter(pool));
const liveProgress = startLiveProgress(requiredDatabaseUrl());

function requiredDatabaseUrl(): string {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
    return process.env.DATABASE_URL;
}

async function serveIndexFallback(): Promise<Response> {
    const html = await readFile(join(DIST_DIR, 'index.html'), 'utf8');
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// Pushes monitor_runs updates to the browser the instant Postgres NOTIFYs (see
// migrations/postgres/0010_monitor_progress_notify.sql), instead of waiting on the dashboard's
// 30s poll. One SSE stream per connected browser; `live-progress.ts` fans a single LISTEN
// connection out to all of them.
function monitorStream(request: Request, live: LiveProgressHandle): Response {
    const encoder = new TextEncoder();
    const HEARTBEAT_MS = 20_000;
    let closed = false;
    let unsubscribe: () => void = () => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    function cleanup(): void {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
    }

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const send = (chunk: string) => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    cleanup();
                }
            };
            // Fires EventSource's `onopen` immediately and keeps intermediate proxies (the
            // deployment sits behind a Cloudflare Tunnel) from buffering an empty stream.
            send(': connected\n\n');
            unsubscribe = live.subscribe((payload) => send(`data: ${payload}\n\n`));
            heartbeat = setInterval(() => send(': ping\n\n'), HEARTBEAT_MS);
        },
        cancel: cleanup,
    });
    request.signal.addEventListener('abort', cleanup);

    return new Response(stream, {
        headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive',
        },
    });
}

const server = serve({
    port: Number(process.env.PORT ?? 3000),
    hostname: '0.0.0.0',
    middleware: [
        (request, next) => {
            const url = new URL(request.url);
            if (!url.pathname.startsWith('/api/')) return next();
            if (url.pathname === '/api/v1/monitor/stream')
                return monitorStream(request, liveProgress);
            const ctx = {
                waitUntil: (promise: Promise<unknown>) => {
                    if (request.waitUntil) request.waitUntil(promise);
                    else void promise.catch(console.error);
                },
            } as unknown as ExecutionContext;
            return api(request, env, ctx, url.pathname);
        },
        serveStatic({ dir: DIST_DIR }),
    ],
    fetch: serveIndexFallback,
});

await server.ready();
console.log(`ollama-status web listening on ${server.url}`);

async function shutdown(signal: string): Promise<void> {
    console.log(`received ${signal}, shutting down...`);
    await liveProgress.stop();
    await server.close();
    process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

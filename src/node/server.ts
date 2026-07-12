import { serve } from 'srvx';
import { serveStatic } from 'srvx/static';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import cron from 'node-cron';
import { api } from '../worker/api.ts';
import { runMonitor } from '../worker/monitor.ts';
import { SqliteD1Adapter } from './sqlite-d1-adapter.ts';
import { MemoryCache } from './memory-cache.ts';
import { buildEnv } from './env.ts';

const DIST_DIR = join(import.meta.dirname, '../../dist');

(globalThis as unknown as { caches: CacheStorage }).caches = {
    default: new MemoryCache(),
} as unknown as CacheStorage;

const db = new DatabaseSync(process.env.DB_PATH ?? './data/ollama-status.sqlite');
db.exec('PRAGMA journal_mode = WAL');
const env = buildEnv(new SqliteD1Adapter(db));

async function serveIndexFallback(): Promise<Response> {
    const html = await readFile(join(DIST_DIR, 'index.html'), 'utf8');
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

const server = serve({
    port: Number(process.env.PORT ?? 3000),
    hostname: '0.0.0.0',
    middleware: [
        (request, next) => {
            const url = new URL(request.url);
            if (!url.pathname.startsWith('/api/')) return next();
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

const cronCtx = {
    waitUntil: (promise: Promise<unknown>) => {
        void promise.catch((error: unknown) => console.error('monitor error', error));
    },
} as unknown as ExecutionContext;

cron.schedule('*/5 * * * *', () => runMonitor(env, cronCtx, Date.now()), { timezone: 'UTC' });

await server.ready();
console.log(`ollama-status (node) listening on ${server.url}`);

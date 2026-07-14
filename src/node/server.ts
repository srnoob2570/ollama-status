import { serve } from 'srvx';
import { serveStatic } from 'srvx/static';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { api } from '../worker/api.ts';
import { PostgresD1Adapter } from './postgres-d1-adapter.ts';
import { createPostgresPool } from './postgres-pool.ts';
import { MemoryCache } from './memory-cache.ts';
import { buildWebEnv } from './env.ts';
import type { CacheStorage, ExecutionContext } from '../worker/types.ts';

const DIST_DIR = join(import.meta.dirname, '../../dist');

(globalThis as unknown as { caches: CacheStorage }).caches = {
    default: new MemoryCache(),
} as unknown as CacheStorage;

const pool = createPostgresPool(requiredDatabaseUrl());
const env = buildWebEnv(new PostgresD1Adapter(pool));

function requiredDatabaseUrl(): string {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
    return process.env.DATABASE_URL;
}

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

await server.ready();
console.log(`ollama-status web listening on ${server.url}`);

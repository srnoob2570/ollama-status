import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { SqliteD1Adapter } from '../src/node/sqlite-d1-adapter.ts';
import { MemoryCache } from '../src/node/memory-cache.ts';
import { runMonitor } from '../src/worker/monitor.ts';
import { api } from '../src/worker/api.ts';
import type { Env } from '../src/worker/types.ts';

function migratedDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort())
        db.exec(readFileSync(`migrations/${file}`, 'utf8'));
    return db;
}

describe('node:sqlite D1 adapter parity', () => {
    it('runs a full monitor cycle and serves the public API', async () => {
        const env = {
            DB: new SqliteD1Adapter(migratedDb()),
            OLLAMA_BASE_URL: 'https://example.test/api',
            OLLAMA_API_KEY_FREE: 'k',
            OLLAMA_API_KEY_PAID: 'pk',
        } as unknown as Env;
        (globalThis as unknown as { caches: CacheStorage }).caches = {
            default: new MemoryCache(),
        } as unknown as CacheStorage;
        const ctx = { waitUntil(p: Promise<unknown>) { void p; } } as unknown as ExecutionContext;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/tags'))
                return new Response(JSON.stringify({ models: [{ name: 'm', digest: 'd' }] }));
            if (url.endsWith('/show')) return new Response('{}');
            return new Response('{"model":"m","message":{"content":"OK"},"done":true}\n');
        }) as typeof fetch;
        try {
            await runMonitor(env, ctx, Date.now());
        } finally {
            globalThis.fetch = originalFetch;
        }
        const res = await api(new Request('http://localhost/api/v1/status'), env, ctx, '/api/v1/status');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { models: unknown[] };
        expect(body.models).toHaveLength(1);
    });
});

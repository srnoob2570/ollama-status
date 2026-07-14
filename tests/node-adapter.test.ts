import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { SqliteD1Adapter } from '../src/node/sqlite-d1-adapter.ts';
import { MemoryCache } from '../src/node/memory-cache.ts';
import { runMonitor } from '../src/worker/monitor.ts';
import { drainManualMonitorJobs } from '../src/worker/monitor-jobs.ts';
import { api } from '../src/worker/api.ts';
import type { CacheStorage, Env, ExecutionContext } from '../src/worker/types.ts';

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
        globalThis.fetch = (async (input: Request | URL | string) => {
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

    it('runs a manual cycle through the shared API without probing models before their cadence', async () => {
        const secret = 'monitor-test-secret';
        const env = {
            DB: new SqliteD1Adapter(migratedDb()),
            OLLAMA_BASE_URL: 'https://example.test/api',
            OLLAMA_API_KEY_FREE: 'k',
            OLLAMA_API_KEY_PAID: 'pk',
            CONFIRMATION_HMAC_SECRET: secret,
            PROBE_DELAY_MIN_MS: '0',
            PROBE_DELAY_MAX_MS: '0',
        } as unknown as Env;
        (globalThis as unknown as { caches: CacheStorage }).caches = {
            default: new MemoryCache(),
        } as unknown as CacheStorage;
        // Module-level provider seeding has already run in the preceding parity test, while this
        // deliberately uses a fresh SQLite database.
        await env.DB.prepare(
            "INSERT INTO providers (id,name,kind,base_url,secret_ref,created_at) VALUES (?,?,'ollama',?,?,?)",
        )
            .bind(
                'ollama-free',
                'Free',
                env.OLLAMA_BASE_URL,
                'OLLAMA_API_KEY_FREE',
                new Date().toISOString(),
            )
            .run();
        await env.DB.prepare(
            "INSERT INTO providers (id,name,kind,base_url,secret_ref,created_at) VALUES (?,?,'ollama',?,?,?)",
        )
            .bind(
                'ollama-paid',
                'Paid',
                env.OLLAMA_BASE_URL,
                'OLLAMA_API_KEY_PAID',
                new Date().toISOString(),
            )
            .run();
        const ctx = {
            waitUntil(p: Promise<unknown>) {
                void p;
            },
        } as unknown as ExecutionContext;
        let probeCalls = 0;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (input: Request | URL | string) => {
            const url = String(input);
            if (url.endsWith('/tags'))
                return new Response(JSON.stringify({ models: [{ name: 'm', digest: 'd' }] }));
            if (url.endsWith('/show')) return new Response('{}');
            probeCalls++;
            return new Response('{"model":"m","message":{"content":"OK"},"done":true}\n');
        }) as typeof fetch;
        try {
            await runMonitor(env, ctx, Date.now());
            probeCalls = 0;
            const raw = JSON.stringify({ timestamp: Math.floor(Date.now() / 1_000) });
            const signature = createHmac('sha256', secret).update(raw).digest('hex');
            const response = await api(
                new Request('http://localhost/api/internal/monitor-run', {
                    method: 'POST',
                    headers: { 'x-monitor-signature': signature },
                    body: raw,
                }),
                env,
                ctx,
                '/api/internal/monitor-run',
            );

            expect(response.status).toBe(202);
            await expect(response.json()).resolves.toMatchObject({ state: 'QUEUED' });
            await drainManualMonitorJobs(env, ctx);
            expect(probeCalls).toBe(0);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

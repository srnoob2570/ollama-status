import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { SqliteD1Adapter } from '../src/node/sqlite-d1-adapter.ts';
import { MemoryCache } from '../src/node/memory-cache.ts';
import { runMonitor } from '../src/worker/monitor.ts';
import { drainManualMonitorJobs } from '../src/worker/monitor-jobs.ts';
import { api } from '../src/worker/api.ts';
import {
    createTestDb,
    seedModel,
    seedExpectation,
    seedMonitorRun,
    seedExecution,
} from './helpers/ledger-fixture.ts';
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
        const body = (await res.json()) as { models: unknown[]; paidKeyConfigured: boolean };
        expect(body.models).toHaveLength(1);
        expect(body.paidKeyConfigured).toBe(true);
    });

    it('reports paidKeyConfigured false when OLLAMA_API_KEY_PAID is unset', async () => {
        const db = new SqliteD1Adapter(migratedDb());
        // Module-level provider seeding (providersSeeded flag) has already run in the preceding
        // parity test, so this fresh database needs providers inserted by hand — same pattern as
        // the manual-cycle and recovery tests below.
        await db
            .prepare(
                "INSERT INTO providers (id,name,kind,base_url,secret_ref,created_at) VALUES (?,?,'ollama',?,?,?)",
            )
            .bind('ollama-free', 'Free', 'https://example.test/api', 'OLLAMA_API_KEY_FREE', new Date().toISOString())
            .run();
        await db
            .prepare(
                "INSERT INTO providers (id,name,kind,base_url,secret_ref,created_at) VALUES (?,?,'ollama',?,?,?)",
            )
            .bind('ollama-paid', 'Paid', 'https://example.test/api', 'OLLAMA_API_KEY_PAID', new Date().toISOString())
            .run();
        const env = {
            DB: db,
            OLLAMA_BASE_URL: 'https://example.test/api',
            OLLAMA_API_KEY_FREE: 'k',
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
        const body = (await res.json()) as { paidKeyConfigured: boolean };
        expect(body.paidKeyConfigured).toBe(false);
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

    it('recovers a crashed run without wedging the expectation on uq_model_check_executions_expectation_id', async () => {
        // Reproduces a real production failure: a run left open by a dead/wedged owner (crash,
        // container restart) has a SCHEDULED execution tied to an expectation that never got
        // resolved. Before the fix, abandoning that run left the expectation SCHEDULED, so the
        // very next run's scheduling pass re-selected it and tried to insert a second execution
        // for the same expectation_id, violating uq_model_check_executions_expectation_id and
        // failing every run thereafter.
        const db = createTestDb();
        // Module-level provider seeding may have already run in a preceding test in this file,
        // while this deliberately uses a fresh SQLite database (see the manual-cycle test above).
        await db
            .prepare(
                "INSERT INTO providers (id,name,kind,base_url,secret_ref,created_at) VALUES (?,?,'ollama',?,?,?)",
            )
            .bind('ollama-free', 'Free', 'https://example.test/api', 'OLLAMA_API_KEY_FREE', new Date().toISOString())
            .run();
        await db
            .prepare(
                "INSERT INTO providers (id,name,kind,base_url,secret_ref,created_at) VALUES (?,?,'ollama',?,?,?)",
            )
            .bind('ollama-paid', 'Paid', 'https://example.test/api', 'OLLAMA_API_KEY_PAID', new Date().toISOString())
            .run();
        const model = await seedModel(db, { provider_id: 'ollama-free', remote_name: 'stuck-model', tier: 'FREE' });
        const dueAt = new Date(Date.now() - 60_000).toISOString();
        const expectation = await seedExpectation(db, {
            model_id: model.id,
            due_at: dueAt,
            deadline_at: new Date(Date.now() + 5 * 60_000).toISOString(),
            tier: 'FREE',
            state: 'SCHEDULED',
        });
        const orphanRun = await seedMonitorRun(db, {
            started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        });
        await seedExecution(db, {
            run_id: orphanRun.id,
            model_id: model.id,
            expectation_id: expectation.id,
            due_at: dueAt,
            scheduled_at: orphanRun.started_at,
            tier: 'FREE',
            state: 'SCHEDULED',
        });

        const env = {
            DB: db,
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
                return new Response(JSON.stringify({ models: [{ name: model.remote_name, digest: 'd' }] }));
            if (url.endsWith('/show')) return new Response('{}');
            return new Response(`{"model":"${model.remote_name}","message":{"content":"OK"},"done":true}\n`);
        }) as typeof fetch;

        let result;
        try {
            result = await runMonitor(env, ctx, Date.now());
        } finally {
            globalThis.fetch = originalFetch;
        }

        expect(result.kind).toBe('COMPLETED');

        const resolved = await db
            .prepare('SELECT state FROM model_check_expectations WHERE id=?')
            .bind(expectation.id)
            .first<{ state: string }>();
        expect(resolved?.state).toBe('MISSED');

        const executionCount = await db
            .prepare('SELECT COUNT(*) as count FROM model_check_executions WHERE expectation_id=?')
            .bind(expectation.id)
            .first<{ count: number }>();
        expect(executionCount?.count).toBe(1);
    });

    it('admits only the oldest of several due expectations for the same model in one run', async () => {
        // A backlog (e.g. the runner was down longer than one cadence interval) can leave a model
        // with more than one due-and-unresolved expectation at once. model_check_executions has a
        // UNIQUE(run_id, model_id) constraint, so scheduling both in the same run would crash the
        // whole batch — scheduleDueExecutions must admit only the oldest and suppress the rest.
        const db = createTestDb();
        await db
            .prepare(
                "INSERT INTO providers (id,name,kind,base_url,secret_ref,created_at) VALUES (?,?,'ollama',?,?,?)",
            )
            .bind('ollama-free', 'Free', 'https://example.test/api', 'OLLAMA_API_KEY_FREE', new Date().toISOString())
            .run();
        await db
            .prepare(
                "INSERT INTO providers (id,name,kind,base_url,secret_ref,created_at) VALUES (?,?,'ollama',?,?,?)",
            )
            .bind('ollama-paid', 'Paid', 'https://example.test/api', 'OLLAMA_API_KEY_PAID', new Date().toISOString())
            .run();
        const model = await seedModel(db, { provider_id: 'ollama-free', remote_name: 'backlogged-model', tier: 'FREE' });
        const olderExpectation = await seedExpectation(db, {
            model_id: model.id,
            due_at: new Date(Date.now() - 10 * 60_000).toISOString(),
            deadline_at: new Date(Date.now() + 5 * 60_000).toISOString(),
            tier: 'FREE',
            state: 'EXPECTED',
        });
        const newerExpectation = await seedExpectation(db, {
            model_id: model.id,
            due_at: new Date(Date.now() - 5 * 60_000).toISOString(),
            deadline_at: new Date(Date.now() + 5 * 60_000).toISOString(),
            tier: 'FREE',
            state: 'EXPECTED',
        });

        const env = {
            DB: db,
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
                return new Response(JSON.stringify({ models: [{ name: model.remote_name, digest: 'd' }] }));
            if (url.endsWith('/show')) return new Response('{}');
            return new Response(`{"model":"${model.remote_name}","message":{"content":"OK"},"done":true}\n`);
        }) as typeof fetch;

        let result;
        try {
            result = await runMonitor(env, ctx, Date.now());
        } finally {
            globalThis.fetch = originalFetch;
        }

        expect(result.kind).toBe('COMPLETED');

        const older = await db
            .prepare('SELECT state FROM model_check_expectations WHERE id=?')
            .bind(olderExpectation.id)
            .first<{ state: string }>();
        expect(older?.state).toBe('SATISFIED');

        const newer = await db
            .prepare('SELECT state, reason_code FROM model_check_expectations WHERE id=?')
            .bind(newerExpectation.id)
            .first<{ state: string; reason_code: string }>();
        expect(newer?.state).toBe('SUPPRESSED');
        expect(newer?.reason_code).toBe('selection_limit');

        const executionCount = await db
            .prepare('SELECT COUNT(*) as count FROM model_check_executions WHERE model_id=?')
            .bind(model.id)
            .first<{ count: number }>();
        expect(executionCount?.count).toBe(1);
    });
});

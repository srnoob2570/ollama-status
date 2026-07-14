import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { SqliteD1Adapter } from '../../src/node/sqlite-d1-adapter.ts';
import type { D1DatabaseLike } from '../../src/worker/types.ts';

// ── DB creation ──────────────────────────────────────────────────────────────

export function createTestDb(): D1DatabaseLike {
    const db = new DatabaseSync(':memory:');
    for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort())
        db.exec(readFileSync(`migrations/${file}`, 'utf8'));
    return new SqliteD1Adapter(db);
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

export async function seedProvider(
    db: D1DatabaseLike,
    overrides: Partial<{
        id: string;
        name: string;
        base_url: string;
        secret_ref: string;
        created_at: string;
    }> = {},
): Promise<{ id: string; name: string; base_url: string; secret_ref: string }> {
    const id = overrides.id ?? `prov_${crypto.randomUUID()}`;
    const name = overrides.name ?? 'test-provider';
    const base_url = overrides.base_url ?? 'https://test.example';
    const secret_ref = overrides.secret_ref ?? 'OLLAMA_API_KEY_FREE';
    const created_at = overrides.created_at ?? new Date().toISOString();

    await db
        .prepare(
            `INSERT INTO providers (id, name, kind, base_url, secret_ref, active, catalog_status, catalog_checked_at, created_at)
             VALUES (?, ?, 'ollama', ?, ?, 1, 'UNKNOWN', ?, ?)`,
        )
        .bind(id, name, base_url, secret_ref, created_at, created_at)
        .run();

    return { id, name, base_url, secret_ref };
}

export async function seedModel(
    db: D1DatabaseLike,
    overrides: Partial<{
        id: string;
        provider_id: string;
        remote_name: string;
        digest: string;
        tier: string;
        created_at: string;
        updated_at: string;
    }> = {},
): Promise<{ id: string; provider_id: string; remote_name: string; tier: string }> {
    const id = overrides.id ?? `model_${crypto.randomUUID()}`;
    const provider_id = overrides.provider_id ?? (await seedProvider(db)).id;
    const remote_name = overrides.remote_name ?? 'test-model';
    const digest = overrides.digest ?? null;
    const tier = overrides.tier ?? 'FREE';
    const now = overrides.created_at ?? new Date().toISOString();
    const updated_at = overrides.updated_at ?? now;

    await db
        .prepare(
            `INSERT INTO models (id, provider_id, remote_name, active, excluded, digest, created_at, updated_at, tier)
             VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?)`,
        )
        .bind(id, provider_id, remote_name, digest, now, updated_at, tier)
        .run();

    return { id, provider_id, remote_name, tier };
}

export async function seedMonitorRun(
    db: D1DatabaseLike,
    overrides: Partial<{
        id: string;
        started_at: string;
    }> = {},
): Promise<{ id: string; started_at: string }> {
    const id = overrides.id ?? `run_${crypto.randomUUID()}`;
    const started_at = overrides.started_at ?? new Date().toISOString();

    await db
        .prepare(`INSERT INTO monitor_runs (id, started_at) VALUES (?, ?)`)
        .bind(id, started_at)
        .run();

    return { id, started_at };
}

export async function seedExpectation(
    db: D1DatabaseLike,
    overrides: Partial<{
        id: string;
        model_id: string;
        purpose: string;
        due_at: string;
        deadline_at: string;
        tier: string;
        interval_minutes: number;
        state: string;
        reason_code: string | null;
        cutover_at: string;
    }> = {},
): Promise<{ id: string; model_id: string; purpose: string; due_at: string; tier: string; state: string }> {
    const id = overrides.id ?? `expect_${crypto.randomUUID()}`;
    const model_id = overrides.model_id ?? (await seedModel(db)).id;
    const purpose = overrides.purpose ?? 'AVAILABILITY';
    const now = new Date().toISOString();
    const due_at = overrides.due_at ?? now;
    const deadline_at = overrides.deadline_at ?? due_at;
    const tier = overrides.tier ?? 'FREE';
    const interval_minutes = overrides.interval_minutes ?? 5;
    const state = overrides.state ?? 'EXPECTED';
    const reason_code = overrides.reason_code ?? null;
    const cutover_at = overrides.cutover_at ?? now;

    await db
        .prepare(
            `INSERT INTO model_check_expectations
             (id, model_id, purpose, due_at, deadline_at, tier, interval_minutes, state, reason_code, cutover_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, model_id, purpose, due_at, deadline_at, tier, interval_minutes, state, reason_code, cutover_at)
        .run();

    return { id, model_id, purpose, due_at, tier, state };
}

export async function seedAttempt(
    db: D1DatabaseLike,
    overrides: Partial<{
        id: string;
        run_id: string;
        model_id: string;
        attempt_no: number;
        provider_id: string;
        state: string;
    }> = {},
): Promise<{ id: string; run_id: string; model_id: string; attempt_no: number; provider_id: string; state: string }> {
    const id = overrides.id ?? `attempt_${crypto.randomUUID()}`;
    const run_id = overrides.run_id ?? (await seedMonitorRun(db)).id;
    const model_id = overrides.model_id ?? (await seedModel(db)).id;
    const attempt_no = overrides.attempt_no ?? 1;
    const provider_id = overrides.provider_id ?? (await seedProvider(db)).id;
    const state = overrides.state ?? 'LEASED';

    await db
        .prepare(
            `INSERT INTO probe_attempts
             (id, run_id, model_id, attempt_no, provider_id, state)
             VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, run_id, model_id, attempt_no, provider_id, state)
        .run();

    return { id, run_id, model_id, attempt_no, provider_id, state };
}

export async function seedTick(
    db: D1DatabaseLike,
    overrides: Partial<{
        id: string;
        tick_key: string;
        scheduled_at: string;
        trigger: string;
        state: string;
    }> = {},
): Promise<{ id: string; tick_key: string; scheduled_at: string; trigger: string; state: string }> {
    const id = overrides.id ?? `tick_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const tick_key = overrides.tick_key ?? `cron:${now}`;
    const scheduled_at = overrides.scheduled_at ?? now;
    const trigger = overrides.trigger ?? 'CRON';
    const state = overrides.state ?? 'RECEIVED';

    await db
        .prepare(
            `INSERT INTO scheduler_ticks (id, tick_key, scheduled_at, trigger, state)
             VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(id, tick_key, scheduled_at, trigger, state)
        .run();

    return { id, tick_key, scheduled_at, trigger, state };
}

export async function seedExecution(
    db: D1DatabaseLike,
    overrides: Partial<{
        id: string;
        run_id: string;
        model_id: string;
        tier: string;
        interval_minutes: number;
        scheduled_at: string;
        state: string;
        expectation_id: string;
        purpose: string;
        due_at: string;
    }> = {},
): Promise<{ id: string; run_id: string; model_id: string; expectation_id: string | null }> {
    const id = overrides.id ?? `exec_${crypto.randomUUID()}`;
    const run_id = overrides.run_id ?? (await seedMonitorRun(db)).id;
    const model_id = overrides.model_id ?? (await seedModel(db)).id;
    const tier = overrides.tier ?? 'FREE';
    const interval_minutes = overrides.interval_minutes ?? 5;
    const now = new Date().toISOString();
    const scheduled_at = overrides.scheduled_at ?? now;
    const state = overrides.state ?? 'SCHEDULED';
    const expectation_id = overrides.expectation_id ?? (await seedExpectation(db, { model_id })).id;
    const purpose = overrides.purpose ?? 'AVAILABILITY';
    const due_at = overrides.due_at ?? scheduled_at;

    await db
        .prepare(
            `INSERT INTO model_check_executions
             (id, run_id, model_id, tier, interval_minutes, scheduled_at, state,
              expectation_id, purpose, due_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, run_id, model_id, tier, interval_minutes, scheduled_at, state, expectation_id, purpose, due_at)
        .run();

    return { id, run_id, model_id, expectation_id };
}

// ── Assert helpers ──────────────────────────────────────────────────────────

export async function assertProbeEvent(
    db: D1DatabaseLike,
    eventType: string,
    expectedFields: Record<string, unknown>,
): Promise<void> {
    const row = await db
        .prepare(
            `SELECT * FROM probe_events WHERE event_type = ? ORDER BY recorded_at DESC LIMIT 1`,
        )
        .bind(eventType)
        .first<Record<string, unknown>>();

    if (!row) throw new Error(`No probe_event found with event_type = '${eventType}'`);

    for (const [key, expected] of Object.entries(expectedFields)) {
        if (key === 'detail_json' && typeof expected === 'object' && expected !== null) {
            const parsed = JSON.parse(row.detail_json as string);
            for (const [dk, dv] of Object.entries(expected)) {
                if (parsed[dk] !== dv)
                    throw new Error(
                        `detail_json.${dk} mismatch: expected ${JSON.stringify(dv)}, got ${JSON.stringify(parsed[dk])}`,
                    );
            }
        } else {
            const actual = row[key];
            if (actual !== expected)
                throw new Error(
                    `probe_event.${key} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
                );
        }
    }
}

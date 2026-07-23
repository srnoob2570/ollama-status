/* global console, process, setTimeout, clearTimeout */

import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { PostgresD1Adapter } from '../src/node/postgres-d1-adapter.ts';
import { createPostgresPool } from '../src/node/postgres-pool.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required (use a dedicated disposable database)');
const execFile = promisify(execFileCallback);

await execFile(process.execPath, ['scripts/migrate-node.mjs'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
});

const pool = createPostgresPool(databaseUrl);
const db = new PostgresD1Adapter(pool);
const lockName = `postgres-parity-${randomUUID()}`;
const runId = `run_test_${randomUUID()}`;
const listener = new Client({ connectionString: databaseUrl });
try {
    await db.batch([
        db.prepare('INSERT INTO scheduler_locks(name,lease_until,owner,updated_at) VALUES (?,?,?,?)').bind(
            lockName,
            '2099-01-01T00:00:00.000Z',
            'postgres-test',
            new Date().toISOString(),
        ),
        db.prepare('UPDATE scheduler_locks SET owner=? WHERE name=?').bind('updated', lockName),
    ]);
    const lock = await db
        .prepare("SELECT owner FROM scheduler_locks WHERE name=? AND owner='updated'")
        .bind(lockName)
        .first();
    if (!lock) throw new Error('PostgreSQL placeholder or transaction parity failed');
    console.log('PostgreSQL migration, placeholder, and transaction parity passed');

    // ── monitor_progress NOTIFY trigger (migrations/postgres/0010) ──────────────
    await listener.connect();
    await listener.query('LISTEN monitor_progress');
    const notified = new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error('monitor_progress NOTIFY did not arrive within 5s of the INSERT')),
            5_000,
        );
        listener.once('notification', (message) => {
            clearTimeout(timeout);
            resolve(message.payload);
        });
    });
    await db
        .prepare('INSERT INTO monitor_runs(id, started_at) VALUES (?, ?)')
        .bind(runId, new Date().toISOString())
        .run();
    const payload = JSON.parse(await notified);
    if (payload.id !== runId) throw new Error('monitor_progress NOTIFY payload did not match the inserted run');
    console.log('monitor_progress NOTIFY trigger passed');
} finally {
    await listener.end().catch(() => undefined);
    await db.prepare('DELETE FROM monitor_runs WHERE id=?').bind(runId).run();
    await db.prepare('DELETE FROM scheduler_locks WHERE name=?').bind(lockName).run();
    await pool.end();
}

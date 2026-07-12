/* global console, process */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool } from '../src/node/postgres-pool.ts';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(rootDir, 'migrations', 'postgres');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = createPostgresPool(process.env.DATABASE_URL);
const client = await pool.connect();

try {
    await client.query("SELECT pg_advisory_lock(hashtext('ollama-status-migrations'))");
    await client.query(
        'CREATE TABLE IF NOT EXISTS _migrations_applied (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );

    const applied = new Set(
        (await client.query('SELECT name FROM _migrations_applied')).rows.map((row) => row.name),
    );

    const files = readdirSync(migrationsDir)
        .filter((file) => file.endsWith('.sql'))
        .sort();

    for (const file of files) {
        if (applied.has(file)) continue;
        const sql = readFileSync(join(migrationsDir, file), 'utf8');
        await client.query('BEGIN');
        try {
            await client.query(sql);
            await client.query('INSERT INTO _migrations_applied (name, applied_at) VALUES ($1, $2)', [
                file,
                new Date().toISOString(),
            ]);
            await client.query('COMMIT');
            console.log(`applied ${file}`);
        } catch (error) {
            await client.query('ROLLBACK');
            throw new Error(`migration ${file} failed: ${error.message}`);
        }
    }
} finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('ollama-status-migrations'))").catch(() => undefined);
    client.release();
    await pool.end();
}

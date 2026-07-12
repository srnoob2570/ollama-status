import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(rootDir, 'migrations');
const dbPath = process.env.DB_PATH ?? join(rootDir, 'data', 'ollama-status.sqlite');

if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations_applied (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
);

const applied = new Set(
    db.prepare('SELECT name FROM _migrations_applied').all().map((row) => row.name),
);

const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    db.exec('BEGIN');
    try {
        db.exec(sql);
        db.prepare('INSERT INTO _migrations_applied (name, applied_at) VALUES (?, ?)').run(
            file,
            new Date().toISOString(),
        );
        db.exec('COMMIT');
        console.log(`applied ${file}`);
    } catch (error) {
        db.exec('ROLLBACK');
        throw new Error(`migration ${file} failed: ${error.message}`);
    }
}

db.close();

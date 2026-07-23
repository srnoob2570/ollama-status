import type { DatabaseSync } from 'node:sqlite';
import type { D1DatabaseLike, D1StatementLike } from '../worker/types.ts';
import { normalizeBindValue } from './d1-bind-normalize.ts';

/**
 * D1DatabaseLike adapter backed by `node:sqlite`.
 *
 * Used for lightweight local testing where PostgreSQL is unavailable.
 * The `batch()` method wraps statements in a BEGIN/COMMIT/ROLLBACK
 * transaction. Parameter normalization handles `undefined` → `null` and
 * `boolean` → `0`/`1` coercion for compatibility with D1 semantics.
 */

class SqliteStatement implements D1StatementLike {
    private readonly db: DatabaseSync;
    private readonly sql: string;
    private readonly params: unknown[];

    constructor(db: DatabaseSync, sql: string, params: unknown[] = []) {
        this.db = db;
        this.sql = sql;
        this.params = params;
    }

    bind(...values: unknown[]): D1StatementLike {
        return new SqliteStatement(this.db, this.sql, values.map(normalizeBindValue));
    }

    async run(): Promise<{ meta: { changes: number } }> {
        const result = this.db.prepare(this.sql).run(...(this.params as never[]));
        return { meta: { changes: Number(result.changes) } };
    }

    async all<T = unknown>(): Promise<{ results: T[] }> {
        const rows = this.db.prepare(this.sql).all(...(this.params as never[]));
        return { results: rows as T[] };
    }

    async first<T = unknown>(): Promise<T | null> {
        const row = this.db.prepare(this.sql).get(...(this.params as never[]));
        return (row ?? null) as T | null;
    }
}

export class SqliteD1Adapter implements D1DatabaseLike {
    private readonly db: DatabaseSync;

    constructor(db: DatabaseSync) {
        this.db = db;
    }

    prepare(sql: string): D1StatementLike {
        return new SqliteStatement(this.db, sql);
    }

    async batch(statements: D1StatementLike[]): Promise<{ meta: { changes: number } }[]> {
        const results: { meta: { changes: number } }[] = [];
        this.db.exec('BEGIN');
        try {
            for (const statement of statements) results.push(await statement.run());
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
        return results;
    }
}

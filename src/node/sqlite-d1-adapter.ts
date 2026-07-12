import type { DatabaseSync } from 'node:sqlite';
import type { D1DatabaseLike, D1StatementLike } from '../worker/types.ts';

// node:sqlite throws a TypeError on `undefined`/`boolean` bound params, where D1/SQLite accept
// them (undefined behaves like omitted, boolean coerces to 0/1). Normalizing here means a
// `.bind()` call that forgets `?? null` breaks identically on both targets instead of only here.
function normalize(value: unknown): unknown {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
}

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
        return new SqliteStatement(this.db, this.sql, values.map(normalize));
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

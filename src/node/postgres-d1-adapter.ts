import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { D1DatabaseLike, D1StatementLike } from '../worker/types.ts';

function normalize(value: unknown): unknown {
    if (value === undefined) return null;
    return value;
}

/**
 * Translate D1-style positional parameters (`?`) to PostgreSQL positional
 * parameters (`$1`, `$2`, ...).
 *
 * Respects single- and double-quoted literals so that SQL like
 * `state='RUNNING'` passes through unchanged. Parameter tokens inside quoted
 * strings are left as-is.
 */
export function postgresQuery(sql: string): string {
    let parameter = 0;
    let quote: "'" | '"' | null = null;
    let result = '';
    for (let index = 0; index < sql.length; index += 1) {
        const char = sql[index];
        if (quote) {
            result += char;
            if (char === quote) {
                if (sql[index + 1] === quote) result += sql[++index];
                else quote = null;
            }
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            result += char;
        } else if (char === '?') result += `$${++parameter}`;
        else result += char;
    }
    return result;
}

/**
 * D1StatementLike implementation backed by a pg.Pool.
 *
 * Each call to `bind()` creates a new statement instance with the given
 * parameters. Pool-level execution is used for `run()`, `all()`, and
 * `first()`; transactional execution via `execute(client)` is used by the
 * adapter's `batch()` method.
 */
class PostgresStatement implements D1StatementLike {
    private readonly pool: Pool;
    private readonly sql: string;
    private readonly params: unknown[];

    constructor(pool: Pool, sql: string, params: unknown[] = []) {
        this.pool = pool;
        this.sql = sql;
        this.params = params;
    }

    bind(...values: unknown[]): D1StatementLike {
        return new PostgresStatement(this.pool, this.sql, values.map(normalize));
    }

    async execute(client: Pool | PoolClient): Promise<{ rows: QueryResultRow[]; changes: number }> {
        const result = await client.query(postgresQuery(this.sql), this.params);
        return { rows: result.rows, changes: result.rowCount ?? 0 };
    }

    async run(): Promise<{ meta: { changes: number } }> {
        const result = await this.execute(this.pool);
        return { meta: { changes: result.changes } };
    }

    async all<T = unknown>(): Promise<{ results: T[] }> {
        const result = await this.execute(this.pool);
        return { results: result.rows as T[] };
    }

    async first<T = unknown>(): Promise<T | null> {
        const result = await this.execute(this.pool);
        return (result.rows[0] ?? null) as T | null;
    }
}

/**
 * D1DatabaseLike adapter backed by a pg.Pool.
 *
 * Translates D1's `?`-parameter SQL to PostgreSQL `$N` syntax for every
 * statement. The `batch()` method wraps statements in a BEGIN/COMMIT
 * transaction with ROLLBACK on error.
 */
export class PostgresD1Adapter implements D1DatabaseLike {
    private readonly pool: Pool;

    constructor(pool: Pool) {
        this.pool = pool;
    }

    prepare(sql: string): D1StatementLike {
        return new PostgresStatement(this.pool, sql);
    }

    async batch(statements: D1StatementLike[]): Promise<{ meta: { changes: number } }[]> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const results = [];
            for (const statement of statements) {
                if (!(statement instanceof PostgresStatement))
                    throw new Error('Postgres batch received a statement from another database');
                const result = await statement.execute(client);
                results.push({ meta: { changes: result.changes } });
            }
            await client.query('COMMIT');
            return results;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }
}

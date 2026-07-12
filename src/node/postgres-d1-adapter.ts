import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { D1DatabaseLike, D1StatementLike } from '../worker/types.ts';

function normalize(value: unknown): unknown {
    if (value === undefined) return null;
    return value;
}

// Worker SQL uses D1's positional `?` parameters. Translate only parameter tokens, leaving
// quoted literals intact so SQL such as `state='RUNNING'` is passed to PostgreSQL unchanged.
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

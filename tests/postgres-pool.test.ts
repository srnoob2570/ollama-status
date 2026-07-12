import { describe, expect, it } from 'vitest';
import { postgresPoolConfig } from '../src/node/postgres-pool.ts';

describe('PostgreSQL SSL configuration', () => {
    it('preserves libpq require semantics for a self-signed certificate', () => {
        expect(
            postgresPoolConfig('postgres://user:password@postgres:5432/app?sslmode=require'),
        ).toEqual({
            connectionString: 'postgres://user:password@postgres:5432/app',
            ssl: { rejectUnauthorized: false },
        });
    });

    it('does not weaken verification for other SSL modes', () => {
        expect(
            postgresPoolConfig('postgres://user:password@postgres:5432/app?sslmode=verify-full'),
        ).toEqual({
            connectionString: 'postgres://user:password@postgres:5432/app?sslmode=verify-full',
        });
    });
});

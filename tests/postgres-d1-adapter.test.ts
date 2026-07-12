import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PostgresD1Adapter, postgresQuery } from '../src/node/postgres-d1-adapter.ts';

describe('PostgreSQL D1 adapter', () => {
    it('translates D1 placeholders without touching quoted SQL literals', () => {
        expect(postgresQuery("UPDATE jobs SET state='RUNNING' WHERE id=? AND note='?'"))
            .toBe("UPDATE jobs SET state='RUNNING' WHERE id=$1 AND note='?'");
    });

    it('reserves one client for every batch transaction', async () => {
        const poolCalls: string[] = [];
        const clientCalls: string[] = [];
        const client = {
            async query(sql: string) {
                clientCalls.push(sql);
                return { rows: [], rowCount: 1 };
            },
            release() {},
        };
        const pool = {
            async query(sql: string) {
                poolCalls.push(sql);
                return { rows: [], rowCount: 1 };
            },
            async connect() {
                return client;
            },
        } as unknown as Pool;
        const db = new PostgresD1Adapter(pool);

        await db.batch([
            db.prepare('INSERT INTO jobs(id, state) VALUES (?,?)').bind('job_1', 'QUEUED'),
            db.prepare('UPDATE jobs SET state=? WHERE id=?').bind('RUNNING', 'job_1'),
        ]);

        expect(poolCalls).toEqual([]);
        expect(clientCalls).toEqual([
            'BEGIN',
            'INSERT INTO jobs(id, state) VALUES ($1,$2)',
            'UPDATE jobs SET state=$1 WHERE id=$2',
            'COMMIT',
        ]);
    });
});

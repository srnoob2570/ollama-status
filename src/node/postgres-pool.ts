import { Pool, type PoolConfig } from 'pg';

// pg-connection-string currently treats `sslmode=require` as `verify-full`, while libpq's
// documented `require` mode encrypts the connection without validating a self-signed CA. Keep
// that compatibility explicitly so Coolify's self-signed PostgreSQL certificate still uses TLS.
export function postgresPoolConfig(connectionString: string): PoolConfig {
    const url = new URL(connectionString);
    if (url.searchParams.get('sslmode') !== 'require') return { connectionString };

    url.searchParams.delete('sslmode');
    url.searchParams.delete('uselibpqcompat');
    return {
        connectionString: url.toString(),
        ssl: { rejectUnauthorized: false },
    };
}

export function createPostgresPool(connectionString: string): Pool {
    const pool = new Pool({
        ...postgresPoolConfig(connectionString),
        // The monitor's run-level hard stop only aborts fetches; it cannot cancel a DB await. A
        // query hung on a dead TCP connection (DB restart, Docker network drop) would otherwise
        // block forever and hold the run open past its budget — the "monitor stuck" state. Bound
        // every DB wait so hung I/O fails fast and the run closes through its normal error path.
        keepAlive: true,
        connectionTimeoutMillis: 10_000,
        query_timeout: 30_000,
        statement_timeout: 30_000,
    });
    // An error on an idle client is an unhandled 'error' event that kills the process; a dead
    // runner leaves the open run row behind, which the UI reports as "monitor stuck" until the
    // container restarts and the next tick abandons it.
    pool.on('error', (error) => console.error('postgres pool error on idle client', error));
    return pool;
}

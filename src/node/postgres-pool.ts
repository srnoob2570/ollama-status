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
    return new Pool(postgresPoolConfig(connectionString));
}

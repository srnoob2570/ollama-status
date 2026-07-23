/**
 * In-memory replacement for the Workers Cache API (`caches.default`).
 *
 * Supports `match()` and `put()` keyed by request URL, with TTL driven by
 * the `cache-control: max-age` response header. Runs in a single long-lived
 * Node process where the Cloudflare Cache API is unavailable.
 *
 * A periodic sweep (every 5 minutes) removes expired entries to prevent
 * unbounded memory growth when cache keys rotate (range parameters, model
 * detail paths, etc.).
 */
const SWEEP_INTERVAL_MS = 5 * 60_000;

export class MemoryCache {
    private readonly store = new Map<string, { body: Uint8Array; headers: [string, string][]; expiresAt: number }>();
    private sweepTimer: ReturnType<typeof setInterval> | null = null;

    constructor() {
        this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
        if (this.sweepTimer.unref) this.sweepTimer.unref();
    }

    private sweep(): void {
        const now = Date.now();
        for (const [key, entry] of this.store) {
            if (now > entry.expiresAt) this.store.delete(key);
        }
    }

    /** Stop the periodic sweep. Call before discarding the cache instance. */
    destroy(): void {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
    }

    async match(request: Request | string): Promise<Response | undefined> {
        const key = typeof request === 'string' ? request : request.url;
        const entry = this.store.get(key);
        if (!entry) return undefined;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return undefined;
        }
        return new Response(entry.body, { headers: entry.headers });
    }

    async put(request: Request | string, response: Response): Promise<void> {
        const key = typeof request === 'string' ? request : request.url;
        const maxAge = /max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '');
        const ttlMs = (maxAge ? Number(maxAge[1]) : 60) * 1000;
        const body = new Uint8Array(await response.arrayBuffer());
        this.store.set(key, {
            body,
            headers: [...response.headers.entries()],
            expiresAt: Date.now() + ttlMs,
        });
    }
}

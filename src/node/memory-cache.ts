/**
 * In-memory replacement for the Workers Cache API (`caches.default`).
 *
 * Supports `match()` and `put()` keyed by request URL, with TTL driven by
 * the `cache-control: max-age` response header. Runs in a single long-lived
 * Node process where the Cloudflare Cache API is unavailable.
 */
export class MemoryCache {
    private readonly store = new Map<string, { response: Response; expiresAt: number }>();

    async match(request: Request | string): Promise<Response | undefined> {
        const key = typeof request === 'string' ? request : request.url;
        const entry = this.store.get(key);
        if (!entry) return undefined;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return undefined;
        }
        return entry.response.clone();
    }

    async put(request: Request | string, response: Response): Promise<void> {
        const key = typeof request === 'string' ? request : request.url;
        const maxAge = /max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '');
        const ttlMs = (maxAge ? Number(maxAge[1]) : 60) * 1000;
        this.store.set(key, { response: response.clone(), expiresAt: Date.now() + ttlMs });
    }
}

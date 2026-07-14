import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApiEnv, ExecutionContext } from '../src/worker/types.ts';

const { api } = await import('../src/worker/api.ts');

const secret = 'monitor-test-secret';
const ctx = {
    waitUntil(promise: Promise<unknown>) {
        void promise;
    },
} as ExecutionContext;
const env = {
    CONFIRMATION_HMAC_SECRET: secret,
    DB: {
        prepare() {
            return {
                bind() {
                    return this;
                },
                async run() {
                    return { meta: { changes: 1 } };
                },
                async all() {
                    return { results: [] };
                },
                async first() {
                    return null;
                },
            };
        },
        async batch() {
            return [];
        },
    },
} as unknown as ApiEnv;

function signedRequest(body: unknown, signingSecret = secret): Request {
    const raw = JSON.stringify(body);
    const signature = createHmac('sha256', signingSecret).update(raw).digest('hex');
    return new Request('http://localhost/api/internal/monitor-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-monitor-signature': signature },
        body: raw,
    });
}

function call(request: Request, requestEnv: ApiEnv = env): Promise<Response> {
    return api(request, requestEnv, ctx, '/api/internal/monitor-run');
}

describe('manual monitor run API', () => {

    it('requires the shared confirmation secret and a valid signature', async () => {
        const body = { timestamp: Math.floor(Date.now() / 1_000) };
        expect((await call(signedRequest(body), {} as ApiEnv)).status).toBe(503);
        expect((await call(signedRequest(body, 'wrong-secret'))).status).toBe(401);
    });

    it('rejects signed malformed, invalid, and expired timestamps', async () => {
        expect((await call(signedRequest({ timestamp: 'not-a-unix-timestamp' }))).status).toBe(400);
        expect(
            (await call(signedRequest({ timestamp: Math.floor(Date.now() / 1_000) - 301 }))).status,
        ).toBe(400);
    });

    it.each([null, [], 'not-an-object'])('rejects signed JSON values that are not objects', async (body) => {
        expect((await call(signedRequest(body))).status).toBe(400);
    });

    it('rejects an oversized signed payload before running the monitor', async () => {
        const response = await call(
            signedRequest({ timestamp: Math.floor(Date.now() / 1_000), padding: 'x'.repeat(9 * 1024) }),
        );

        expect(response.status).toBe(413);
    });

    it('queues a signed request without running the monitor in the web process', async () => {
        const response = await call(signedRequest({ timestamp: Math.floor(Date.now() / 1_000) }));

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toMatchObject({ state: 'QUEUED', jobId: expect.any(String) });
    });
});

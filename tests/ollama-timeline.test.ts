import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { OllamaProvider } from '../src/worker/ollama';

function makeProvider() {
    return new OllamaProvider(
        {
            id: 'ollama-free',
            name: 'Free',
            base_url: 'https://example.test/api',
            secret_ref: 'OLLAMA_API_KEY_FREE',
        },
        'test-key',
    );
}

describe('probe timeline milestones', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.useRealTimers();
    });

    it('records headersAt, firstByteAt, firstTokenAt, ttftMs on success', async () => {
        globalThis.fetch = async () =>
            new Response(
                '{"model":"cloud","message":{"role":"assistant","content":"OK"},"done":false}\n',
                { status: 200 },
            );

        const provider = makeProvider();
        const result = await provider.probe('cloud');

        expect(result.classification).toBe('SUCCESS');
        expect(result.headersAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        expect(result.firstByteAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        expect(result.firstTokenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        expect(result.ttftMs).toBeGreaterThanOrEqual(0);
        expect(result.rttMs).toBeGreaterThanOrEqual(0);
    });

    it('records headersAt but null firstByteAt/firstTokenAt on HTTP error', async () => {
        globalThis.fetch = async () =>
            new Response('Not Found', { status: 404 });

        const provider = makeProvider();
        const result = await provider.probe('missing-model');

        expect(result.classification).toBe('MODEL_NOT_FOUND');
        expect(result.headersAt).toBeTruthy();
        expect(result.firstByteAt).toBeNull();
        expect(result.firstTokenAt).toBeNull();
        expect(result.ttftMs).toBeNull();
        expect(result.httpStatus).toBe(404);
    });

    it('timeout before headers: REQUEST_OR_HEADERS / timeout_before_headers', async () => {
        // Simulate the probe's own AbortError before fetch resolves
        globalThis.fetch = async () => {
            throw new DOMException('The operation was aborted', 'AbortError');
        };

        const provider = makeProvider();
        const result = await provider.probe('cloud');

        expect(result.classification).toBe('TIMEOUT');
        expect(result.timeoutStage).toBe('REQUEST_OR_HEADERS');
        expect(result.reasonCode).toBe('timeout_before_headers');
        expect(result.headersAt).toBeNull();
        expect(result.firstByteAt).toBeNull();
        expect(result.firstTokenAt).toBeNull();
        expect(result.ttftMs).toBeNull();
        expect(result.httpStatus).toBeUndefined();
    });

    it('timeout after headers but before first byte: FIRST_BYTE / timeout_waiting_first_byte', async () => {
        // fetch resolves (headers received), then stream read throws AbortError
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.error(new DOMException('The operation was aborted', 'AbortError'));
            },
        });
        globalThis.fetch = async () => new Response(stream, { status: 200 });

        const provider = makeProvider();
        const result = await provider.probe('cloud');

        expect(result.classification).toBe('TIMEOUT');
        expect(result.timeoutStage).toBe('FIRST_BYTE');
        expect(result.reasonCode).toBe('timeout_waiting_first_byte');
        expect(result.headersAt).toBeTruthy();
        expect(result.firstByteAt).toBeNull();
        expect(result.firstTokenAt).toBeNull();
        expect(result.ttftMs).toBeNull();
        expect(result.httpStatus).toBeUndefined();
    });

    it('timeout after first byte but before first token: FIRST_TOKEN / timeout_waiting_first_token', async () => {
        // Stream yields a valid chat chunk without content/thinking, then throws AbortError
        let enqueued = false;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (!enqueued) {
                    controller.enqueue(new TextEncoder().encode('{"done":false}\n'));
                    enqueued = true;
                } else {
                    controller.error(new DOMException('The operation was aborted', 'AbortError'));
                }
            },
        });
        globalThis.fetch = async () => new Response(stream, { status: 200 });

        const provider = makeProvider();
        const result = await provider.probe('cloud');

        expect(result.classification).toBe('TIMEOUT');
        expect(result.timeoutStage).toBe('FIRST_TOKEN');
        expect(result.reasonCode).toBe('timeout_waiting_first_token');
        expect(result.headersAt).toBeTruthy();
        expect(result.firstByteAt).toBeTruthy();
        expect(result.firstTokenAt).toBeNull();
        expect(result.ttftMs).toBeNull();
        expect(result.httpStatus).toBeUndefined();
    });

    it('hard stop via parentSignal: rethrows AbortError for monitor to handle', async () => {
        globalThis.fetch = async (_input: Request | URL | string, init?: RequestInit) => {
            if (init?.signal?.aborted) {
                throw new DOMException('The operation was aborted', 'AbortError');
            }
            return new Promise<Response>(() => {});
        };

        const provider = makeProvider();
        const parentController = new AbortController();
        parentController.abort();

        await expect(
            provider.probe('cloud', undefined, parentController.signal),
        ).rejects.toThrow('The operation was aborted');
    });

    it('clears the probe timer on success', async () => {
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

        globalThis.fetch = async () =>
            new Response(
                '{"model":"cloud","message":{"role":"assistant","content":"OK"},"done":false}\n',
                { status: 200 },
            );

        const provider = makeProvider();
        await provider.probe('cloud');

        expect(clearTimeoutSpy).toHaveBeenCalled();
        clearTimeoutSpy.mockRestore();
    });

    it('clears the probe timer on error', async () => {
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

        globalThis.fetch = async () => {
            throw new TypeError('fetch failed');
        };

        const provider = makeProvider();
        await provider.probe('cloud');

        expect(clearTimeoutSpy).toHaveBeenCalled();
        clearTimeoutSpy.mockRestore();
    });

    it('rttMs is still populated for backward compatibility', async () => {
        globalThis.fetch = async () =>
            new Response(
                '{"model":"cloud","message":{"role":"assistant","content":"OK"},"done":false}\n',
                { status: 200 },
            );

        const provider = makeProvider();
        const result = await provider.probe('cloud');

        expect(result.rttMs).toBeGreaterThanOrEqual(0);
        expect(result.ttftMs).toBeGreaterThanOrEqual(0);
    });

    it('network error has null httpStatus and no fabricated 408/504', async () => {
        globalThis.fetch = async () => {
            throw new TypeError('fetch failed');
        };

        const provider = makeProvider();
        const result = await provider.probe('cloud');

        expect(result.classification).toBe('NETWORK_ERROR');
        expect(result.httpStatus).toBeUndefined();
        expect(result.timeoutStage).toBeUndefined();
    });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    instances: [] as FakeClient[],
}));

class FakeClient {
    handlers = new Map<string, (...args: unknown[]) => void>();
    connect = vi.fn(async () => {});
    query = vi.fn(async () => {});
    end = vi.fn(async () => {});

    constructor() {
        state.instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
        this.handlers.set(event, handler);
        return this;
    }

    emit(event: string, payload: unknown): void {
        this.handlers.get(event)?.(payload);
    }
}

vi.mock('pg', () => ({ Client: FakeClient }));

const { startLiveProgress } = await import('../src/node/live-progress.ts');

describe('startLiveProgress', () => {
    beforeEach(() => {
        state.instances.length = 0;
    });

    it('delivers monitor_progress notifications to subscribers', async () => {
        const handle = startLiveProgress('postgres://test');
        await Promise.resolve();
        const client = state.instances[0];
        const received: string[] = [];
        handle.subscribe((payload) => received.push(payload));

        client.emit('notification', { channel: 'monitor_progress', payload: '{"phase":"CHECKING"}' });

        expect(received).toEqual(['{"phase":"CHECKING"}']);
        await handle.stop();
    });

    it('ignores notifications on other channels', async () => {
        const handle = startLiveProgress('postgres://test');
        await Promise.resolve();
        const client = state.instances[0];
        const received: string[] = [];
        handle.subscribe((payload) => received.push(payload));

        client.emit('notification', { channel: 'some_other_channel', payload: 'x' });

        expect(received).toEqual([]);
        await handle.stop();
    });

    it('stops delivering to a listener after it unsubscribes', async () => {
        const handle = startLiveProgress('postgres://test');
        await Promise.resolve();
        const client = state.instances[0];
        const received: string[] = [];
        const unsubscribe = handle.subscribe((payload) => received.push(payload));

        client.emit('notification', { channel: 'monitor_progress', payload: 'first' });
        unsubscribe();
        client.emit('notification', { channel: 'monitor_progress', payload: 'second' });

        expect(received).toEqual(['first']);
        await handle.stop();
    });

    it('stop() ends the underlying connection', async () => {
        const handle = startLiveProgress('postgres://test');
        await Promise.resolve();
        const client = state.instances[0];

        await handle.stop();

        expect(client.end).toHaveBeenCalledOnce();
    });

    it('reconnects after the underlying connection ends', async () => {
        vi.useFakeTimers();
        try {
            const handle = startLiveProgress('postgres://test');
            await vi.advanceTimersByTimeAsync(0);
            expect(state.instances).toHaveLength(1);

            state.instances[0].emit('end', undefined);
            await vi.advanceTimersByTimeAsync(5_000);

            expect(state.instances).toHaveLength(2);
            await handle.stop();
        } finally {
            vi.useRealTimers();
        }
    });
});

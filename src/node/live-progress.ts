import { Client } from 'pg';
import { postgresPoolConfig } from './postgres-pool.ts';

const CHANNEL = 'monitor_progress';
const RECONNECT_DELAY_MS = 5_000;

export type LiveProgressListener = (payload: string) => void;

export interface LiveProgressHandle {
    /** Register a listener for raw NOTIFY payloads. Returns an unsubscribe function. */
    subscribe(listener: LiveProgressListener): () => void;
    stop(): Promise<void>;
}

// A dedicated Client (not the shared Pool) because LISTEN ties a subscription to one specific
// connection for its whole lifetime — a pooled connection would get recycled out from under it.
// Reconnects on error/close so a transient DB blip doesn't permanently kill live progress; the web
// process stays up either way, it just falls back to stale data until the next successful connect.
export function startLiveProgress(connectionString: string): LiveProgressHandle {
    const subscribers = new Set<LiveProgressListener>();
    let stopped = false;
    let client: Client | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function broadcast(payload: string): void {
        for (const listener of subscribers) listener(payload);
    }

    function scheduleReconnect(): void {
        if (stopped || reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void connect();
        }, RECONNECT_DELAY_MS);
    }

    async function connect(): Promise<void> {
        if (stopped) return;
        const current = new Client(postgresPoolConfig(connectionString));
        client = current;
        current.on('notification', (message) => {
            if (message.channel === CHANNEL && message.payload) broadcast(message.payload);
        });
        current.on('error', (error) => {
            console.error('live progress: connection error', error);
            scheduleReconnect();
        });
        current.on('end', () => scheduleReconnect());
        try {
            await current.connect();
            await current.query(`LISTEN ${CHANNEL}`);
        } catch (error) {
            console.error('live progress: failed to connect/listen', error);
            scheduleReconnect();
        }
    }

    void connect();

    return {
        subscribe(listener) {
            subscribers.add(listener);
            return () => subscribers.delete(listener);
        },
        async stop() {
            stopped = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            subscribers.clear();
            if (client) await client.end().catch(() => undefined);
        },
    };
}

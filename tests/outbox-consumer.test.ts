import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { SqliteD1Adapter } from '../src/node/sqlite-d1-adapter.ts';
import { startOutboxConsumer } from '../src/node/outbox-consumer.ts';
import type { D1DatabaseLike } from '../src/worker/types.ts';
import type { OutboxProcessorMap, OutboxEvent } from '../src/node/outbox-consumer.ts';

function migratedDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort())
        db.exec(readFileSync(`migrations/${file}`, 'utf8'));
    return db;
}

function makeDb(): D1DatabaseLike {
    return new SqliteD1Adapter(migratedDb());
}

/**
 * Seed a probe_event + probe_outbox row for testing.
 */
async function seedOutboxRow(
    db: D1DatabaseLike,
    overrides: {
        eventId?: string;
        outboxId?: string;
        eventType?: string;
        consumedAt?: string | null;
        consumerId?: string | null;
        attempts?: number;
    } = {},
): Promise<{ eventId: string; outboxId: string }> {
    const eventId = overrides.eventId ?? `evt_${crypto.randomUUID()}`;
    const outboxId = overrides.outboxId ?? `obx_${crypto.randomUUID()}`;
    const eventType = overrides.eventType ?? 'probe.completed';
    const now = new Date().toISOString();

    await db
        .prepare(
            `INSERT INTO probe_events (id, event_type, event_version, occurred_at, recorded_at)
             VALUES (?, ?, '1.0', ?, ?)`,
        )
        .bind(eventId, eventType, now, now)
        .run();

    await db
        .prepare(
            `INSERT INTO probe_outbox (id, event_id, consumed_at, consumer_id, attempts)
             VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
            outboxId,
            eventId,
            overrides.consumedAt ?? null,
            overrides.consumerId ?? null,
            overrides.attempts ?? 0,
        )
        .run();

    return { eventId, outboxId };
}

describe('outbox consumer', () => {
    let db: D1DatabaseLike;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('consumes unconsumed outbox rows and marks them as consumed', async () => {
        const { outboxId } = await seedOutboxRow(db, { eventType: 'probe.completed' });

        const processed: string[] = [];
        const processor: OutboxProcessorMap = {
            'probe.completed': async (event: OutboxEvent) => {
                processed.push(event.outbox.id);
            },
        };

        const consumer = startOutboxConsumer(db, {
            pollIntervalMs: 50,
            batchSize: 10,
            consumerId: 'test-1',
            processor,
        });

        // Wait for a few poll cycles
        await new Promise((resolve) => setTimeout(resolve, 200));
        await consumer.stop();

        expect(processed).toContain(outboxId);

        // Verify row is marked consumed
        const row = await db
            .prepare('SELECT * FROM probe_outbox WHERE id = ?')
            .bind(outboxId)
            .first<Record<string, unknown>>();
        expect(row).toBeTruthy();
        expect((row as Record<string, unknown>).consumed_at).toBeTruthy();
        expect((row as Record<string, unknown>).consumer_id).toBe('test-1');
        expect((row as Record<string, unknown>).attempts).toBe(1);
    });

    it('skips rows that are already consumed', async () => {
        const { outboxId } = await seedOutboxRow(db, {
            eventType: 'probe.completed',
            consumedAt: new Date().toISOString(),
            consumerId: 'other-node',
            attempts: 1,
        });

        const processed: string[] = [];
        const processor: OutboxProcessorMap = {
            'probe.completed': async (event: OutboxEvent) => {
                processed.push(event.outbox.id);
            },
        };

        const consumer = startOutboxConsumer(db, {
            pollIntervalMs: 50,
            batchSize: 10,
            consumerId: 'test-2',
            processor,
        });

        await new Promise((resolve) => setTimeout(resolve, 200));
        await consumer.stop();

        // Should not have processed the already-consumed row
        expect(processed).not.toContain(outboxId);

        // Row should remain unchanged
        const row = await db
            .prepare('SELECT * FROM probe_outbox WHERE id = ?')
            .bind(outboxId)
            .first<Record<string, unknown>>();
        expect((row as Record<string, unknown>).consumer_id).toBe('other-node');
        expect((row as Record<string, unknown>).attempts).toBe(1);
    });

    it('recovers unconsumed events after restart (simulated by stop/start)', async () => {
        const { outboxId } = await seedOutboxRow(db, { eventType: 'probe.completed' });

        // First consumer stops before processing
        const processed1: string[] = [];
        const consumer1 = startOutboxConsumer(db, {
            pollIntervalMs: 5000, // long interval so it doesn't process
            batchSize: 10,
            consumerId: 'test-3a',
            processor: {
                'probe.completed': async (event: OutboxEvent) => {
                    processed1.push(event.outbox.id);
                },
            },
        });
        await consumer1.stop();
        expect(processed1).toHaveLength(0);

        // Second consumer picks up the unconsumed row
        const processed2: string[] = [];
        const consumer2 = startOutboxConsumer(db, {
            pollIntervalMs: 50,
            batchSize: 10,
            consumerId: 'test-3b',
            processor: {
                'probe.completed': async (event: OutboxEvent) => {
                    processed2.push(event.outbox.id);
                },
            },
        });

        await new Promise((resolve) => setTimeout(resolve, 200));
        await consumer2.stop();

        expect(processed2).toContain(outboxId);

        // Row should be consumed by the second consumer
        const row = await db
            .prepare('SELECT * FROM probe_outbox WHERE id = ?')
            .bind(outboxId)
            .first<Record<string, unknown>>();
        expect((row as Record<string, unknown>).consumer_id).toBe('test-3b');
    });

    it('processes multiple event types via the processor map', async () => {
        const events = [
            { eventType: 'probe.completed' },
            { eventType: 'probe.failed' },
            { eventType: 'expectation.satisfied' },
            { eventType: 'expectation.missed' },
            { eventType: 'expectation.suppressed' },
            { eventType: 'mitigation.proposed' },
            { eventType: 'mitigation.applied' },
            { eventType: 'mitigation.skipped' },
        ];

        const outboxIds: string[] = [];
        for (const ev of events) {
            const { outboxId } = await seedOutboxRow(db, { eventType: ev.eventType });
            outboxIds.push(outboxId);
        }

        const processed: string[] = [];
        const processor: OutboxProcessorMap = {
            'probe.completed': async (event: OutboxEvent) => { processed.push(`completed:${event.outbox.id}`); },
            'probe.failed': async (event: OutboxEvent) => { processed.push(`failed:${event.outbox.id}`); },
            'expectation.satisfied': async (event: OutboxEvent) => { processed.push(`satisfied:${event.outbox.id}`); },
            'expectation.missed': async (event: OutboxEvent) => { processed.push(`missed:${event.outbox.id}`); },
            'expectation.suppressed': async (event: OutboxEvent) => { processed.push(`suppressed:${event.outbox.id}`); },
            'mitigation.proposed': async (event: OutboxEvent) => { processed.push(`proposed:${event.outbox.id}`); },
            'mitigation.applied': async (event: OutboxEvent) => { processed.push(`applied:${event.outbox.id}`); },
            'mitigation.skipped': async (event: OutboxEvent) => { processed.push(`skipped:${event.outbox.id}`); },
        };

        const consumer = startOutboxConsumer(db, {
            pollIntervalMs: 50,
            batchSize: 20,
            consumerId: 'test-4',
            processor,
        });

        await new Promise((resolve) => setTimeout(resolve, 300));
        await consumer.stop();

        for (const oid of outboxIds) {
            const found = processed.some((p) => p.includes(oid));
            expect(found).toBe(true);
        }
    });

    it('stop() resolves gracefully and no more processing happens after', async () => {
        await seedOutboxRow(db, { eventType: 'probe.completed' });

        let callCount = 0;
        const processor: OutboxProcessorMap = {
            'probe.completed': async () => {
                callCount++;
            },
        };

        const consumer = startOutboxConsumer(db, {
            pollIntervalMs: 50,
            batchSize: 10,
            consumerId: 'test-5',
            processor,
        });

        // Let it process once
        await new Promise((resolve) => setTimeout(resolve, 150));
        await consumer.stop();

        const countAfterStop = callCount;

        // Wait a bit more to ensure no further processing
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(callCount).toBe(countAfterStop);
    });

    it('handles processor errors without crashing the loop', async () => {
        const { outboxId } = await seedOutboxRow(db, { eventType: 'probe.completed' });

        const errorSpy = vi.fn();
        const processor: OutboxProcessorMap = {
            'probe.completed': async () => {
                throw new Error('processor failure');
            },
        };

        const consumer = startOutboxConsumer(db, {
            pollIntervalMs: 50,
            batchSize: 10,
            consumerId: 'test-6',
            processor,
            onError: errorSpy,
        });

        await new Promise((resolve) => setTimeout(resolve, 200));
        await consumer.stop();

        expect(errorSpy).toHaveBeenCalled();
        // Row is NOT consumed on error — allows retry on next poll
        const row = await db
            .prepare('SELECT * FROM probe_outbox WHERE id = ?')
            .bind(outboxId)
            .first<Record<string, unknown>>();
        expect((row as Record<string, unknown>).consumed_at).toBeNull();
        // Attempts should have been incremented (retried each poll cycle)
        expect((row as Record<string, unknown>).attempts).toBeGreaterThan(0);
    });

    it('uses default processors when none provided', async () => {
        const { outboxId } = await seedOutboxRow(db, { eventType: 'probe.completed' });

        const consumer = startOutboxConsumer(db, {
            pollIntervalMs: 50,
            batchSize: 10,
            consumerId: 'test-7',
        });

        await new Promise((resolve) => setTimeout(resolve, 200));
        await consumer.stop();

        // Row should be consumed by default processor
        const row = await db
            .prepare('SELECT * FROM probe_outbox WHERE id = ?')
            .bind(outboxId)
            .first<Record<string, unknown>>();
        expect((row as Record<string, unknown>).consumed_at).toBeTruthy();
        expect((row as Record<string, unknown>).consumer_id).toBe('test-7');
    });
});

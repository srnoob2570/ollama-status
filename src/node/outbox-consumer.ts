import type { D1DatabaseLike } from '../worker/types.ts';

// ── Outbox row shape ──────────────────────────────────────────────────────────

export interface OutboxRow {
    id: string;
    event_id: string;
    consumed_at: string | null;
    consumer_id: string | null;
    attempts: number;
}

// ── Processor types ──────────────────────────────────────────────────────────

export interface OutboxEvent {
    /** The outbox row itself. */
    outbox: OutboxRow;
    /** The resolved probe_event row. */
    event: {
        id: string;
        event_type: string;
        event_version: string;
        occurred_at: string;
        recorded_at: string;
        actor_type: string | null;
        actor_id: string | null;
        subject_type: string | null;
        subject_id: string | null;
        scheduler_tick_id: string | null;
        run_id: string | null;
        expectation_id: string | null;
        execution_id: string | null;
        task_id: string | null;
        attempt_id: string | null;
        causation_event_id: string | null;
        correlation_id: string | null;
        sequence: number | null;
        idempotency_key: string | null;
        detail_json: string | null;
    };
}

export type OutboxProcessor = (event: OutboxEvent) => Promise<void>;

export interface OutboxProcessorMap {
    [eventType: string]: OutboxProcessor;
}

// ── Consumer options ──────────────────────────────────────────────────────────

export interface OutboxConsumerOptions {
    /** How often to poll for new rows (ms). Default 1000. */
    pollIntervalMs?: number;
    /** Max rows to fetch per poll. Default 10. */
    batchSize?: number;
    /** Unique consumer id for this instance. Default 'node-1'. */
    consumerId?: string;
    /** Map of event_type → processor. Unknown types are skipped. */
    processor?: OutboxProcessorMap;
    /** Called when a processor throws. Default logs to console.error. */
    onError?: (error: unknown, event: OutboxEvent) => void;
}

// ── Consumer handle ───────────────────────────────────────────────────────────

export interface OutboxConsumerHandle {
    /** Gracefully stop the consumer loop. Resolves after the current tick finishes. */
    stop(): Promise<void>;
}

// ── Default processors (placeholders for T11/T12) ────────────────────────────

async function onProbeCompleted(): Promise<void> {
    // T11: trigger cadence window recalculation
}

async function onProbeFailed(): Promise<void> {
    // T11: trigger cadence window recalculation
}

async function onExpectationChanged(): Promise<void> {
    // T12: trigger rollup update
}

async function onMitigationEvent(): Promise<void> {
    // v1: log/metrics only
}

// ── Default processor map ────────────────────────────────────────────────────

const DEFAULT_PROCESSORS: OutboxProcessorMap = {
    'probe.completed': onProbeCompleted,
    'probe.failed': onProbeFailed,
    'expectation.satisfied': onExpectationChanged,
    'expectation.missed': onExpectationChanged,
    'expectation.suppressed': onExpectationChanged,
    'mitigation.proposed': onMitigationEvent,
    'mitigation.applied': onMitigationEvent,
    'mitigation.skipped': onMitigationEvent,
};

// ── Consumer loop ────────────────────────────────────────────────────────────

/**
 * Start a supervised Node.js loop that consumes `probe_outbox` rows from
 * PostgreSQL and dispatches them to the configured processors.
 *
 * The consumer recovers unconsumed events after restart (it polls for rows
 * where `consumed_at IS NULL`). Consumption is idempotent: the UPDATE uses a
 * conditional WHERE to avoid double-processing.
 */
export function startOutboxConsumer(
    db: D1DatabaseLike,
    options: OutboxConsumerOptions = {},
): OutboxConsumerHandle {
    const {
        pollIntervalMs = 1_000,
        batchSize = 10,
        consumerId = 'node-1',
        processor = DEFAULT_PROCESSORS,
        onError = (error, event) =>
            console.error(
                `outbox consumer: error processing event ${event.outbox.id} (${event.event.event_type})`,
                error,
            ),
    } = options;

    let stopped = false;
    let currentTick: Promise<void> = Promise.resolve();

    async function tick(): Promise<void> {
        if (stopped) return;

        try {
            // Fetch unconsumed outbox rows
            const rows = await db
                .prepare(`SELECT * FROM probe_outbox WHERE consumed_at IS NULL ORDER BY id LIMIT ?`)
                .bind(batchSize)
                .all<OutboxRow>();

            for (const outbox of rows.results) {
                if (stopped) return;

                try {
                    // Fetch the associated probe_event
                    const eventRow = await db
                        .prepare(`SELECT * FROM probe_events WHERE id = ?`)
                        .bind(outbox.event_id)
                        .first<Record<string, unknown>>();

                    if (!eventRow) {
                        console.warn(
                            `outbox consumer: probe_event ${outbox.event_id} not found for outbox row ${outbox.id}, marking consumed`,
                        );
                        await markConsumed(db, outbox.id, consumerId);
                        continue;
                    }

                    const event: OutboxEvent = {
                        outbox,
                        event: {
                            id: eventRow.id as string,
                            event_type: eventRow.event_type as string,
                            event_version: eventRow.event_version as string,
                            occurred_at: eventRow.occurred_at as string,
                            recorded_at: eventRow.recorded_at as string,
                            actor_type: (eventRow.actor_type as string) ?? null,
                            actor_id: (eventRow.actor_id as string) ?? null,
                            subject_type: (eventRow.subject_type as string) ?? null,
                            subject_id: (eventRow.subject_id as string) ?? null,
                            scheduler_tick_id: (eventRow.scheduler_tick_id as string) ?? null,
                            run_id: (eventRow.run_id as string) ?? null,
                            expectation_id: (eventRow.expectation_id as string) ?? null,
                            execution_id: (eventRow.execution_id as string) ?? null,
                            task_id: (eventRow.task_id as string) ?? null,
                            attempt_id: (eventRow.attempt_id as string) ?? null,
                            causation_event_id: (eventRow.causation_event_id as string) ?? null,
                            correlation_id: (eventRow.correlation_id as string) ?? null,
                            sequence: (eventRow.sequence as number) ?? null,
                            idempotency_key: (eventRow.idempotency_key as string) ?? null,
                            detail_json: (eventRow.detail_json as string) ?? null,
                        },
                    };

                    const eventType = event.event.event_type;
                    const proc = processor[eventType];

                    if (proc) {
                        await proc(event);
                    }

                    // Mark consumed idempotently
                    await markConsumed(db, outbox.id, consumerId);
                } catch (error) {
                    // Increment attempts even on error so retry count is tracked
                    await incrementAttempts(db, outbox.id);
                    onError(error, {
                        outbox,
                        event: {
                            id: '',
                            event_type: 'unknown',
                            event_version: '',
                            occurred_at: '',
                            recorded_at: '',
                            actor_type: null,
                            actor_id: null,
                            subject_type: null,
                            subject_id: null,
                            scheduler_tick_id: null,
                            run_id: null,
                            expectation_id: null,
                            execution_id: null,
                            task_id: null,
                            attempt_id: null,
                            causation_event_id: null,
                            correlation_id: null,
                            sequence: null,
                            idempotency_key: null,
                            detail_json: null,
                        },
                    });
                }
            }
        } catch (error) {
            console.error('outbox consumer: poll failed', error);
        }
    }

    async function markConsumed(
        db: D1DatabaseLike,
        outboxId: string,
        consumerId: string,
    ): Promise<void> {
        const result = await db
            .prepare(
                `UPDATE probe_outbox SET consumed_at = ?, consumer_id = ?, attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL`,
            )
            .bind(new Date().toISOString(), consumerId, outboxId)
            .run();

        // If 0 rows affected, another consumer already processed it — that's fine.
        if (result.meta.changes === 0) {
            console.debug(
                `outbox consumer: row ${outboxId} already consumed by another instance, skipping`,
            );
        }
    }

    async function incrementAttempts(db: D1DatabaseLike, outboxId: string): Promise<void> {
        await db
            .prepare(
                `UPDATE probe_outbox SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL`,
            )
            .bind(outboxId)
            .run();
    }

    async function loop(): Promise<void> {
        while (!stopped) {
            await tick();
            if (!stopped) {
                await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
            }
        }
    }

    // Start the loop in the background
    currentTick = loop().catch((error) => {
        console.error('outbox consumer: loop crashed', error);
    });

    return {
        async stop(): Promise<void> {
            stopped = true;
            await currentTick;
        },
    };
}

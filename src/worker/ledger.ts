import type { D1DatabaseLike, D1StatementLike } from './types.ts';
import type {
    SchedulerTick,
    ProbeAttempt,
    ProbeEvent,
    ProbeResult,
    TickTrigger,
    TickState,
    TickOutcome,
    AttemptState,
    SubmissionDisposition,
    ExpectationState,
    ReasonCode,
    ObservationRole,
    FailureDomain,
    EvidenceSource,
    Retryability,
    TimeoutStage,
    Classification,
    PublicStatus,
} from './types.ts';
import { id, now } from './types.ts';
import { metrics } from './metrics.ts';

// ── Detail JSON allowlists per event_type ──────────────────────────────────

const DETAIL_ALLOWLISTS: Record<string, Set<string>> = {
    'run.started': new Set(['run_id', 'trigger', 'scheduled_at']),
    'run.completed': new Set(['run_id', 'outcome', 'reason_code']),
    'run.abandoned': new Set(['run_id', 'reason_code', 'timeout_stage']),
    'scheduler.lock_contended': new Set(['tick_key', 'owner']),
    'expectation.created': new Set(['model_id', 'purpose', 'due_at', 'tier']),
    'expectation.scheduled': new Set(['model_id', 'purpose', 'due_at', 'execution_id']),
    'expectation.suppressed': new Set(['model_id', 'purpose', 'due_at', 'reason_code']),
    'expectation.missed': new Set(['model_id', 'purpose', 'due_at', 'reason_code']),
    'expectation.satisfied': new Set(['model_id', 'purpose', 'due_at', 'attempt_id']),
    'expectation.cancelled': new Set(['model_id', 'purpose', 'due_at', 'reason_code']),
    'probe.queued': new Set(['attempt_id', 'model_id', 'purpose']),
    'probe.leased': new Set(['attempt_id', 'node_id', 'lease_expires_at']),
    'probe.started': new Set(['started_at', 'model_id', 'purpose']),
    'probe.headers': new Set(['attempt_id', 'http_status', 'headers_at']),
    'probe.first_byte': new Set(['attempt_id', 'first_byte_at']),
    'probe.first_token': new Set(['attempt_id', 'first_token_at', 'ttft_ms']),
    'probe.completed': new Set(['classification', 'reason_code', 'http_status', 'timeout_stage']),
    'probe.failed': new Set(['attempt_id', 'reason_code', 'failure_domain', 'timeout_stage']),
    'credential.cooldown_started': new Set(['credential_account_id', 'reason_code', 'retry_at']),
    'credential.cooldown_recovered': new Set(['credential_account_id']),
    'cadence.violation_detected': new Set(['model_id', 'window', 'state', 'policy_adherence']),
    'mitigation.proposed': new Set(['reason_code', 'action', 'policy_version', 'deadline_at', 'budget_remaining', 'kill_switch_active']),
    'mitigation.applied': new Set(['reason_code', 'action', 'policy_version', 'deadline_at', 'budget_remaining', 'kill_switch_active']),
    'mitigation.skipped': new Set(['reason_code', 'action', 'policy_version', 'deadline_at', 'budget_remaining', 'kill_switch_active']),
    'warmup.started': new Set(['attempt_id', 'model_id']),
    'warmup.completed': new Set(['attempt_id', 'model_id', 'warmup_age_ms']),
};

function validateDetailJson(eventType: string, detailJson: string | null): void {
    if (detailJson === null) return;
    const allowlist = DETAIL_ALLOWLISTS[eventType];
    if (!allowlist) {
        throw new Error(`Unknown event_type "${eventType}" — no detail_json allowlist defined`);
    }
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(detailJson);
    } catch {
        throw new Error(`detail_json for "${eventType}" is not valid JSON`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`detail_json for "${eventType}" must be a JSON object`);
    }
    for (const key of Object.keys(parsed)) {
        if (!allowlist.has(key)) {
            throw new Error(
                `Key "${key}" is not allowed in detail_json for event_type "${eventType}". ` +
                `Allowed keys: ${[...allowlist].join(', ')}`,
            );
        }
    }
    const BYTE_LIMIT = 4096;
    const byteLength = new TextEncoder().encode(detailJson).length;
    if (byteLength > BYTE_LIMIT) {
        throw new Error(
            `detail_json for "${eventType}" exceeds ${BYTE_LIMIT}-byte limit (${byteLength} bytes)`,
        );
    }
}

function eventAndOutboxStatements(
    db: D1DatabaseLike,
    eventId: string,
    eventType: string,
    occurredAt: string,
    recordedAt: string,
    subjectType: string,
    subjectId: string,
    runId: string | null,
    expectationId: string | null,
    executionId: string | null,
    taskId: string | null,
    attemptId: string | null,
    detailJson: string | null,
): D1StatementLike[] {
    validateDetailJson(eventType, detailJson);
    const outboxId = id('pout');
    return [
        db.prepare(
            `INSERT INTO probe_events (id, event_type, event_version, occurred_at, recorded_at,
                actor_type, actor_id, subject_type, subject_id,
                scheduler_tick_id, run_id, expectation_id, execution_id, task_id, attempt_id,
                causation_event_id, correlation_id, sequence, idempotency_key, detail_json)
             VALUES (?, ?, '1', ?, ?, 'system', 'ledger', ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
        ).bind(eventId, eventType, occurredAt, recordedAt, subjectType, subjectId,
               runId, expectationId, executionId, taskId, attemptId, detailJson),
        db.prepare(
            `INSERT INTO probe_outbox (id, event_id, consumed_at, consumer_id, attempts)
             VALUES (?, ?, NULL, NULL, 0)`,
        ).bind(outboxId, eventId),
    ];
}

// ── Row mappers (snake_case DB → camelCase TS) ────────────────────────────

function mapTick(row: Record<string, unknown>): SchedulerTick {
    return {
        id: row.id as string,
        tickKey: row.tick_key as string,
        scheduledAt: row.scheduled_at as string,
        startedAt: row.started_at as string | null,
        finishedAt: row.finished_at as string | null,
        trigger: row.trigger as TickTrigger,
        state: row.state as TickState,
        outcome: (row.outcome ?? null) as TickOutcome | null,
        runId: (row.run_id as string) ?? null,
        reasonCode: (row.reason_code ?? null) as ReasonCode | null,
        policyVersion: typeof row.policy_version === 'string' ? parseInt(row.policy_version, 10) || 0 : (row.policy_version as number ?? 0),
    };
}

function mapAttempt(row: Record<string, unknown>): ProbeAttempt {
    return {
        id: row.id as string,
        runId: row.run_id as string,
        taskId: (row.task_id as string) ?? '',
        parentType: (row.parent_type as string) ?? '',
        parentId: (row.parent_id as string) ?? '',
        modelId: row.model_id as string,
        attemptNo: (row.attempt_no as number) ?? 1,
        purpose: (row.purpose as string) ?? '',
        providerId: row.provider_id as string,
        credentialAccountId: (row.credential_account_id as string) ?? '',
        credentialKeyId: (row.credential_key_id as string) ?? '',
        credentialBindingId: (row.credential_binding_id as string) ?? '',
        nodeId: (row.node_id as string) ?? '',
        region: (row.region as string) ?? '',
        queuedAt: (row.queued_at as string) ?? null,
        leasedAt: (row.leased_at as string) ?? null,
        startedAt: (row.started_at as string) ?? null,
        headersAt: (row.headers_at as string) ?? null,
        firstByteAt: (row.first_byte_at as string) ?? null,
        firstTokenAt: (row.first_token_at as string) ?? null,
        finishedAt: (row.finished_at as string) ?? null,
        receivedAt: (row.received_at as string) ?? null,
        state: row.state as AttemptState,
        classification: (row.classification as Classification) ?? 'UNKNOWN',
        publicStatus: (row.public_status as PublicStatus) ?? 'UNKNOWN',
        contributesToStatus: Boolean(row.contributes_to_status),
        failureDomain: (row.failure_domain as FailureDomain | null) ?? null,
        reasonCode: (row.reason_code as ReasonCode | null) ?? null,
        evidenceSource: (row.evidence_source as EvidenceSource | null) ?? null,
        retryability: (row.retryability as Retryability | null) ?? null,
        timeoutStage: (row.timeout_stage as TimeoutStage | null) ?? null,
        timeoutBudgetMs: row.timeout_budget_ms as number | null,
        httpStatus: row.http_status as number | null,
        retryAfterSeconds: row.retry_after_seconds as number | null,
        retryAt: row.retry_at as string | null,
        bytesRead: row.bytes_read as number | null,
        queueWaitMs: row.queue_wait_ms as number | null,
        ttftMs: row.ttft_ms as number | null,
        totalElapsedMs: row.total_elapsed_ms as number | null,
        loadDurationMs: row.load_duration_ms as number | null,
        errorFingerprint: row.error_fingerprint as string | null,
        classifierRuleVersion: typeof row.classifier_rule_version === 'string' ? parseInt(row.classifier_rule_version, 10) || null : (row.classifier_rule_version as number | null),
        policyVersion: typeof row.policy_version === 'string' ? parseInt(row.policy_version, 10) || 0 : (row.policy_version as number ?? 0),
        agentVersion: row.agent_version as string | null,
        experimentId: row.experiment_id as string | null,
        assignedArm: row.assigned_arm as string | null,
        warmupAttemptId: row.warmup_attempt_id as string | null,
        wasWarmed: Boolean(row.was_warmed),
        warmupAgeMs: row.warmup_age_ms as number | null,
        experimentConfigVersion: typeof row.experiment_config_version === 'string' ? parseInt(row.experiment_config_version, 10) || null : (row.experiment_config_version as number | null),
    };
}

function mapEvent(row: Record<string, unknown>): ProbeEvent {
    return {
        id: row.id as string,
        eventType: row.event_type as string,
        eventVersion: typeof row.event_version === 'string' ? parseInt(row.event_version, 10) || 1 : (row.event_version as number ?? 1),
        occurredAt: row.occurred_at as string,
        recordedAt: row.recorded_at as string,
        actorType: (row.actor_type as string) ?? '',
        actorId: (row.actor_id as string) ?? '',
        subjectType: (row.subject_type as string) ?? '',
        subjectId: (row.subject_id as string) ?? '',
        schedulerTickId: (row.scheduler_tick_id as string) ?? null,
        runId: (row.run_id as string) ?? null,
        expectationId: (row.expectation_id as string) ?? null,
        executionId: (row.execution_id as string) ?? null,
        taskId: (row.task_id as string) ?? null,
        attemptId: (row.attempt_id as string) ?? null,
        causationEventId: (row.causation_event_id as string) ?? null,
        correlationId: (row.correlation_id as string) ?? null,
        sequence: (row.sequence as number) ?? null,
        idempotencyKey: (row.idempotency_key as string) ?? null,
        detailJson: (row.detail_json as string) ?? null,
    };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function purposeToObservationRole(purpose: string): ObservationRole {
    const upper = purpose.toUpperCase();
    if (upper === 'AVAILABILITY') return 'AVAILABILITY';
    if (upper === 'ENTITLEMENT') return 'ENTITLEMENT';
    if (upper === 'WARMUP') return 'WARMUP';
    if (upper === 'METADATA') return 'METADATA';
    return 'AVAILABILITY';
}

const TERMINAL_ATTEMPT_STATES = ['COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED'] as const;

function terminalAttemptStateSet(): ReadonlySet<string> {
    return new Set(TERMINAL_ATTEMPT_STATES);
}

function terminalAttemptStatesSql(): string {
    return TERMINAL_ATTEMPT_STATES.map(s => `'${s}'`).join(',');
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Idempotent tick registration. Two calls with the same `tickKey` produce
 * exactly one row. Returns the existing row on conflict.
 */
export async function recordSchedulerTick(
    db: D1DatabaseLike,
    tick: Omit<SchedulerTick, 'id'> & { id?: string },
): Promise<SchedulerTick> {
    const tickId = tick.id ?? id('tick');
    const existing = await db.prepare(
        'SELECT * FROM scheduler_ticks WHERE tick_key = ?',
    ).bind(tick.tickKey).first<Record<string, unknown>>();

    if (existing) return mapTick(existing);

    metrics.schedulerTicksTotal.inc({ trigger: tick.trigger });

    await db.prepare(
        `INSERT INTO scheduler_ticks (id, tick_key, scheduled_at, started_at, finished_at, trigger, state, outcome, run_id, reason_code, policy_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
        tickId,
        tick.tickKey,
        tick.scheduledAt,
        tick.startedAt ?? null,
        tick.finishedAt ?? null,
        tick.trigger,
        tick.state,
        tick.outcome ?? null,
        tick.runId ?? null,
        tick.reasonCode ?? null,
        String(tick.policyVersion),
    ).run();

    const row = await db.prepare(
        'SELECT * FROM scheduler_ticks WHERE tick_key = ?',
    ).bind(tick.tickKey).first<Record<string, unknown>>();
    if (!row) {
        // D1 eventual consistency or a mock DB may not reflect the insert immediately.
        // Return a best-effort tick so the caller can proceed without crashing.
        return {
            id: tickId,
            tickKey: tick.tickKey,
            scheduledAt: tick.scheduledAt,
            startedAt: tick.startedAt ?? null,
            finishedAt: tick.finishedAt ?? null,
            trigger: tick.trigger,
            state: tick.state,
            outcome: tick.outcome ?? null,
            runId: tick.runId ?? null,
            reasonCode: tick.reasonCode ?? null,
            policyVersion: tick.policyVersion,
        };
    }
    return mapTick(row);
}

/**
 * Update a scheduler tick's state, outcome, run_id, and reason_code.
 * Only updates fields that are explicitly provided (non-null).
 */
export async function updateSchedulerTick(
    db: D1DatabaseLike,
    tickKey: string,
    updates: {
        state?: TickState;
        outcome?: TickOutcome | null;
        runId?: string | null;
        reasonCode?: ReasonCode | null;
        startedAt?: string | null;
        finishedAt?: string | null;
    },
): Promise<void> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.state !== undefined) { setClauses.push('state = ?'); params.push(updates.state); }
    if (updates.outcome !== undefined) { setClauses.push('outcome = ?'); params.push(updates.outcome); }
    if (updates.runId !== undefined) { setClauses.push('run_id = ?'); params.push(updates.runId); }
    if (updates.reasonCode !== undefined) { setClauses.push('reason_code = ?'); params.push(updates.reasonCode); }
    if (updates.startedAt !== undefined) { setClauses.push('started_at = ?'); params.push(updates.startedAt); }
    if (updates.finishedAt !== undefined) { setClauses.push('finished_at = ?'); params.push(updates.finishedAt); }

    if (setClauses.length === 0) return;

    // Emit scheduler lag when a tick transitions to RUNNING
    if (updates.state === 'RUNNING' && updates.startedAt) {
        const tick = await db.prepare(
            'SELECT scheduled_at FROM scheduler_ticks WHERE tick_key = ?',
        ).bind(tickKey).first<{ scheduled_at: string }>();
        if (tick?.scheduled_at) {
            const lagMs = new Date(updates.startedAt).getTime() - new Date(tick.scheduled_at).getTime();
            if (lagMs >= 0) {
                metrics.schedulerLagSeconds.observe({}, lagMs / 1000);
            }
        }
    }

    params.push(tickKey);
    await db.prepare(
        `UPDATE scheduler_ticks SET ${setClauses.join(', ')} WHERE tick_key = ?`,
    ).bind(...params).run();
}

/**
 * Insert a probe attempt in its initial state (QUEUED or LEASED).
 */
export async function recordProbeAttempt(
    db: D1DatabaseLike,
    attempt: ProbeAttempt,
): Promise<ProbeAttempt> {
    await db.prepare(
        `INSERT INTO probe_attempts (
            id, run_id, task_id, parent_type, parent_id, model_id, attempt_no,
            purpose, provider_id, credential_account_id, credential_key_id,
            credential_binding_id, node_id, region,
            queued_at, leased_at, started_at, headers_at, first_byte_at,
            first_token_at, finished_at, received_at,
            state, classification, public_status, contributes_to_status,
            failure_domain, reason_code, evidence_source, retryability,
            timeout_stage, timeout_budget_ms,
            http_status, retry_after_seconds, retry_at, bytes_read,
            queue_wait_ms, ttft_ms, total_elapsed_ms, load_duration_ms,
            error_fingerprint, classifier_rule_version, policy_version, agent_version,
            experiment_id, assigned_arm, warmup_attempt_id, was_warmed,
            warmup_age_ms, experiment_config_version
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?
        )`,
    ).bind(
        attempt.id,
        attempt.runId,
        attempt.taskId || null,
        attempt.parentType || null,
        attempt.parentId || null,
        attempt.modelId,
        attempt.attemptNo,
        attempt.purpose || null,
        attempt.providerId,
        attempt.credentialAccountId || null,
        attempt.credentialKeyId || null,
        attempt.credentialBindingId || null,
        attempt.nodeId || null,
        attempt.region || null,
        attempt.queuedAt,
        attempt.leasedAt,
        attempt.startedAt,
        attempt.headersAt,
        attempt.firstByteAt,
        attempt.firstTokenAt,
        attempt.finishedAt,
        attempt.receivedAt,
        attempt.state,
        attempt.classification || null,
        attempt.publicStatus || null,
        attempt.contributesToStatus ? 1 : 0,
        attempt.failureDomain ?? null,
        attempt.reasonCode ?? null,
        attempt.evidenceSource ?? null,
        attempt.retryability ?? null,
        attempt.timeoutStage ?? null,
        attempt.timeoutBudgetMs ?? null,
        attempt.httpStatus ?? null,
        attempt.retryAfterSeconds ?? null,
        attempt.retryAt ?? null,
        attempt.bytesRead ?? null,
        attempt.queueWaitMs ?? null,
        attempt.ttftMs ?? null,
        attempt.totalElapsedMs ?? null,
        attempt.loadDurationMs ?? null,
        attempt.errorFingerprint ?? null,
        attempt.classifierRuleVersion != null ? String(attempt.classifierRuleVersion) : null,
        String(attempt.policyVersion),
        attempt.agentVersion ?? null,
        attempt.experimentId ?? null,
        attempt.assignedArm ?? null,
        attempt.warmupAttemptId ?? null,
        attempt.wasWarmed ? 1 : 0,
        attempt.warmupAgeMs ?? null,
        attempt.experimentConfigVersion != null ? String(attempt.experimentConfigVersion) : null,
    ).run();

    const row = await db.prepare('SELECT * FROM probe_attempts WHERE id = ?')
        .bind(attempt.id).first<Record<string, unknown>>();
    if (!row) throw new Error(`Failed to read back probe_attempt "${attempt.id}"`);

    metrics.probeAttemptsTotal.inc({ state: attempt.state, purpose: attempt.purpose || 'UNKNOWN' });

    return mapAttempt(row);
}

/** Input for result submission. */
export interface SubmissionInput {
    idempotencyKey: string;
    canonicalPayloadHash: string;
    taskId: string;
    nodeId: string;
    fencingToken: string;
}

/**
 * Decide the disposition for a result submission.
 *
 * Checks (in order):
 * 1. DUPLICATE — same (attempt_id, idempotency_key, canonical_payload_hash) already exists
 * 2. CONFLICT — attempt already has an ACCEPTED submission
 * 3. STALE    — submission received after the expectation deadline
 * 4. ACCEPTED — none of the above
 */
export async function acceptResult(
    db: D1DatabaseLike,
    attemptId: string,
    submission: SubmissionInput & { receivedAt: string },
): Promise<{ disposition: SubmissionDisposition; reasonCode?: ReasonCode }> {
    const attemptState = await db.prepare('SELECT state FROM probe_attempts WHERE id = ?')
        .bind(attemptId).first<{ state: string }>();
    if (!attemptState) throw new Error(`probe_attempt "${attemptId}" not found`);
    const terminalStates = terminalAttemptStateSet();
    if (terminalStates.has(attemptState.state)) {
        return { disposition: 'REJECTED', reasonCode: 'stale_result' };
    }

    // Check for exact duplicate
    const duplicate = await db.prepare(
        `SELECT 1 FROM result_submissions
         WHERE attempt_id = ? AND idempotency_key = ? AND canonical_payload_hash = ?`,
    ).bind(attemptId, submission.idempotencyKey, submission.canonicalPayloadHash)
        .first<{ 1: number }>();
    if (duplicate) return { disposition: 'DUPLICATE', reasonCode: 'duplicate_tick' };

    // Check for existing accepted submission
    const existingAccepted = await db.prepare(
        `SELECT 1 FROM result_submissions
         WHERE attempt_id = ? AND disposition = 'ACCEPTED'`,
    ).bind(attemptId).first<{ 1: number }>();
    if (existingAccepted) return { disposition: 'CONFLICT', reasonCode: 'stale_result' };

    // Check staleness: is the submission past the expectation deadline?
    const attempt = await db.prepare(
        'SELECT parent_type, parent_id FROM probe_attempts WHERE id = ?',
    ).bind(attemptId).first<{ parent_type: string | null; parent_id: string | null }>();
    if (!attempt) throw new Error(`probe_attempt "${attemptId}" not found`);

    if (attempt.parent_type === 'execution' && attempt.parent_id) {
        const exec = await db.prepare(
            'SELECT expectation_id FROM model_check_executions WHERE id = ?',
        ).bind(attempt.parent_id).first<{ expectation_id: string }>();
        if (exec) {
            const expectation = await db.prepare(
                'SELECT deadline_at FROM model_check_expectations WHERE id = ?',
            ).bind(exec.expectation_id).first<{ deadline_at: string | null }>();
            if (expectation?.deadline_at && submission.receivedAt > expectation.deadline_at) {
                return { disposition: 'STALE', reasonCode: 'stale_result' };
            }
        }
    }

    return { disposition: 'ACCEPTED' };
}

/**
 * Complete a probe attempt atomically:
 * 1. CAS update on probe_attempts (only if not already terminal)
 * 2. Insert result_submissions with disposition
 * 3. If ACCEPTED + contributes_to_status → insert check
 * 4. Update model_check_executions (attempt_count, accepted_attempt_id, terminal_reason_code)
 * 5. Update model_check_expectations (SATISFIED or MISSED)
 * 6. Insert probe_event
 * 7. Insert probe_outbox
 *
 * All writes happen in a single db.batch() transaction.
 */
export async function completeProbeAttempt(
    db: D1DatabaseLike,
    attemptId: string,
    result: ProbeResult,
    submission: SubmissionInput,
): Promise<ProbeAttempt> {
    const receivedAt = now();

    // ── Pre-transaction reads ──────────────────────────────────────────
    const attemptRow = await db.prepare('SELECT * FROM probe_attempts WHERE id = ?')
        .bind(attemptId).first<Record<string, unknown>>();
    if (!attemptRow) throw new Error(`probe_attempt "${attemptId}" not found`);

    const attempt = mapAttempt(attemptRow);

    // CAS pre-check: if already terminal, fail fast before any writes
    if (terminalAttemptStateSet().has(attempt.state)) {
        throw new Error(
            `CAS failed: probe_attempt "${attemptId}" is already in terminal state "${attempt.state}"`,
        );
    }

    // Determine disposition
    const { disposition, reasonCode: submissionReason } = await acceptResult(db, attemptId, {
        ...submission,
        receivedAt,
    });

    // Determine terminal state from result
    const terminalState: AttemptState = 'COMPLETED';

    // Gather execution/expectation info
    let executionId: string | null = null;
    let expectationId: string | null = null;
    let runId: string | null = null;
    if (attempt.parentType === 'execution' && attempt.parentId) {
        executionId = attempt.parentId;
        const exec = await db.prepare(
            'SELECT expectation_id, run_id FROM model_check_executions WHERE id = ?',
        ).bind(executionId).first<{ expectation_id: string; run_id: string }>();
        if (exec) {
            expectationId = exec.expectation_id;
            runId = exec.run_id;
        }
    }

    // ── Build batch statements ─────────────────────────────────────────
    const statements = [];

    // 1. CAS update on probe_attempts
    const eventType = 'probe.completed';
    const eventId = id('pevt');
    const submissionId = id('sub');

    statements.push(
        db.prepare(
            `UPDATE probe_attempts SET
                state = ?, classification = ?, public_status = ?,
                http_status = ?, total_elapsed_ms = ?, ttft_ms = ?,
                load_duration_ms = ?, failure_domain = ?, reason_code = ?,
                evidence_source = ?, retryability = ?, timeout_stage = ?,
                timeout_budget_ms = ?, retry_after_seconds = ?,
                bytes_read = ?, finished_at = ?, received_at = ?,
                headers_at = COALESCE(headers_at, ?),
                first_byte_at = COALESCE(first_byte_at, ?),
                first_token_at = COALESCE(first_token_at, ?)
             WHERE id = ? AND state NOT IN (${terminalAttemptStatesSql()})`,
        ).bind(
            terminalState,
            result.classification,
            result.publicStatus,
            result.httpStatus ?? null,
            result.totalDurationMs ?? null,
            result.ttftMs ?? null,
            result.loadDurationMs ?? null,
            result.failureDomain ?? null,
            result.reasonCode ?? null,
            result.evidenceSource ?? null,
            result.retryability ?? null,
            result.timeoutStage ?? null,
            null, // timeout_budget_ms — set at attempt creation, not on result
            result.retryAfterSeconds ?? null,
            null, // bytes_read — not in ProbeResult, leave as-is
            receivedAt, // finished_at
            receivedAt, // received_at
            result.headersAt ?? null,
            result.firstByteAt ?? null,
            result.firstTokenAt ?? null,
            attemptId,
        ),
    );

    // 2. Insert result_submissions (skip if DUPLICATE — already exists)
    if (disposition !== 'DUPLICATE') {
        statements.push(
            db.prepare(
                `INSERT INTO result_submissions (id, attempt_id, task_id, received_at, node_id, fencing_token, idempotency_key, canonical_payload_hash, disposition, reason_code)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
                submissionId,
                attemptId,
                submission.taskId || null,
                receivedAt,
                submission.nodeId || null,
                submission.fencingToken || null,
                submission.idempotencyKey,
                submission.canonicalPayloadHash,
                disposition,
                submissionReason ?? null,
            ),
        );
    }

    // 3. If ACCEPTED and contributes_to_status → insert check
    if (disposition === 'ACCEPTED' && attempt.contributesToStatus) {
        const checkId = id('chk');
        const observationRole = purposeToObservationRole(attempt.purpose);
        statements.push(
            db.prepare(
                `INSERT INTO checks (id, provider_id, model_id, checked_at, classification, public_status,
                    http_status, total_duration_ms, rtt_ms, ttft_ms, load_duration_ms, error_code, error_hash,
                    execution_id, attempt_id, observation_role,
                    retry_after_seconds, timeout_stage, reason_code, failure_domain, region, purpose)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
                checkId,
                attempt.providerId,
                attempt.modelId,
                receivedAt,
                result.classification,
                result.publicStatus,
                result.httpStatus ?? null,
                result.totalDurationMs ?? null,
                result.rttMs,
                result.ttftMs ?? null,
                result.loadDurationMs ?? null,
                result.errorCode ?? null,
                null, // error_hash
                executionId,
                attemptId,
                observationRole,
                result.retryAfterSeconds ?? null,
                result.timeoutStage ?? null,
                result.reasonCode ?? null,
                result.failureDomain ?? null,
                attempt.region || null,
                attempt.purpose || null,
            ),
        );
    }

    // 4. Update model_check_executions
    if (executionId) {
        statements.push(
            db.prepare(
                `UPDATE model_check_executions SET
                    attempt_count = attempt_count + 1,
                    accepted_attempt_id = CASE WHEN ? = 'ACCEPTED' THEN ? ELSE accepted_attempt_id END,
                    terminal_reason_code = ?
                 WHERE id = ?`,
            ).bind(
                disposition,
                disposition === 'ACCEPTED' ? attemptId : null,
                result.reasonCode ?? null,
                executionId,
            ),
        );
    }

    // 5. Update model_check_expectations
    if (expectationId) {
        const newExpectationState = disposition === 'ACCEPTED' ? 'SATISFIED' : 'MISSED';
        statements.push(
            db.prepare(
                `UPDATE model_check_expectations SET state = ?, reason_code = ?, resolved_at = ?
                 WHERE id = ? AND state NOT IN ('SATISFIED', 'MISSED', 'CANCELLED')`,
            ).bind(newExpectationState, result.reasonCode ?? null, receivedAt, expectationId),
        );
    }

    // 6. Insert probe_event + 7. Insert probe_outbox
    const detailJson = JSON.stringify({
        classification: result.classification,
        reason_code: result.reasonCode ?? null,
        http_status: result.httpStatus ?? null,
        timeout_stage: result.timeoutStage ?? null,
    });
    statements.push(
        ...eventAndOutboxStatements(
            db,
            eventId,
            eventType,
            receivedAt,
            receivedAt,
            'probe_attempt',
            attemptId,
            runId,
            expectationId,
            executionId,
            submission.taskId || null,
            attemptId,
            detailJson,
        ),
    );

    // ── Execute transaction ────────────────────────────────────────────
    await db.batch(statements);

    if (result.classification === 'TIMEOUT') {
        metrics.probeTimeoutsTotal.inc({ timeout_stage: result.timeoutStage ?? 'NONE' });
    }
    if (result.ttftMs != null) {
        metrics.probeTtftSeconds.observe({ classification: result.classification }, result.ttftMs / 1000);
    }
    if (attempt.queueWaitMs != null) {
        metrics.probeQueueWaitSeconds.observe({}, attempt.queueWaitMs / 1000);
    }

    // ── Read back updated attempt ──────────────────────────────────────
    const updated = await db.prepare('SELECT * FROM probe_attempts WHERE id = ?')
        .bind(attemptId).first<Record<string, unknown>>();
    if (!updated) throw new Error(`Failed to read back probe_attempt "${attemptId}" after completion`);
    return mapAttempt(updated);
}

/**
 * Append-only event insert with detail_json validation against per-event_type allowlists.
 */
export async function recordProbeEvent(
    db: D1DatabaseLike,
    event: {
        eventType: string;
        eventVersion: number;
        occurredAt: string;
        actorType?: string;
        actorId?: string;
        subjectType?: string;
        subjectId?: string;
        schedulerTickId?: string | null;
        runId?: string | null;
        expectationId?: string | null;
        executionId?: string | null;
        taskId?: string | null;
        attemptId?: string | null;
        causationEventId?: string | null;
        correlationId?: string | null;
        sequence?: number | null;
        idempotencyKey?: string | null;
        detailJson?: string | null;
        id?: string;
    },
): Promise<ProbeEvent> {
    const eventId = event.id ?? id('pevt');
    const recordedAt = now();

    validateDetailJson(event.eventType, event.detailJson ?? null);

    await db.prepare(
        `INSERT INTO probe_events (id, event_type, event_version, occurred_at, recorded_at,
            actor_type, actor_id, subject_type, subject_id,
            scheduler_tick_id, run_id, expectation_id, execution_id, task_id, attempt_id,
            causation_event_id, correlation_id, sequence, idempotency_key, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
        eventId,
        event.eventType,
        String(event.eventVersion),
        event.occurredAt,
        recordedAt,
        event.actorType ?? null,
        event.actorId ?? null,
        event.subjectType ?? null,
        event.subjectId ?? null,
        event.schedulerTickId ?? null,
        event.runId ?? null,
        event.expectationId ?? null,
        event.executionId ?? null,
        event.taskId ?? null,
        event.attemptId ?? null,
        event.causationEventId ?? null,
        event.correlationId ?? null,
        event.sequence ?? null,
        event.idempotencyKey ?? null,
        event.detailJson ?? null,
    ).run();

    const row = await db.prepare('SELECT * FROM probe_events WHERE id = ?')
        .bind(eventId).first<Record<string, unknown>>();
    if (!row) throw new Error(`Failed to read back probe_event "${eventId}"`);
    return mapEvent(row);
}

/**
 * Record a mitigation event with a transactional outbox row.
 * Batches the probe_event insert and probe_outbox insert together.
 */
export async function recordMitigationEvent(
    db: D1DatabaseLike,
    event: {
        eventType: string;
        eventVersion: number;
        occurredAt: string;
        actorType?: string;
        actorId?: string;
        subjectType?: string;
        subjectId?: string;
        expectationId?: string | null;
        detailJson?: string | null;
    },
): Promise<void> {
    const eventId = id('pevt');
    const recordedAt = now();

    validateDetailJson(event.eventType, event.detailJson ?? null);

    const statements = [
        db.prepare(
            `INSERT INTO probe_events (id, event_type, event_version, occurred_at, recorded_at,
                actor_type, actor_id, subject_type, subject_id,
                scheduler_tick_id, run_id, expectation_id, execution_id, task_id, attempt_id,
                causation_event_id, correlation_id, sequence, idempotency_key, detail_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
        ).bind(
            eventId,
            event.eventType,
            String(event.eventVersion),
            event.occurredAt,
            recordedAt,
            event.actorType ?? null,
            event.actorId ?? null,
            event.subjectType ?? null,
            event.subjectId ?? null,
            event.expectationId ?? null,
            event.detailJson ?? null,
        ),
        db.prepare(
            `INSERT INTO probe_outbox (id, event_id, consumed_at, consumer_id, attempts)
             VALUES (?, ?, NULL, NULL, 0)`,
        ).bind(id('pout'), eventId),
    ];

    await db.batch(statements);

    metrics.mitigationsTotal.inc({ event_type: event.eventType });
}

/**
 * Transition an expectation's state and emit the corresponding event + outbox row
 * in a single transaction.
 */
export async function updateExpectationState(
    db: D1DatabaseLike,
    expectationId: string,
    state: ExpectationState,
    reasonCode: ReasonCode | null,
): Promise<void> {
    const now_ = now();
    const eventType = expectationStateToEventType(state);
    const eventId = id('pevt');

    const statements = [
        db.prepare(
            `UPDATE model_check_expectations SET state = ?, reason_code = ?, resolved_at = ?
             WHERE id = ?`,
        ).bind(state, reasonCode ?? null, now_, expectationId),
        ...eventAndOutboxStatements(
            db,
            eventId,
            eventType,
            now_,
            now_,
            'model_check_expectation',
            expectationId,
            null,
            expectationId,
            null,
            null,
            null,
            null,
        ),
    ];

    await db.batch(statements);

    metrics.modelExpectationsTotal.inc({ state, reason_code: reasonCode ?? 'NONE' });
}

/**
 * Transition an execution's state and emit the corresponding event + outbox row
 * in a single transaction.
 */
export async function updateExecutionState(
    db: D1DatabaseLike,
    executionId: string,
    state: string,
    terminalReasonCode: ReasonCode | null,
    acceptedAttemptId: string | null,
): Promise<void> {
    const now_ = now();
    const eventType = executionStateToEventType(state);
    const eventId = id('pevt');

    const statements = [
        db.prepare(
            `UPDATE model_check_executions SET state = ?, terminal_reason_code = ?, accepted_attempt_id = ?
             WHERE id = ?`,
        ).bind(state, terminalReasonCode ?? null, acceptedAttemptId ?? null, executionId),
        ...eventAndOutboxStatements(
            db,
            eventId,
            eventType,
            now_,
            now_,
            'model_check_execution',
            executionId,
            null,
            null,
            executionId,
            null,
            null,
            null,
        ),
    ];

    await db.batch(statements);
}

// ── Event type mapping helpers ─────────────────────────────────────────────

function expectationStateToEventType(state: ExpectationState): string {
    switch (state) {
        case 'EXPECTED': return 'expectation.created';
        case 'SCHEDULED': return 'expectation.scheduled';
        case 'SUPPRESSED': return 'expectation.suppressed';
        case 'MISSED': return 'expectation.missed';
        case 'SATISFIED': return 'expectation.satisfied';
        case 'CANCELLED': return 'expectation.cancelled';
        default: return 'expectation.updated';
    }
}

function executionStateToEventType(state: string): string {
    switch (state) {
        case 'COMPLETED': return 'execution.completed';
        case 'FAILED': return 'execution.failed';
        case 'ABANDONED': return 'execution.abandoned';
        default: return 'execution.updated';
    }
}

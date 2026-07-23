import type { D1DatabaseLike, ModelCheckExpectation, ReasonCode } from './types.ts';
import { now } from './types.ts';
import { recordMitigationEvent } from './ledger.ts';
import type { MitigationFlags } from './config.ts';
import { mitigationFlags } from './config.ts';

// ── Mitigation action type ─────────────────────────────────────────────────

export interface MitigationAction {
    action: string;
    reason_code: ReasonCode;
    priority_delta: number;
    retry_after_seconds: number | null;
    circuit_breaker_target: string | null;
    dry_run: boolean;
    policy_version: number;
}

export interface MitigationOptions {
    retryAfterSeconds?: number | null;
    attemptNo?: number;
    maxRetries?: number;
    policyVersion?: number;
}

// ── Reason code → action mapping ───────────────────────────────────────────

const REQUEUE_REASONS: Set<ReasonCode> = new Set([
    'selection_limit',
    'run_budget_exceeded',
]);

const ALERT_REASONS: Set<ReasonCode> = new Set([
    'lock_contended',
    'credential_missing',
    'no_eligible_credential',
    'plan_access_denied',
    'subscription_required',
    'model_not_found',
    'empty_response',
    'catalog_unavailable',
    'catalog_protocol_error',
    'metadata_deferred',
]);

const REASSIGN_REASONS: Set<ReasonCode> = new Set([
    'node_offline',
    'no_eligible_node',
]);

const RETRY_AFTER_REASONS: Set<ReasonCode> = new Set([
    'credential_rate_limited',
    'credential_cooldown',
]);

const DISABLE_KEY_REASONS: Set<ReasonCode> = new Set([
    'credential_auth_failed',
]);

const CROSS_REGION_REASONS: Set<ReasonCode> = new Set([
    'timeout_before_headers',
    'timeout_waiting_first_byte',
    'timeout_waiting_first_token',
    'network_error',
]);

const BACKOFF_REASONS: Set<ReasonCode> = new Set([
    'provider_overloaded',
    'provider_http_5xx',
]);

const IDEMPOTENT_RETRY_REASONS: Set<ReasonCode> = new Set([
    'db_write_failed',
]);

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Propose a mitigation action for a given expectation and reason code.
 *
 * This is a **dry-run** engine in v1: it calculates the action, emits a
 * `mitigation.proposed` event via the ledger, but does NOT mutate any
 * database state (no expectation state change, no public_status change,
 * no credential disable, no warmup activation).
 *
 * Budget checks and slot deadline enforcement are applied before the
 * reason-code mapping to prevent proposing actions that would exceed
 * limits or target expired slots.
 */
export async function proposeMitigation(
    db: D1DatabaseLike,
    expectation: ModelCheckExpectation,
    reasonCode: ReasonCode,
    options: MitigationOptions = {},
    flags?: MitigationFlags,
): Promise<MitigationAction> {
    const policyVersion = options.policyVersion ?? 1;
    const attemptNo = options.attemptNo ?? 1;
    const maxRetries = options.maxRetries ?? 1;
    const now_ = now();
    const f = flags ?? mitigationFlags();

    // ── Guard: kill switch ─────────────────────────────────────────────
    if (f.killSwitch) {
        const action = buildAction('NO_ACTION', reasonCode, 0, null, null, policyVersion);
        await recordMitigationEvent(db, {
            eventType: 'mitigation.skipped',
            eventVersion: 1,
            occurredAt: now_,
            actorType: 'system',
            actorId: 'mitigations',
            subjectType: 'model_check_expectation',
            subjectId: expectation.id,
            expectationId: expectation.id,
            detailJson: JSON.stringify({
                reason_code: reasonCode,
                action: 'NO_ACTION',
                policy_version: String(policyVersion),
                kill_switch_active: 'true',
            }),
        });
        return action;
    }

    // ── Guard: slot deadline enforcement ───────────────────────────────
    if (expectation.deadlineAt) {
        const deadline = new Date(expectation.deadlineAt).getTime();
        if (Date.now() >= deadline) {
            const action = buildAction('NO_ACTION', reasonCode, 0, null, null, policyVersion);
            await recordMitigationEvent(db, {
                eventType: 'mitigation.skipped',
                eventVersion: 1,
                occurredAt: now_,
                actorType: 'system',
                actorId: 'mitigations',
                subjectType: 'model_check_expectation',
                subjectId: expectation.id,
                expectationId: expectation.id,
                detailJson: JSON.stringify({
                    reason_code: reasonCode,
                    action: 'NO_ACTION',
                    policy_version: String(policyVersion),
                    deadline_at: expectation.deadlineAt,
                }),
            });
            return action;
        }
    }

    // ── Guard: max retries exceeded ─────────────────────────────────────
    if (attemptNo > maxRetries) {
        const action = buildAction('NO_ACTION', reasonCode, 0, null, null, policyVersion);
        await recordMitigationEvent(db, {
            eventType: 'mitigation.skipped',
            eventVersion: 1,
            occurredAt: now_,
            actorType: 'system',
            actorId: 'mitigations',
            subjectType: 'model_check_expectation',
            subjectId: expectation.id,
            expectationId: expectation.id,
            detailJson: JSON.stringify({
                reason_code: reasonCode,
                action: 'NO_ACTION',
                policy_version: String(policyVersion),
            }),
        });
        return action;
    }

    // ── Per-flag gating ─────────────────────────────────────────────────
    // Map reason-code groups to the flag that gates them. When the flag is
    // off the action is downgraded to NO_ACTION and a mitigation.skipped
    // event is emitted instead of mitigation.proposed.
    let flagOff = false;
    if (REQUEUE_REASONS.has(reasonCode) && !f.requeueLease) flagOff = true;
    else if (REASSIGN_REASONS.has(reasonCode) && !f.requeueNode) flagOff = true;
    else if (CROSS_REGION_REASONS.has(reasonCode) && !f.routing) flagOff = true;
    else if (DISABLE_KEY_REASONS.has(reasonCode) && !f.circuitBreaker) flagOff = true;
    else if (BACKOFF_REASONS.has(reasonCode) && !f.circuitBreaker) flagOff = true;

    if (flagOff) {
        const action = buildAction('NO_ACTION', reasonCode, 0, null, null, policyVersion);
        await recordMitigationEvent(db, {
            eventType: 'mitigation.skipped',
            eventVersion: 1,
            occurredAt: now_,
            actorType: 'system',
            actorId: 'mitigations',
            subjectType: 'model_check_expectation',
            subjectId: expectation.id,
            expectationId: expectation.id,
            detailJson: JSON.stringify({
                reason_code: reasonCode,
                action: 'NO_ACTION',
                policy_version: String(policyVersion),
            }),
        });
        return action;
    }

    // ── Reason code dispatch ───────────────────────────────────────────
    let action: string;
    let priorityDelta = 0;
    let retryAfterSeconds: number | null = null;
    let circuitBreakerTarget: string | null = null;

    if (REQUEUE_REASONS.has(reasonCode)) {
        action = 'REQUEUE';
        priorityDelta = 1; // priority aging: bump priority so it gets picked sooner
    } else if (ALERT_REASONS.has(reasonCode)) {
        action = 'ALERT';
    } else if (REASSIGN_REASONS.has(reasonCode)) {
        action = 'REASSIGN';
        circuitBreakerTarget = 'node';
    } else if (RETRY_AFTER_REASONS.has(reasonCode)) {
        action = 'RETRY_AFTER';
        retryAfterSeconds = options.retryAfterSeconds ?? 60;
    } else if (DISABLE_KEY_REASONS.has(reasonCode)) {
        action = 'DISABLE_KEY';
        circuitBreakerTarget = 'credential';
    } else if (CROSS_REGION_REASONS.has(reasonCode)) {
        action = 'CROSS_REGION_CONFIRM';
        circuitBreakerTarget = 'region';
    } else if (BACKOFF_REASONS.has(reasonCode)) {
        action = 'BACKOFF';
        circuitBreakerTarget = 'provider';
        retryAfterSeconds = options.retryAfterSeconds ?? 30;
    } else if (IDEMPOTENT_RETRY_REASONS.has(reasonCode)) {
        action = 'IDEMPOTENT_RETRY';
    } else {
        action = 'NO_ACTION';
    }

    const mitigation = buildAction(
        action,
        reasonCode,
        priorityDelta,
        retryAfterSeconds,
        circuitBreakerTarget,
        policyVersion,
    );

    // ── Emit mitigation.proposed event (transactional outbox) ──
    await recordMitigationEvent(db, {
        eventType: 'mitigation.proposed',
        eventVersion: 1,
        occurredAt: now_,
        actorType: 'system',
        actorId: 'mitigations',
        subjectType: 'model_check_expectation',
        subjectId: expectation.id,
        expectationId: expectation.id,
        detailJson: JSON.stringify({
            reason_code: reasonCode,
            action,
            policy_version: String(policyVersion),
        }),
    });

    return mitigation;
}

/**
 * Apply a previously proposed mitigation action.
 *
 * Phase 5 hook: in v1 this is a dry-run — it emits a `mitigation.applied`
 * event via the transactional outbox but does NOT mutate any database state.
 * Real application (expectation state changes, credential disable, etc.)
 * will be implemented in a future phase.
 */
export async function applyMitigation(
    db: D1DatabaseLike,
    expectation: ModelCheckExpectation,
    action: MitigationAction,
): Promise<void> {
    await recordMitigationEvent(db, {
        eventType: 'mitigation.applied',
        eventVersion: 1,
        occurredAt: now(),
        actorType: 'system',
        actorId: 'mitigations',
        subjectType: 'model_check_expectation',
        subjectId: expectation.id,
        expectationId: expectation.id,
        detailJson: JSON.stringify({
            reason_code: action.reason_code,
            action: action.action,
            policy_version: String(action.policy_version),
        }),
    });
}

/**
 * Execute a previously proposed mitigation action with flag-aware gating.
 *
 * Gradual activation: checks the relevant feature flag for the action's
 * reason code. When the flag is on and the kill switch is off, the action
 * is executed (emits `mitigation.applied`). Otherwise, the action is
 * skipped (emits `mitigation.skipped`).
 *
 * Activation order: requeue lease/node first, then routing/circuit breaker.
 * Warmup remains disabled.
 *
 * In v1, "execution" is a dry-run — it emits the event via the
 * transactional outbox but does NOT mutate any database state.
 * Real application will be implemented in a future phase.
 */
export async function executeMitigation(
    db: D1DatabaseLike,
    action: MitigationAction,
    expectation: ModelCheckExpectation,
    flags?: MitigationFlags,
): Promise<void> {
    const f = flags ?? mitigationFlags();
    const now_ = now();
    const reasonCode = action.reason_code;

    // ── Guard: kill switch ─────────────────────────────────────────────
    if (f.killSwitch) {
        await recordMitigationEvent(db, {
            eventType: 'mitigation.skipped',
            eventVersion: 1,
            occurredAt: now_,
            actorType: 'system',
            actorId: 'mitigations',
            subjectType: 'model_check_expectation',
            subjectId: expectation.id,
            expectationId: expectation.id,
            detailJson: JSON.stringify({
                reason_code: reasonCode,
                action: action.action,
                policy_version: String(action.policy_version),
                kill_switch_active: 'true',
            }),
        });
        return;
    }

    // ── Per-flag gating (activation order: requeue → routing → circuit breaker) ──
    let flagOff = false;
    if (REQUEUE_REASONS.has(reasonCode) && !f.requeueLease) flagOff = true;
    else if (REASSIGN_REASONS.has(reasonCode) && !f.requeueNode) flagOff = true;
    else if (CROSS_REGION_REASONS.has(reasonCode) && !f.routing) flagOff = true;
    else if (DISABLE_KEY_REASONS.has(reasonCode) && !f.circuitBreaker) flagOff = true;
    else if (BACKOFF_REASONS.has(reasonCode) && !f.circuitBreaker) flagOff = true;

    if (flagOff) {
        await recordMitigationEvent(db, {
            eventType: 'mitigation.skipped',
            eventVersion: 1,
            occurredAt: now_,
            actorType: 'system',
            actorId: 'mitigations',
            subjectType: 'model_check_expectation',
            subjectId: expectation.id,
            expectationId: expectation.id,
            detailJson: JSON.stringify({
                reason_code: reasonCode,
                action: action.action,
                policy_version: String(action.policy_version),
            }),
        });
        return;
    }

    // ── Execute: flag is on, kill switch is off ─────────────────────────
    await recordMitigationEvent(db, {
        eventType: 'mitigation.applied',
        eventVersion: 1,
        occurredAt: now_,
        actorType: 'system',
        actorId: 'mitigations',
        subjectType: 'model_check_expectation',
        subjectId: expectation.id,
        expectationId: expectation.id,
        detailJson: JSON.stringify({
            reason_code: reasonCode,
            action: action.action,
            policy_version: String(action.policy_version),
        }),
    });
}

// ── Internal helpers ──────────────────────────────────────────────────────

function buildAction(
    action: string,
    reasonCode: ReasonCode,
    priorityDelta: number,
    retryAfterSeconds: number | null,
    circuitBreakerTarget: string | null,
    policyVersion: number,
): MitigationAction {
    return {
        action,
        reason_code: reasonCode,
        priority_delta: priorityDelta,
        retry_after_seconds: retryAfterSeconds,
        circuit_breaker_target: circuitBreakerTarget,
        dry_run: true,
        policy_version: policyVersion,
    };
}

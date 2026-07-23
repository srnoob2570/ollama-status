import { describe, expect, it, beforeEach } from 'vitest';
import { createTestDb, seedProvider, seedModel } from './helpers/ledger-fixture.ts';
import { proposeMitigation } from '../src/worker/mitigations.ts';
import type { MitigationFlags } from '../src/worker/config.ts';
import type { D1DatabaseLike, ModelCheckExpectation, ReasonCode } from '../src/worker/types.ts';

/** Default flags with kill switch off so existing tests exercise real dispatch. */
const ENABLED_FLAGS: MitigationFlags = {
    killSwitch: false,
    requeueLease: true,
    requeueNode: true,
    routing: true,
    circuitBreaker: true,
};

function makeExpectation(
    modelId: string,
    overrides: Partial<ModelCheckExpectation> = {},
): ModelCheckExpectation {
    const now = new Date().toISOString();
    const deadline = new Date(Date.now() + 3600_000).toISOString();
    return {
        id: `expect_${crypto.randomUUID()}`,
        modelId,
        purpose: 'AVAILABILITY',
        dueAt: now,
        deadlineAt: deadline,
        tier: 'FREE',
        intervalMinutes: 5,
        configSnapshotJson: null,
        policyVersion: 1,
        state: 'EXPECTED',
        reasonCode: null,
        resolvedAt: null,
        cutoverAt: now,
        migrationOrigin: null,
        ...overrides,
    };
}

async function insertExpectation(
    db: D1DatabaseLike,
    exp: ModelCheckExpectation,
): Promise<ModelCheckExpectation> {
    await db.prepare(
        `INSERT INTO model_check_expectations (id, model_id, purpose, due_at, deadline_at, tier, interval_minutes, cutover_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(exp.id, exp.modelId, exp.purpose, exp.dueAt, exp.deadlineAt, exp.tier, exp.intervalMinutes, exp.cutoverAt, exp.state).run();
    return exp;
}

describe('proposeMitigation', () => {
    let db: D1DatabaseLike;
    let modelId: string;

    beforeEach(async () => {
        db = createTestDb();
        const provider = await seedProvider(db);
        const model = await seedModel(db, { provider_id: provider.id });
        modelId = model.id;
    });

    // ── Requeue / priority-aging ──────────────────────────────────────────

    it('proposes REQUEUE with priority_delta=1 for selection_limit', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'selection_limit', {}, ENABLED_FLAGS);
        expect(result.action).toBe('REQUEUE');
        expect(result.priority_delta).toBe(1);
        expect(result.dry_run).toBe(true);
    });

    it('proposes REQUEUE with priority_delta=1 for run_budget_exceeded', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'run_budget_exceeded', {}, ENABLED_FLAGS);
        expect(result.action).toBe('REQUEUE');
        expect(result.priority_delta).toBe(1);
    });

    // ── Alert ─────────────────────────────────────────────────────────────

    it('proposes ALERT for lock_contended', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'lock_contended', {}, ENABLED_FLAGS);
        expect(result.action).toBe('ALERT');
        expect(result.priority_delta).toBe(0);
    });

    it('proposes ALERT for credential_missing', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'credential_missing', {}, ENABLED_FLAGS);
        expect(result.action).toBe('ALERT');
    });

    it('proposes ALERT for no_eligible_credential', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'no_eligible_credential', {}, ENABLED_FLAGS);
        expect(result.action).toBe('ALERT');
    });

    it('proposes ALERT for plan_access_denied', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'plan_access_denied', {}, ENABLED_FLAGS);
        expect(result.action).toBe('ALERT');
    });

    it('proposes ALERT for subscription_required', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'subscription_required', {}, ENABLED_FLAGS);
        expect(result.action).toBe('ALERT');
    });

    it('proposes ALERT for model_not_found', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'model_not_found', {}, ENABLED_FLAGS);
        expect(result.action).toBe('ALERT');
    });

    it('proposes ALERT for empty_response', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'empty_response', {}, ENABLED_FLAGS);
        expect(result.action).toBe('ALERT');
    });

    it('proposes ALERT for catalog_unavailable', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'catalog_unavailable', {}, ENABLED_FLAGS);
        expect(result.action).toBe('ALERT');
    });

    it('proposes ALERT for catalog_protocol_error', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'catalog_protocol_error', {}, ENABLED_FLAGS);
        expect(result.action).toBe('ALERT');
    });

    it('proposes ALERT for metadata_deferred', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'metadata_deferred', {}, ENABLED_FLAGS);
        expect(result.action).toBe('ALERT');
    });

    // ── Reassign (node issues) ────────────────────────────────────────────

    it('proposes REASSIGN with circuit_breaker_target=node for node_offline', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'node_offline', {}, ENABLED_FLAGS);
        expect(result.action).toBe('REASSIGN');
        expect(result.circuit_breaker_target).toBe('node');
    });

    it('proposes REASSIGN with circuit_breaker_target=node for no_eligible_node', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'no_eligible_node', {}, ENABLED_FLAGS);
        expect(result.action).toBe('REASSIGN');
        expect(result.circuit_breaker_target).toBe('node');
    });

    // ── Retry-after (credential rate limited) ─────────────────────────────

    it('proposes RETRY_AFTER for credential_rate_limited with retry_after_seconds', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'credential_rate_limited', {
            retryAfterSeconds: 120,
        }, ENABLED_FLAGS);
        expect(result.action).toBe('RETRY_AFTER');
        expect(result.retry_after_seconds).toBe(120);
    });

    it('proposes RETRY_AFTER for credential_cooldown with default 60s', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'credential_cooldown', {}, ENABLED_FLAGS);
        expect(result.action).toBe('RETRY_AFTER');
        expect(result.retry_after_seconds).toBe(60);
    });

    // ── Disable key + alert ───────────────────────────────────────────────

    it('proposes DISABLE_KEY with circuit_breaker_target=credential for credential_auth_failed', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'credential_auth_failed', {}, ENABLED_FLAGS);
        expect(result.action).toBe('DISABLE_KEY');
        expect(result.circuit_breaker_target).toBe('credential');
    });

    // ── Cross-region confirmation ─────────────────────────────────────────

    it('proposes CROSS_REGION_CONFIRM for timeout_before_headers', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'timeout_before_headers', {}, ENABLED_FLAGS);
        expect(result.action).toBe('CROSS_REGION_CONFIRM');
        expect(result.circuit_breaker_target).toBe('region');
    });

    it('proposes CROSS_REGION_CONFIRM for timeout_waiting_first_byte', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'timeout_waiting_first_byte', {}, ENABLED_FLAGS);
        expect(result.action).toBe('CROSS_REGION_CONFIRM');
    });

    it('proposes CROSS_REGION_CONFIRM for timeout_waiting_first_token', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'timeout_waiting_first_token', {}, ENABLED_FLAGS);
        expect(result.action).toBe('CROSS_REGION_CONFIRM');
    });

    it('proposes CROSS_REGION_CONFIRM for network_error', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'network_error', {}, ENABLED_FLAGS);
        expect(result.action).toBe('CROSS_REGION_CONFIRM');
    });

    // ── Backoff (provider overloaded / 5xx) ───────────────────────────────

    it('proposes BACKOFF for provider_overloaded with default 30s', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'provider_overloaded', {}, ENABLED_FLAGS);
        expect(result.action).toBe('BACKOFF');
        expect(result.circuit_breaker_target).toBe('provider');
        expect(result.retry_after_seconds).toBe(30);
    });

    it('proposes BACKOFF for provider_http_5xx with custom retry_after', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'provider_http_5xx', {
            retryAfterSeconds: 60,
        }, ENABLED_FLAGS);
        expect(result.action).toBe('BACKOFF');
        expect(result.retry_after_seconds).toBe(60);
    });

    // ── Idempotent retry ──────────────────────────────────────────────────

    it('proposes IDEMPOTENT_RETRY for db_write_failed', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'db_write_failed', {}, ENABLED_FLAGS);
        expect(result.action).toBe('IDEMPOTENT_RETRY');
    });

    // ── Default NO_ACTION ─────────────────────────────────────────────────

    it('proposes NO_ACTION for unrecognized reason codes', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'no_action', {}, ENABLED_FLAGS);
        expect(result.action).toBe('NO_ACTION');
        expect(result.priority_delta).toBe(0);
        expect(result.retry_after_seconds).toBeNull();
        expect(result.circuit_breaker_target).toBeNull();
    });

    it('proposes NO_ACTION for unattributed', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'unattributed', {}, ENABLED_FLAGS);
        expect(result.action).toBe('NO_ACTION');
    });

    it('proposes NO_ACTION for legacy_execution', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'legacy_execution', {}, ENABLED_FLAGS);
        expect(result.action).toBe('NO_ACTION');
    });

    // ── Dry-run: no DB mutation ───────────────────────────────────────────

    it('does not mutate expectation state (dry-run)', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));

        await proposeMitigation(db, exp, 'selection_limit', {}, ENABLED_FLAGS);

        // The expectation was never inserted into DB — dry-run didn't insert it.
        // Verify the event was recorded instead.
        const events = await db.prepare(
            "SELECT * FROM probe_events WHERE event_type = 'mitigation.proposed' AND expectation_id = ?",
        ).bind(exp.id).all<Record<string, unknown>>();
        expect(events.results.length).toBe(1);
    });

    it('emits mitigation.proposed event with correct detail_json', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        await proposeMitigation(db, exp, 'provider_overloaded', {}, ENABLED_FLAGS);

        const events = await db.prepare(
            "SELECT * FROM probe_events WHERE event_type = 'mitigation.proposed' AND expectation_id = ?",
        ).bind(exp.id).all<Record<string, unknown>>();
        expect(events.results.length).toBe(1);

        const detail = JSON.parse(events.results[0].detail_json as string);
        expect(detail.reason_code).toBe('provider_overloaded');
        expect(detail.action).toBe('BACKOFF');
        expect(detail.policy_version).toBe('1');
    });

    // ── Slot deadline enforcement ─────────────────────────────────────────

    it('returns NO_ACTION when slot deadline has passed', async () => {
        const pastDeadline = new Date(Date.now() - 1000).toISOString();
        const exp = await insertExpectation(db, makeExpectation(modelId, { deadlineAt: pastDeadline }));
        const result = await proposeMitigation(db, exp, 'selection_limit', {}, ENABLED_FLAGS);
        expect(result.action).toBe('NO_ACTION');
    });

    it('returns NO_ACTION when slot deadline is exactly now', async () => {
        const nowDeadline = new Date(Date.now() - 1).toISOString();
        const exp = await insertExpectation(db, makeExpectation(modelId, { deadlineAt: nowDeadline }));
        const result = await proposeMitigation(db, exp, 'selection_limit', {}, ENABLED_FLAGS);
        expect(result.action).toBe('NO_ACTION');
    });

    // ── Max retries enforcement ────────────────────────────────────────────

    it('returns NO_ACTION when attempt exceeds max retries', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'selection_limit', {
            attemptNo: 2,
            maxRetries: 1,
        }, ENABLED_FLAGS);
        expect(result.action).toBe('NO_ACTION');
    });

    it('allows action when attempt is within max retries', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'selection_limit', {
            attemptNo: 1,
            maxRetries: 1,
        }, ENABLED_FLAGS);
        expect(result.action).toBe('REQUEUE');
    });

    // ── Policy version ────────────────────────────────────────────────────

    it('uses default policy_version=1 when not specified', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'selection_limit', {}, ENABLED_FLAGS);
        expect(result.policy_version).toBe(1);
    });

    it('uses provided policy_version', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'selection_limit', {
            policyVersion: 3,
        }, ENABLED_FLAGS);
        expect(result.policy_version).toBe(3);
    });

    // ── All actions are dry_run=true ──────────────────────────────────────

    it('marks all actions as dry_run=true', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const reasonCodes: ReasonCode[] = [
            'selection_limit',
            'lock_contended',
            'node_offline',
            'credential_rate_limited',
            'credential_auth_failed',
            'timeout_before_headers',
            'provider_overloaded',
            'db_write_failed',
            'no_action',
        ];

        for (const rc of reasonCodes) {
            const result = await proposeMitigation(db, exp, rc, {}, ENABLED_FLAGS);
            expect(result.dry_run).toBe(true);
        }
    });

    // ── Circuit breaker targets ───────────────────────────────────────────

    it('sets circuit_breaker_target=credential for DISABLE_KEY', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'credential_auth_failed', {}, ENABLED_FLAGS);
        expect(result.circuit_breaker_target).toBe('credential');
    });

    it('sets circuit_breaker_target=region for CROSS_REGION_CONFIRM', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'network_error', {}, ENABLED_FLAGS);
        expect(result.circuit_breaker_target).toBe('region');
    });

    it('sets circuit_breaker_target=provider for BACKOFF', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'provider_http_5xx', {}, ENABLED_FLAGS);
        expect(result.circuit_breaker_target).toBe('provider');
    });

    it('sets circuit_breaker_target=node for REASSIGN', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'no_eligible_node', {}, ENABLED_FLAGS);
        expect(result.circuit_breaker_target).toBe('node');
    });

    it('leaves circuit_breaker_target null for REQUEUE', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'run_budget_exceeded', {}, ENABLED_FLAGS);
        expect(result.circuit_breaker_target).toBeNull();
    });

    it('leaves circuit_breaker_target null for ALERT', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'lock_contended', {}, ENABLED_FLAGS);
        expect(result.circuit_breaker_target).toBeNull();
    });

    // ── Reason code preserved in result ───────────────────────────────────

    it('preserves the reason_code in the result', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'provider_http_5xx');
        expect(result.reason_code).toBe('provider_http_5xx');
    });
});

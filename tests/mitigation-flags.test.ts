import { describe, expect, it, beforeEach } from 'vitest';
import { createTestDb, seedProvider, seedModel } from './helpers/ledger-fixture.ts';
import { proposeMitigation } from '../src/worker/mitigations.ts';
import { mitigationFlags } from '../src/worker/config.ts';
import type { MitigationFlags } from '../src/worker/config.ts';
import type { D1DatabaseLike, ModelCheckExpectation } from '../src/worker/types.ts';

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

describe('mitigationFlags()', () => {
    it('defaults killSwitch to true', () => {
        const flags = mitigationFlags({});
        expect(flags.killSwitch).toBe(true);
    });

    it('defaults per-feature flags to false', () => {
        const flags = mitigationFlags({});
        expect(flags.requeueLease).toBe(false);
        expect(flags.requeueNode).toBe(false);
        expect(flags.routing).toBe(false);
        expect(flags.circuitBreaker).toBe(false);
    });

    it('reads kill switch from env', () => {
        const flags = mitigationFlags({ MITIGATION_KILL_SWITCH: 'false' });
        expect(flags.killSwitch).toBe(false);
    });

    it('reads per-feature flags from env', () => {
        const flags = mitigationFlags({
            MITIGATION_REQUEUE_LEASE: 'true',
            MITIGATION_REQUEUE_NODE: 'true',
            MITIGATION_ROUTING: 'true',
            MITIGATION_CIRCUIT_BREAKER: 'true',
        });
        expect(flags.requeueLease).toBe(true);
        expect(flags.requeueNode).toBe(true);
        expect(flags.routing).toBe(true);
        expect(flags.circuitBreaker).toBe(true);
    });

    it('is case-insensitive for env values', () => {
        const flags = mitigationFlags({
            MITIGATION_KILL_SWITCH: 'False',
            MITIGATION_REQUEUE_LEASE: 'TRUE',
        });
        expect(flags.killSwitch).toBe(false);
        expect(flags.requeueLease).toBe(true);
    });

    it('treats non-"true" values as false', () => {
        const flags = mitigationFlags({
            MITIGATION_REQUEUE_LEASE: 'yes',
            MITIGATION_REQUEUE_NODE: '1',
        });
        expect(flags.requeueLease).toBe(false);
        expect(flags.requeueNode).toBe(false);
    });

    it('flags are independent', () => {
        const flags = mitigationFlags({ MITIGATION_REQUEUE_LEASE: 'true' });
        expect(flags.requeueLease).toBe(true);
        expect(flags.requeueNode).toBe(false);
        expect(flags.routing).toBe(false);
        expect(flags.circuitBreaker).toBe(false);
    });
});

describe('proposeMitigation with kill switch', () => {
    let db: D1DatabaseLike;
    let modelId: string;

    const KILLED_FLAGS: MitigationFlags = {
        killSwitch: true,
        requeueLease: true,
        requeueNode: true,
        routing: true,
        circuitBreaker: true,
    };

    beforeEach(async () => {
        db = createTestDb();
        const provider = await seedProvider(db);
        const model = await seedModel(db, { provider_id: provider.id });
        modelId = model.id;
    });

    it('returns NO_ACTION when kill switch is on', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'selection_limit', {}, KILLED_FLAGS);
        expect(result.action).toBe('NO_ACTION');
    });

    it('emits mitigation.skipped when kill switch is on', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        await proposeMitigation(db, exp, 'selection_limit', {}, KILLED_FLAGS);

        const events = await db.prepare(
            "SELECT * FROM probe_events WHERE event_type = 'mitigation.skipped' AND expectation_id = ?",
        ).bind(exp.id).all<Record<string, unknown>>();
        expect(events.results.length).toBe(1);

        const detail = JSON.parse(events.results[0].detail_json as string);
        expect(detail.kill_switch_active).toBe('true');
    });

    it('kill switch overrides all per-feature flags', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        // Even with all per-feature flags on, kill switch forces NO_ACTION
        const result = await proposeMitigation(db, exp, 'selection_limit', {}, KILLED_FLAGS);
        expect(result.action).toBe('NO_ACTION');
    });
});

describe('proposeMitigation with per-feature flags off', () => {
    let db: D1DatabaseLike;
    let modelId: string;

    const FLAGS_OFF: MitigationFlags = {
        killSwitch: false,
        requeueLease: false,
        requeueNode: false,
        routing: false,
        circuitBreaker: false,
    };

    beforeEach(async () => {
        db = createTestDb();
        const provider = await seedProvider(db);
        const model = await seedModel(db, { provider_id: provider.id });
        modelId = model.id;
    });

    it('returns NO_ACTION for REQUEUE when requeueLease is off', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'selection_limit', {}, FLAGS_OFF);
        expect(result.action).toBe('NO_ACTION');
    });

    it('returns NO_ACTION for REASSIGN when requeueNode is off', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'node_offline', {}, FLAGS_OFF);
        expect(result.action).toBe('NO_ACTION');
    });

    it('returns NO_ACTION for CROSS_REGION_CONFIRM when routing is off', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'timeout_before_headers', {}, FLAGS_OFF);
        expect(result.action).toBe('NO_ACTION');
    });

    it('returns NO_ACTION for DISABLE_KEY when circuitBreaker is off', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'credential_auth_failed', {}, FLAGS_OFF);
        expect(result.action).toBe('NO_ACTION');
    });

    it('returns NO_ACTION for BACKOFF when circuitBreaker is off', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'provider_overloaded', {}, FLAGS_OFF);
        expect(result.action).toBe('NO_ACTION');
    });

    it('still allows ALERT when per-feature flags are off', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'lock_contended', {}, FLAGS_OFF);
        expect(result.action).toBe('ALERT');
    });

    it('still allows RETRY_AFTER when per-feature flags are off', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'credential_rate_limited', {}, FLAGS_OFF);
        expect(result.action).toBe('RETRY_AFTER');
    });

    it('still allows IDEMPOTENT_RETRY when per-feature flags are off', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const result = await proposeMitigation(db, exp, 'db_write_failed', {}, FLAGS_OFF);
        expect(result.action).toBe('IDEMPOTENT_RETRY');
    });

    it('emits mitigation.skipped when per-feature flag blocks action', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        await proposeMitigation(db, exp, 'selection_limit', {}, FLAGS_OFF);

        const events = await db.prepare(
            "SELECT * FROM probe_events WHERE event_type = 'mitigation.skipped' AND expectation_id = ?",
        ).bind(exp.id).all<Record<string, unknown>>();
        expect(events.results.length).toBe(1);

        const detail = JSON.parse(events.results[0].detail_json as string);
        expect(detail.reason_code).toBe('selection_limit');
        expect(detail.action).toBe('NO_ACTION');
    });
});

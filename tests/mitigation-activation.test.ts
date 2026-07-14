import { describe, expect, it, beforeEach } from 'vitest';
import { createTestDb, seedProvider, seedModel } from './helpers/ledger-fixture.ts';
import { proposeMitigation, executeMitigation } from '../src/worker/mitigations.ts';
import type { MitigationFlags } from '../src/worker/config.ts';
import type { D1DatabaseLike, ModelCheckExpectation, ReasonCode } from '../src/worker/types.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

const ALL_ENABLED: MitigationFlags = {
    killSwitch: false,
    requeueLease: true,
    requeueNode: true,
    routing: true,
    circuitBreaker: true,
};

const ALL_DISABLED: MitigationFlags = {
    killSwitch: false,
    requeueLease: false,
    requeueNode: false,
    routing: false,
    circuitBreaker: false,
};

const KILLED: MitigationFlags = {
    killSwitch: true,
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

async function countEvents(
    db: D1DatabaseLike,
    eventType: string,
    expectationId: string,
): Promise<number> {
    const rows = await db.prepare(
        'SELECT COUNT(*) as cnt FROM probe_events WHERE event_type = ? AND expectation_id = ?',
    ).bind(eventType, expectationId).all<{ cnt: number }>();
    return rows.results[0]?.cnt ?? 0;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('executeMitigation — gradual activation', () => {
    let db: D1DatabaseLike;
    let modelId: string;

    beforeEach(async () => {
        db = createTestDb();
        const provider = await seedProvider(db);
        const model = await seedModel(db, { provider_id: provider.id });
        modelId = model.id;
    });

    // ── Flag on + kill switch off → applied ──────────────────────────────────

    it('emits mitigation.applied when flag is on and kill switch is off', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'selection_limit', {}, ALL_ENABLED);
        await executeMitigation(db, action, exp, ALL_ENABLED);

        const applied = await countEvents(db, 'mitigation.applied', exp.id);
        const skipped = await countEvents(db, 'mitigation.skipped', exp.id);
        expect(applied).toBe(1);
        expect(skipped).toBe(0);
    });

    it('emits mitigation.applied for REASSIGN when requeueNode is on', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'node_offline', {}, ALL_ENABLED);
        await executeMitigation(db, action, exp, ALL_ENABLED);

        const applied = await countEvents(db, 'mitigation.applied', exp.id);
        expect(applied).toBe(1);
    });

    it('emits mitigation.applied for CROSS_REGION_CONFIRM when routing is on', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'timeout_before_headers', {}, ALL_ENABLED);
        await executeMitigation(db, action, exp, ALL_ENABLED);

        const applied = await countEvents(db, 'mitigation.applied', exp.id);
        expect(applied).toBe(1);
    });

    it('emits mitigation.applied for DISABLE_KEY when circuitBreaker is on', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'credential_auth_failed', {}, ALL_ENABLED);
        await executeMitigation(db, action, exp, ALL_ENABLED);

        const applied = await countEvents(db, 'mitigation.applied', exp.id);
        expect(applied).toBe(1);
    });

    it('emits mitigation.applied for BACKOFF when circuitBreaker is on', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'provider_overloaded', {}, ALL_ENABLED);
        await executeMitigation(db, action, exp, ALL_ENABLED);

        const applied = await countEvents(db, 'mitigation.applied', exp.id);
        expect(applied).toBe(1);
    });

    // ── Flag off → skipped ───────────────────────────────────────────────────

    it('emits mitigation.skipped when requeueLease is off', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'selection_limit', {}, ALL_ENABLED);
        await executeMitigation(db, action, exp, ALL_DISABLED);

        const applied = await countEvents(db, 'mitigation.applied', exp.id);
        const skipped = await countEvents(db, 'mitigation.skipped', exp.id);
        expect(applied).toBe(0);
        expect(skipped).toBe(1);
    });

    it('emits mitigation.skipped when requeueNode is off', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'node_offline', {}, ALL_ENABLED);
        await executeMitigation(db, action, exp, ALL_DISABLED);

        const applied = await countEvents(db, 'mitigation.applied', exp.id);
        const skipped = await countEvents(db, 'mitigation.skipped', exp.id);
        expect(applied).toBe(0);
        expect(skipped).toBe(1);
    });

    it('emits mitigation.skipped when routing is off', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'timeout_before_headers', {}, ALL_ENABLED);
        await executeMitigation(db, action, exp, ALL_DISABLED);

        const applied = await countEvents(db, 'mitigation.applied', exp.id);
        const skipped = await countEvents(db, 'mitigation.skipped', exp.id);
        expect(applied).toBe(0);
        expect(skipped).toBe(1);
    });

    it('emits mitigation.skipped when circuitBreaker is off (DISABLE_KEY)', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'credential_auth_failed', {}, ALL_ENABLED);
        await executeMitigation(db, action, exp, ALL_DISABLED);

        const applied = await countEvents(db, 'mitigation.applied', exp.id);
        const skipped = await countEvents(db, 'mitigation.skipped', exp.id);
        expect(applied).toBe(0);
        expect(skipped).toBe(1);
    });

    it('emits mitigation.skipped when circuitBreaker is off (BACKOFF)', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'provider_overloaded', {}, ALL_ENABLED);
        await executeMitigation(db, action, exp, ALL_DISABLED);

        const applied = await countEvents(db, 'mitigation.applied', exp.id);
        const skipped = await countEvents(db, 'mitigation.skipped', exp.id);
        expect(applied).toBe(0);
        expect(skipped).toBe(1);
    });

    // ── Kill switch → skipped ───────────────────────────────────────────────

    it('emits mitigation.skipped when kill switch is on (overrides all flags)', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'selection_limit', {}, ALL_ENABLED);
        await executeMitigation(db, action, exp, KILLED);

        const applied = await countEvents(db, 'mitigation.applied', exp.id);
        const skipped = await countEvents(db, 'mitigation.skipped', exp.id);
        expect(applied).toBe(0);
        expect(skipped).toBe(1);
    });

    it('kill switch skipped event includes kill_switch_active in detail', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'selection_limit', {}, ALL_ENABLED);
        await executeMitigation(db, action, exp, KILLED);

        const events = await db.prepare(
            "SELECT * FROM probe_events WHERE event_type = 'mitigation.skipped' AND expectation_id = ?",
        ).bind(exp.id).all<Record<string, unknown>>();
        expect(events.results.length).toBe(1);

        const detail = JSON.parse(events.results[0].detail_json as string);
        expect(detail.kill_switch_active).toBe('true');
    });

    // ── Activation order: requeue lease/node before routing/circuit breaker ──

    it('activates requeue lease before routing', async () => {
        const onlyRequeue: MitigationFlags = {
            killSwitch: false,
            requeueLease: true,
            requeueNode: false,
            routing: false,
            circuitBreaker: false,
        };

        // REQUEUE should be applied
        const exp1 = await insertExpectation(db, makeExpectation(modelId, {
            id: `expect_${crypto.randomUUID()}`,
            dueAt: new Date(Date.now() + 60_000).toISOString(),
        }));
        const action1 = await proposeMitigation(db, exp1, 'selection_limit', {}, ALL_ENABLED);
        await executeMitigation(db, action1, exp1, onlyRequeue);
        expect(await countEvents(db, 'mitigation.applied', exp1.id)).toBe(1);

        // ROUTING should be skipped
        const exp2 = await insertExpectation(db, makeExpectation(modelId, {
            id: `expect_${crypto.randomUUID()}`,
            dueAt: new Date(Date.now() + 120_000).toISOString(),
        }));
        const action2 = await proposeMitigation(db, exp2, 'timeout_before_headers', {}, ALL_ENABLED);
        await executeMitigation(db, action2, exp2, onlyRequeue);
        expect(await countEvents(db, 'mitigation.skipped', exp2.id)).toBe(1);
    });

    it('activates requeue node before circuit breaker', async () => {
        const onlyRequeueNode: MitigationFlags = {
            killSwitch: false,
            requeueLease: false,
            requeueNode: true,
            routing: false,
            circuitBreaker: false,
        };

        // REASSIGN should be applied
        const exp1 = await insertExpectation(db, makeExpectation(modelId, {
            id: `expect_${crypto.randomUUID()}`,
            dueAt: new Date(Date.now() + 60_000).toISOString(),
        }));
        const action1 = await proposeMitigation(db, exp1, 'node_offline', {}, ALL_ENABLED);
        await executeMitigation(db, action1, exp1, onlyRequeueNode);
        expect(await countEvents(db, 'mitigation.applied', exp1.id)).toBe(1);

        // CIRCUIT BREAKER should be skipped
        const exp2 = await insertExpectation(db, makeExpectation(modelId, {
            id: `expect_${crypto.randomUUID()}`,
            dueAt: new Date(Date.now() + 120_000).toISOString(),
        }));
        const action2 = await proposeMitigation(db, exp2, 'credential_auth_failed', {}, ALL_ENABLED);
        await executeMitigation(db, action2, exp2, onlyRequeueNode);
        expect(await countEvents(db, 'mitigation.skipped', exp2.id)).toBe(1);
    });

    // ── Rollback: disabling flag returns to skipped ──────────────────────────

    it('rollback: disabling flag after activation returns to skipped', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'selection_limit', {}, ALL_ENABLED);

        // First: flag on → applied
        await executeMitigation(db, action, exp, ALL_ENABLED);
        expect(await countEvents(db, 'mitigation.applied', exp.id)).toBe(1);

        // Rollback: flag off → skipped
        await executeMitigation(db, action, exp, ALL_DISABLED);
        expect(await countEvents(db, 'mitigation.skipped', exp.id)).toBe(1);
    });

    it('rollback: kill switch returns to skipped', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'selection_limit', {}, ALL_ENABLED);

        // First: flag on → applied
        await executeMitigation(db, action, exp, ALL_ENABLED);
        expect(await countEvents(db, 'mitigation.applied', exp.id)).toBe(1);

        // Rollback: kill switch on → skipped
        await executeMitigation(db, action, exp, KILLED);
        expect(await countEvents(db, 'mitigation.skipped', exp.id)).toBe(1);
    });

    // ── No 429s, duplicate checks, or false incidents ────────────────────────

    it('does not produce duplicate applied events for same execution', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'selection_limit', {}, ALL_ENABLED);

        // Single execution → single applied event
        await executeMitigation(db, action, exp, ALL_ENABLED);
        expect(await countEvents(db, 'mitigation.applied', exp.id)).toBe(1);
    });

    it('does not emit applied when flag is off (no false incidents)', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'selection_limit', {}, ALL_ENABLED);

        await executeMitigation(db, action, exp, ALL_DISABLED);

        const applied = await countEvents(db, 'mitigation.applied', exp.id);
        expect(applied).toBe(0);
    });

    it('does not mutate expectation state (dry-run)', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'selection_limit', {}, ALL_ENABLED);
        await executeMitigation(db, action, exp, ALL_ENABLED);

        // Expectation state should remain unchanged
        const row = await db.prepare(
            'SELECT state FROM model_check_expectations WHERE id = ?',
        ).bind(exp.id).first<{ state: string }>();
        expect(row!.state).toBe('EXPECTED');
    });

    // ── Warmup remains disabled ─────────────────────────────────────────────

    it('does not activate warmup (no warmup flag exists)', async () => {
        // Verify that the MitigationFlags interface has no warmup field
        const flags: MitigationFlags = ALL_ENABLED;
        expect((flags as unknown as Record<string, unknown>).warmup).toBeUndefined();
    });

    // ── Outbox integrity ────────────────────────────────────────────────────

    it('creates outbox row for applied events', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'selection_limit', {}, ALL_ENABLED);
        await executeMitigation(db, action, exp, ALL_ENABLED);

        const events = await db.prepare(
            "SELECT * FROM probe_events WHERE event_type = 'mitigation.applied' AND expectation_id = ?",
        ).bind(exp.id).all<Record<string, unknown>>();
        expect(events.results.length).toBe(1);

        const outbox = await db.prepare(
            'SELECT * FROM probe_outbox WHERE event_id = ?',
        ).bind(events.results[0].id).first<Record<string, unknown>>();
        expect(outbox).not.toBeNull();
        expect(outbox!.consumed_at).toBeNull();
    });

    it('creates outbox row for skipped events', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'selection_limit', {}, ALL_ENABLED);
        await executeMitigation(db, action, exp, ALL_DISABLED);

        const events = await db.prepare(
            "SELECT * FROM probe_events WHERE event_type = 'mitigation.skipped' AND expectation_id = ?",
        ).bind(exp.id).all<Record<string, unknown>>();
        expect(events.results.length).toBe(1);

        const outbox = await db.prepare(
            'SELECT * FROM probe_outbox WHERE event_id = ?',
        ).bind(events.results[0].id).first<Record<string, unknown>>();
        expect(outbox).not.toBeNull();
    });

    // ── All reason code groups covered ───────────────────────────────────────

    it('covers all reason code groups with correct activation', async () => {
        const cases: [ReasonCode, string, keyof MitigationFlags][] = [
            ['selection_limit', 'REQUEUE', 'requeueLease'],
            ['run_budget_exceeded', 'REQUEUE', 'requeueLease'],
            ['node_offline', 'REASSIGN', 'requeueNode'],
            ['no_eligible_node', 'REASSIGN', 'requeueNode'],
            ['timeout_before_headers', 'CROSS_REGION_CONFIRM', 'routing'],
            ['timeout_waiting_first_byte', 'CROSS_REGION_CONFIRM', 'routing'],
            ['timeout_waiting_first_token', 'CROSS_REGION_CONFIRM', 'routing'],
            ['network_error', 'CROSS_REGION_CONFIRM', 'routing'],
            ['credential_auth_failed', 'DISABLE_KEY', 'circuitBreaker'],
            ['provider_overloaded', 'BACKOFF', 'circuitBreaker'],
            ['provider_http_5xx', 'BACKOFF', 'circuitBreaker'],
        ];

        for (const [i, [reasonCode, expectedAction, flagKey]] of cases.entries()) {
            const exp = await insertExpectation(db, makeExpectation(modelId, {
                id: `expect_${crypto.randomUUID()}`,
                dueAt: new Date(Date.now() + (i + 1) * 60_000).toISOString(),
            }));
            const action = await proposeMitigation(db, exp, reasonCode, {}, ALL_ENABLED);
            expect(action.action).toBe(expectedAction);

            // With flag on → applied
            await executeMitigation(db, action, exp, ALL_ENABLED);
            expect(await countEvents(db, 'mitigation.applied', exp.id)).toBe(1);

            // With flag off → skipped (new expectation for clean count)
            const exp2 = await insertExpectation(db, makeExpectation(modelId, {
                id: `expect_${crypto.randomUUID()}`,
                dueAt: new Date(Date.now() + (i + 1) * 60_000 + 30_000).toISOString(),
            }));
            const action2 = await proposeMitigation(db, exp2, reasonCode, {}, ALL_ENABLED);
            const flagOff: MitigationFlags = { ...ALL_ENABLED, [flagKey]: false };
            await executeMitigation(db, action2, exp2, flagOff);
            expect(await countEvents(db, 'mitigation.skipped', exp2.id)).toBe(1);
        }
    });
});

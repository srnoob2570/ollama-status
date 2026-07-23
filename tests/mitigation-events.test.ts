import { describe, expect, it, beforeEach } from 'vitest';
import { createTestDb, seedProvider, seedModel } from './helpers/ledger-fixture.ts';
import { proposeMitigation, applyMitigation } from '../src/worker/mitigations.ts';
import { recordMitigationEvent } from '../src/worker/ledger.ts';
import type { MitigationFlags } from '../src/worker/config.ts';
import type { D1DatabaseLike, ModelCheckExpectation, ReasonCode } from '../src/worker/types.ts';

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

describe('mitigation events', () => {
    let db: D1DatabaseLike;
    let modelId: string;

    beforeEach(async () => {
        db = createTestDb();
        const provider = await seedProvider(db);
        const model = await seedModel(db, { provider_id: provider.id });
        modelId = model.id;
    });

    // ── mitigation.proposed ────────────────────────────────────────────────

    it('emits mitigation.proposed event with outbox row', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        await proposeMitigation(db, exp, 'selection_limit', {}, ENABLED_FLAGS);

        const events = await db.prepare(
            "SELECT * FROM probe_events WHERE event_type = 'mitigation.proposed' AND expectation_id = ?",
        ).bind(exp.id).all<Record<string, unknown>>();
        expect(events.results.length).toBe(1);

        const event = events.results[0];
        expect(event.event_type).toBe('mitigation.proposed');
        expect(event.event_version).toBe(1);
        expect(event.actor_type).toBe('system');
        expect(event.actor_id).toBe('mitigations');
        expect(event.subject_type).toBe('model_check_expectation');
        expect(event.subject_id).toBe(exp.id);
        expect(event.expectation_id).toBe(exp.id);

        // Verify outbox row exists
        const outbox = await db.prepare(
            'SELECT * FROM probe_outbox WHERE event_id = ?',
        ).bind(event.id).first<Record<string, unknown>>();
        expect(outbox).not.toBeNull();
        expect(outbox!.consumed_at).toBeNull();
        expect(outbox!.attempts).toBe(0);

        // Verify detail_json
        const detail = JSON.parse(event.detail_json as string);
        expect(detail.reason_code).toBe('selection_limit');
        expect(detail.action).toBe('REQUEUE');
        expect(detail.policy_version).toBe('1');
    });

    it('emits mitigation.proposed with correct action for each reason code', async () => {
        const cases: [ReasonCode, string][] = [
            ['selection_limit', 'REQUEUE'],
            ['lock_contended', 'ALERT'],
            ['node_offline', 'REASSIGN'],
            ['credential_rate_limited', 'RETRY_AFTER'],
            ['credential_auth_failed', 'DISABLE_KEY'],
            ['timeout_before_headers', 'CROSS_REGION_CONFIRM'],
            ['provider_overloaded', 'BACKOFF'],
            ['db_write_failed', 'IDEMPOTENT_RETRY'],
        ];

        for (const [i, [reasonCode, expectedAction]] of cases.entries()) {
            const exp2 = await insertExpectation(db, makeExpectation(modelId, {
                id: `expect_${crypto.randomUUID()}`,
                dueAt: new Date(Date.now() + (i + 1) * 60_000).toISOString(),
            }));
            await proposeMitigation(db, exp2, reasonCode, {}, ENABLED_FLAGS);

            const events = await db.prepare(
                "SELECT * FROM probe_events WHERE event_type = 'mitigation.proposed' AND expectation_id = ?",
            ).bind(exp2.id).all<Record<string, unknown>>();
            expect(events.results.length).toBe(1);
            const detail = JSON.parse(events.results[0].detail_json as string);
            expect(detail.action).toBe(expectedAction);
            expect(detail.reason_code).toBe(reasonCode);
        }
    });

    // ── mitigation.skipped ──────────────────────────────────────────────────

    it('emits mitigation.skipped when slot deadline has passed', async () => {
        const pastDeadline = new Date(Date.now() - 1000).toISOString();
        const exp = await insertExpectation(db, makeExpectation(modelId, { deadlineAt: pastDeadline }));
        await proposeMitigation(db, exp, 'selection_limit', {}, ENABLED_FLAGS);

        const events = await db.prepare(
            "SELECT * FROM probe_events WHERE event_type = 'mitigation.skipped' AND expectation_id = ?",
        ).bind(exp.id).all<Record<string, unknown>>();
        expect(events.results.length).toBe(1);

        const event = events.results[0];
        expect(event.event_type).toBe('mitigation.skipped');
        expect(event.actor_type).toBe('system');
        expect(event.actor_id).toBe('mitigations');

        // Verify outbox row
        const outbox = await db.prepare(
            'SELECT * FROM probe_outbox WHERE event_id = ?',
        ).bind(event.id).first<Record<string, unknown>>();
        expect(outbox).not.toBeNull();

        // Verify detail_json includes deadline_at
        const detail = JSON.parse(event.detail_json as string);
        expect(detail.reason_code).toBe('selection_limit');
        expect(detail.action).toBe('NO_ACTION');
        expect(detail.policy_version).toBe('1');
        expect(detail.deadline_at).toBe(pastDeadline);
    });

    it('emits mitigation.skipped when max retries exceeded', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        await proposeMitigation(db, exp, 'selection_limit', {
            attemptNo: 2,
            maxRetries: 1,
        }, ENABLED_FLAGS);

        const events = await db.prepare(
            "SELECT * FROM probe_events WHERE event_type = 'mitigation.skipped' AND expectation_id = ?",
        ).bind(exp.id).all<Record<string, unknown>>();
        expect(events.results.length).toBe(1);

        const detail = JSON.parse(events.results[0].detail_json as string);
        expect(detail.reason_code).toBe('selection_limit');
        expect(detail.action).toBe('NO_ACTION');
        expect(detail.policy_version).toBe('1');
    });

    // ── mitigation.applied (Phase 5 dry-run) ──────────────────────────────

    it('emits mitigation.applied via applyMitigation', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        const action = await proposeMitigation(db, exp, 'selection_limit', {}, ENABLED_FLAGS);
        await applyMitigation(db, exp, action);

        const events = await db.prepare(
            "SELECT * FROM probe_events WHERE event_type = 'mitigation.applied' AND expectation_id = ?",
        ).bind(exp.id).all<Record<string, unknown>>();
        expect(events.results.length).toBe(1);

        const event = events.results[0];
        expect(event.event_type).toBe('mitigation.applied');
        expect(event.actor_type).toBe('system');
        expect(event.actor_id).toBe('mitigations');

        // Verify outbox row
        const outbox = await db.prepare(
            'SELECT * FROM probe_outbox WHERE event_id = ?',
        ).bind(event.id).first<Record<string, unknown>>();
        expect(outbox).not.toBeNull();

        // Verify detail_json
        const detail = JSON.parse(event.detail_json as string);
        expect(detail.reason_code).toBe('selection_limit');
        expect(detail.action).toBe('REQUEUE');
        expect(detail.policy_version).toBe('1');
    });

    // ── recordMitigationEvent validation ────────────────────────────────────

    it('rejects non-allowlisted detail_json keys for mitigation.proposed', async () => {
        await expect(
            recordMitigationEvent(db, {
                eventType: 'mitigation.proposed',
                eventVersion: 1,
                occurredAt: new Date().toISOString(),
                detailJson: JSON.stringify({ secret_field: 'should not be allowed' }),
            }),
        ).rejects.toThrow('not allowed in detail_json');
    });

    it('rejects non-allowlisted detail_json keys for mitigation.skipped', async () => {
        await expect(
            recordMitigationEvent(db, {
                eventType: 'mitigation.skipped',
                eventVersion: 1,
                occurredAt: new Date().toISOString(),
                detailJson: JSON.stringify({ secret_field: 'should not be allowed' }),
            }),
        ).rejects.toThrow('not allowed in detail_json');
    });

    it('rejects non-allowlisted detail_json keys for mitigation.applied', async () => {
        await expect(
            recordMitigationEvent(db, {
                eventType: 'mitigation.applied',
                eventVersion: 1,
                occurredAt: new Date().toISOString(),
                detailJson: JSON.stringify({ secret_field: 'should not be allowed' }),
            }),
        ).rejects.toThrow('not allowed in detail_json');
    });

    it('allows all allowlisted fields in mitigation events', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        await recordMitigationEvent(db, {
            eventType: 'mitigation.proposed',
            eventVersion: 1,
            occurredAt: new Date().toISOString(),
            actorType: 'system',
            actorId: 'mitigations',
            subjectType: 'model_check_expectation',
            subjectId: exp.id,
            expectationId: exp.id,
            detailJson: JSON.stringify({
                reason_code: 'selection_limit',
                action: 'REQUEUE',
                policy_version: '1',
                deadline_at: new Date().toISOString(),
                budget_remaining: '42.5',
                kill_switch_active: 'false',
            }),
        });
    });

    // ── Transactional outbox ───────────────────────────────────────────────

    it('creates both event and outbox row in same transaction', async () => {
        const exp = await insertExpectation(db, makeExpectation(modelId));
        await proposeMitigation(db, exp, 'provider_overloaded', {}, ENABLED_FLAGS);

        const events = await db.prepare(
            "SELECT * FROM probe_events WHERE event_type = 'mitigation.proposed' AND expectation_id = ?",
        ).bind(exp.id).all<Record<string, unknown>>();
        expect(events.results.length).toBe(1);

        const outbox = await db.prepare(
            'SELECT * FROM probe_outbox WHERE event_id = ?',
        ).bind(events.results[0].id).first<Record<string, unknown>>();
        expect(outbox).not.toBeNull();
    });
});

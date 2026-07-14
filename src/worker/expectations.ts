import type { D1DatabaseLike } from './types.ts';
import { id, now } from './types.ts';
import { nominalCheckIntervalMinutes, type CheckIntervalConfig } from './status.ts';

export interface MaterializeOptions {
    horizonMinutes?: number;
    nowIso?: string;
    policyVersion: string;
    config?: CheckIntervalConfig;
    cutoverAt?: string;
}

async function ensureWatermarkTable(db: D1DatabaseLike): Promise<void> {
    await db
        .prepare(
            `CREATE TABLE IF NOT EXISTS _expectation_watermarks (
                policy_version TEXT PRIMARY KEY,
                watermark      TEXT NOT NULL
            )`,
        )
        .run();
}

export async function getWatermark(
    db: D1DatabaseLike,
    policyVersion: string,
): Promise<string | null> {
    await ensureWatermarkTable(db);
    const row = await db
        .prepare('SELECT watermark FROM _expectation_watermarks WHERE policy_version = ?')
        .bind(policyVersion)
        .first<{ watermark: string }>();
    return row?.watermark ?? null;
}

export async function setWatermark(
    db: D1DatabaseLike,
    policyVersion: string,
    watermark: string,
): Promise<void> {
    await ensureWatermarkTable(db);
    await db
        .prepare(
            `INSERT INTO _expectation_watermarks (policy_version, watermark)
             VALUES (?, ?)
             ON CONFLICT (policy_version) DO UPDATE SET watermark = excluded.watermark`,
        )
        .bind(policyVersion, watermark)
        .run();
}

interface CooldownWindow {
    modelId: string;
    until: string;
    reasonCode: string;
}

async function getCooldownWindows(db: D1DatabaseLike): Promise<CooldownWindow[]> {
    const rows = await db
        .prepare(
            `SELECT model_id, public_status, next_check_at
             FROM provider_model_status
             WHERE public_status IN ('RATE_LIMITED', 'AUTHENTICATION')
               AND next_check_at IS NOT NULL`,
        )
        .all<{ model_id: string; public_status: string; next_check_at: string }>();

    return rows.results.map((r) => ({
        modelId: r.model_id,
        until: r.next_check_at,
        reasonCode:
            r.public_status === 'RATE_LIMITED'
                ? 'credential_rate_limited'
                : 'credential_auth_failed',
    }));
}

export async function materializeExpectations(
    db: D1DatabaseLike,
    options: MaterializeOptions,
): Promise<number> {
    const {
        horizonMinutes = 120,
        nowIso = now(),
        policyVersion,
        config = {},
        cutoverAt,
    } = options;

    const horizonMs = horizonMinutes * 60_000;
    const nowMs = new Date(nowIso).getTime();

    const storedWatermark = await getWatermark(db, policyVersion);
    const effectiveCutover = cutoverAt ?? storedWatermark ?? nowIso;
    const cutoverMs = new Date(effectiveCutover).getTime();

    const models = await db
        .prepare('SELECT id, tier FROM models WHERE active = 1 AND excluded = 0')
        .all<{ id: string; tier: string }>();

    const cooldowns = await getCooldownWindows(db);
    const cooldownByModel = new Map<string, CooldownWindow[]>();
    for (const c of cooldowns) {
        const list = cooldownByModel.get(c.modelId) ?? [];
        list.push(c);
        cooldownByModel.set(c.modelId, list);
    }

    const configSnapshot = JSON.stringify(config);
    let generated = 0;
    let latestDueAt = effectiveCutover;

    for (const model of models.results) {
        const tier = (model.tier === 'PAID' ? 'PAID' : 'FREE') as 'FREE' | 'PAID';
        const intervalMin = nominalCheckIntervalMinutes(tier, config);

        const purposes: string[] = ['AVAILABILITY'];
        if (tier === 'PAID') purposes.push('ENTITLEMENT');

        for (const purpose of purposes) {
            const modelCooldowns = cooldownByModel.get(model.id) ?? [];

            for (
                let slotMs = cutoverMs;
                slotMs < nowMs + horizonMs;
                slotMs += intervalMin * 60_000
            ) {
                const dueAt = new Date(slotMs).toISOString();
                const deadlineAt = new Date(slotMs + intervalMin * 60_000).toISOString();

                const activeCooldown = modelCooldowns.find(
                    (c) => new Date(dueAt) < new Date(c.until),
                );
                const state = activeCooldown ? 'SUPPRESSED' : 'EXPECTED';
                const reasonCode = activeCooldown?.reasonCode ?? null;

                await db
                    .prepare(
                        `INSERT INTO model_check_expectations
                         (id, model_id, purpose, due_at, deadline_at, tier,
                          interval_minutes, config_snapshot_json, policy_version,
                          state, reason_code, cutover_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT (model_id, purpose, due_at) DO NOTHING`,
                    )
                    .bind(
                        id('expect'),
                        model.id,
                        purpose,
                        dueAt,
                        deadlineAt,
                        tier,
                        intervalMin,
                        configSnapshot,
                        policyVersion,
                        state,
                        reasonCode ?? null,
                        effectiveCutover,
                    )
                    .run();

                generated++;
                if (dueAt > latestDueAt) latestDueAt = dueAt;
            }
        }
    }

    if (latestDueAt > effectiveCutover) {
        await setWatermark(db, policyVersion, latestDueAt);
    }

    return generated;
}

export async function cancelExpectationsForPolicyChange(
    db: D1DatabaseLike,
    oldPolicyVersion: string,
    _newPolicyVersion: string,
    nowIso?: string,
): Promise<number> {
    const now_ = nowIso ?? now();

    const result = await db
        .prepare(
            `DELETE FROM model_check_expectations
             WHERE policy_version = ?
               AND state IN ('EXPECTED', 'SCHEDULED')
               AND due_at >= ?`,
        )
        .bind(oldPolicyVersion, now_)
        .run();

    return result.meta.changes;
}

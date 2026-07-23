import type { D1DatabaseLike } from './types.ts';
import { round4 } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export interface HourlyExecutionRollup {
    modelId: string;
    hourAt: string;
    purpose: string;
    tier: string;
    nominalExpected: number;
    satisfied: number;
    suppressed: number;
    missed: number;
    cancelled: number;
    nominalCoverage: number | null;
    policyAdherence: number | null;
    dominantReason: string | null;
}

// ── Compute ──────────────────────────────────────────────────────────────────

/**
 * Compute the hourly execution rollup for a given (model_id, hour_at, purpose)
 * from `model_check_expectations` only — never from physical `checks` rows.
 *
 * Counts 1 slot per expectation row, regardless of how many physical probe
 * attempts or checks were produced (e.g. PAID models produce 2 purposes but
 * each is counted as 1 slot).
 *
 * Idempotent: same inputs always produce the same result.
 */
export async function computeHourlyRollup(
    db: D1DatabaseLike,
    modelId: string,
    hourAt: string,
    purpose: string,
): Promise<HourlyExecutionRollup> {
    const hourStart = hourAt;
    const hourEnd = new Date(new Date(hourStart).getTime() + 60 * 60_000).toISOString();

    // ── Count expectations by state ──────────────────────────────────────────
    const [counts, dominantRow, tierRow] = await Promise.all([
        db
            .prepare(
                `SELECT
                    COUNT(*)                                                         AS total,
                    COALESCE(SUM(CASE WHEN state = 'SATISFIED'  THEN 1 ELSE 0 END), 0) AS satisfied,
                    COALESCE(SUM(CASE WHEN state = 'SUPPRESSED' THEN 1 ELSE 0 END), 0) AS suppressed,
                    COALESCE(SUM(CASE WHEN state = 'MISSED'     THEN 1 ELSE 0 END), 0) AS missed,
                    COALESCE(SUM(CASE WHEN state = 'CANCELLED'  THEN 1 ELSE 0 END), 0) AS cancelled
                 FROM model_check_expectations
                 WHERE model_id = ?
                   AND purpose = ?
                   AND due_at >= ?
                   AND due_at < ?`,
            )
            .bind(modelId, purpose, hourStart, hourEnd)
            .first<{
                total: number;
                satisfied: number;
                suppressed: number;
                missed: number;
                cancelled: number;
            }>(),
        db
            .prepare(
                `SELECT reason_code, COUNT(*) AS cnt
                 FROM model_check_expectations
                 WHERE model_id = ?
                   AND purpose = ?
                   AND due_at >= ?
                   AND due_at < ?
                   AND state IN ('SUPPRESSED', 'MISSED', 'CANCELLED')
                   AND reason_code IS NOT NULL
                 GROUP BY reason_code
                 ORDER BY cnt DESC
                 LIMIT 1`,
            )
            .bind(modelId, purpose, hourStart, hourEnd)
            .first<{ reason_code: string; cnt: number }>(),
        db
            .prepare(
                `SELECT tier, COUNT(*) AS cnt
                 FROM model_check_expectations
                 WHERE model_id = ?
                   AND purpose = ?
                   AND due_at >= ?
                   AND due_at < ?
                 GROUP BY tier
                 ORDER BY cnt DESC
                 LIMIT 1`,
            )
            .bind(modelId, purpose, hourStart, hourEnd)
            .first<{ tier: string; cnt: number }>(),
    ]);

    const total = counts?.total ?? 0;
    const satisfied = counts?.satisfied ?? 0;
    const suppressed = counts?.suppressed ?? 0;
    const missed = counts?.missed ?? 0;
    const cancelled = counts?.cancelled ?? 0;
    const dominantReason = dominantRow?.reason_code ?? null;
    const tier = tierRow?.tier ?? 'FREE';

    // ── Ratios ────────────────────────────────────────────────────────────
    const nominalCoverage = total > 0 ? round4(satisfied / total) : null;
    const policyAdherence = total > 0 ? round4((satisfied + suppressed) / total) : null;

    return {
        modelId,
        hourAt: hourStart,
        purpose,
        tier,
        nominalExpected: total,
        satisfied,
        suppressed,
        missed,
        cancelled,
        nominalCoverage,
        policyAdherence,
        dominantReason,
    };
}

// ── Upsert ────────────────────────────────────────────────────────────────────

/**
 * Compute and persist a single hourly execution rollup row.
 *
 * Idempotent: re-computing the same (model_id, hour_at, purpose) produces
 * the same result and the ON CONFLICT clause makes it safe to call repeatedly.
 */
export async function upsertHourlyExecutionRollup(
    db: D1DatabaseLike,
    modelId: string,
    hourAt: string,
    purpose: string,
): Promise<HourlyExecutionRollup> {
    const rollup = await computeHourlyRollup(db, modelId, hourAt, purpose);

    await db
        .prepare(
            `INSERT INTO hourly_execution_rollups
             (model_id, hour_at, purpose, tier,
              nominal_expected, satisfied, suppressed, missed, cancelled,
              nominal_coverage, policy_adherence, dominant_reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (model_id, hour_at, purpose) DO UPDATE SET
               tier              = excluded.tier,
               nominal_expected  = excluded.nominal_expected,
               satisfied         = excluded.satisfied,
               suppressed        = excluded.suppressed,
               missed            = excluded.missed,
               cancelled         = excluded.cancelled,
               nominal_coverage  = excluded.nominal_coverage,
               policy_adherence  = excluded.policy_adherence,
               dominant_reason   = excluded.dominant_reason`,
        )
        .bind(
            rollup.modelId,
            rollup.hourAt,
            rollup.purpose,
            rollup.tier,
            rollup.nominalExpected,
            rollup.satisfied,
            rollup.suppressed,
            rollup.missed,
            rollup.cancelled,
            rollup.nominalCoverage,
            rollup.policyAdherence,
            rollup.dominantReason,
        )
        .run();

    return rollup;
}

// ── Helpers ───────────────────────────────────────────────────────────────────


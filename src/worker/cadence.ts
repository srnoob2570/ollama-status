import type { D1DatabaseLike, CadenceWindow, CadenceWindowState, ReasonCode } from './types.ts';
import { now } from './types.ts';
import { metrics } from './metrics.ts';
import { round4 } from './utils.ts';

// ── Public types ───────────────────────────────────────────────────────────────

export interface CadenceOptions {
    /** Coverage target for HEALTHY state (default 0.90). */
    target?: number;
    /** Override current time for deterministic testing. */
    nowIso?: string;
    /**
     * Whether the immediately preceding window of the same duration was below
     * target.  When true and this window is also below target, the state
     * becomes BREACHED ("dos ventanas consecutivas", spec line 343).
     *
     * Callers (e.g. the API) supply this by querying `hourly_execution_rollups`
     * for the prior window so `analyzeCadence` stays pure.  Defaults to false.
     */
    previousWindowBreached?: boolean;
}

// ── Window parsing ────────────────────────────────────────────────────────────

interface ParsedWindow {
    from: string;
    to: string;
    label: string;
}

const DURATION_RE = /^(\d+)(m|h|d)$/;

function parseWindow(raw: string, nowIso: string): ParsedWindow {
    // ISO range: "2026-07-13T00:00:00Z/2026-07-14T00:00:00Z"
    if (raw.includes('/')) {
        const [from, to] = raw.split('/');
        return { from: from.trim(), to: to.trim(), label: raw };
    }

    const m = raw.match(DURATION_RE);
    if (!m) {
        throw new Error(
            `Invalid cadence window "${raw}". Use a duration (1h, 24h, 7d) or ISO range (from/to).`,
        );
    }

    const value = Number(m[1]);
    const unit = m[2];
    const nowMs = new Date(nowIso).getTime();

    let durationMs: number;
    switch (unit) {
        case 'm':
            durationMs = value * 60_000;
            break;
        case 'h':
            durationMs = value * 3_600_000;
            break;
        case 'd':
            durationMs = value * 86_400_000;
            break;
        default:
            throw new Error(`Unknown duration unit: ${unit}`);
    }

    const from = new Date(nowMs - durationMs).toISOString();
    return { from, to: nowIso, label: raw };
}

// ── State classification ──────────────────────────────────────────────────────

function classifyState(
    nominalExpected: number,
    policyAdherence: number,
    target: number,
    hasUnattributedMissed: boolean,
    previousWindowBreached: boolean,
): CadenceWindowState {
    if (nominalExpected === 0) return 'INSUFFICIENT_DATA';
    // Unattributed MISSED is an instrumentation defect → BREACHED immediately (spec line 384).
    if (hasUnattributedMissed) return 'BREACHED';
    if (policyAdherence >= target) return 'HEALTHY';
    // Below target: two consecutive windows → BREACHED, otherwise DEGRADED.
    if (previousWindowBreached) return 'BREACHED';
    return 'DEGRADED';
}

// ── Dominant reason ───────────────────────────────────────────────────────────

function dominantReason(
    reasonCounts: Map<string, number>,
): ReasonCode | null {
    let best: ReasonCode | null = null;
    let bestCount = 0;
    for (const [code, count] of reasonCounts) {
        if (count > bestCount) {
            bestCount = count;
            best = code as ReasonCode;
        }
    }
    return best;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Analyze expectation-based cadence for a single model within a time window.
 *
 * Sources data exclusively from `model_check_expectations` — never from the
 * legacy `checks` table.  Each expectation row represents one nominal slot.
 *
 * **Slot accounting**
 * - CANCELLED expectations are excluded from `nominalExpected` (they were
 *   explicitly removed from the schedule and should not reduce the denominator).
 * - SUPPRESSED slots (cooldown, auth-failure back-off) are counted separately so
 *   that `nominalCoverage` (satisfied / nominalExpected) and `policyAdherence`
 *   ((satisfied + suppressed) / nominalExpected) can be distinguished.
 * - A PAID model with both AVAILABILITY and ENTITLEMENT purposes contributes
 *   one slot per purpose — never double-counted as 2 for the same event.
 * - Any observation (including errors, timeouts, degradations) that resolves a
 *   slot leaves it SATISFIED because cadence measures *whether* the check
 *   occurred, not its outcome.
 *
 * **State machine**
 *   INSUFFICIENT_DATA  →  nominalExpected === 0
 *   HEALTHY            →  policyAdherence >= target (default 0.90)
 *   DEGRADED           →  policyAdherence < target in a single window
 *   BREACHED           →  unattributed MISSED slots, OR below target in
 *                         two consecutive windows
 *
 * **Dominant reason**
 *   The most frequent `reason_code` among non-satisfied slots (MISSED +
 *   SUPPRESSED).  `unattributed` is treated as an instrumentation defect and
 *   still reported so operators can investigate.
 */
export async function analyzeCadence(
    db: D1DatabaseLike,
    modelId: string,
    window: string,
    options: CadenceOptions = {},
): Promise<CadenceWindow> {
    const target = options.target ?? 0.9;
    const nowIso = options.nowIso ?? now();
    const { from, to, label } = parseWindow(window, nowIso);

    const rows = await db
        .prepare(
            `SELECT state, reason_code
             FROM model_check_expectations
             WHERE model_id = ?
               AND due_at >= ?
               AND due_at < ?
             ORDER BY due_at`,
        )
        .bind(modelId, from, to)
        .all<{ state: string; reason_code: string | null }>();

    let satisfied = 0;
    let suppressed = 0;
    let missed = 0;
    let cancelled = 0;
    let unresolved = 0; // EXPECTED | SCHEDULED in a past window
    let unattributedMissed = 0;
    const reasonCounts = new Map<string, number>();

    for (const row of rows.results) {
        switch (row.state) {
            case 'SATISFIED':
                satisfied++;
                break;
            case 'SUPPRESSED':
                suppressed++;
                if (row.reason_code) {
                    reasonCounts.set(row.reason_code, (reasonCounts.get(row.reason_code) ?? 0) + 1);
                }
                break;
            case 'MISSED':
                missed++;
                if (!row.reason_code) {
                    unattributedMissed++; // instrumentation defect → BREACHED
                }
                if (row.reason_code) {
                    reasonCounts.set(row.reason_code, (reasonCounts.get(row.reason_code) ?? 0) + 1);
                }
                break;
            case 'CANCELLED':
                cancelled++;
                break;
            default:
                // EXPECTED | SCHEDULED — not yet resolved
                unresolved++;
                break;
        }
    }

    // CANCELLED expectations are excluded from the denominator.
    // Unresolved (EXPECTED/SCHEDULED) expectations in a past window are
    // counted in nominalExpected but not in any fulfilment bucket — they
    // drag down coverage honestly.
    const nominalExpected = satisfied + suppressed + missed + unresolved;

    const nominalCoverage = nominalExpected > 0 ? satisfied / nominalExpected : 0;
    const policyAdherence = nominalExpected > 0 ? (satisfied + suppressed) / nominalExpected : 0;
    const state = classifyState(
        nominalExpected,
        policyAdherence,
        target,
        unattributedMissed > 0,
        options.previousWindowBreached ?? false,
    );

    metrics.cadenceWindowsTotal.inc({ state, window: label });

    return {
        modelId,
        window: label,
        nominalExpected,
        satisfied,
        suppressed,
        missed,
        cancelled,
        nominalCoverage: round4(nominalCoverage),
        policyAdherence: round4(policyAdherence),
        state,
        dominantReason: dominantReason(reasonCounts),
        evaluatedAt: nowIso,
    };
}

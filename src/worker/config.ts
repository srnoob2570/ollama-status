/**
 * Feature flags for the mitigation engine.
 *
 * Each flag is independent — activating one does not activate others.
 * The kill switch, when active, forces all mitigations to be skipped
 * regardless of individual flag state.
 *
 * In v1 the kill switch defaults to `true` (dry-run / disabled).
 * Set `MITIGATION_KILL_SWITCH=false` to enable the mitigation engine.
 */

export interface MitigationFlags {
    /** Global kill switch. When true, all mitigations are skipped. */
    killSwitch: boolean;
    /** Allow requeue of expectations on selection_limit / run_budget_exceeded. */
    requeueLease: boolean;
    /** Allow reassign on node_offline / no_eligible_node. */
    requeueNode: boolean;
    /** Allow cross-region routing on timeout / network errors. */
    routing: boolean;
    /** Allow circuit-breaker actions (DISABLE_KEY, BACKOFF, etc.). */
    circuitBreaker: boolean;
}

/**
 * Read mitigation flags from environment variables.
 *
 * Env vars (all optional):
 *   MITIGATION_KILL_SWITCH   — default "true" (mitigations disabled in v1)
 *   MITIGATION_REQUEUE_LEASE — default "false"
 *   MITIGATION_REQUEUE_NODE  — default "false"
 *   MITIGATION_ROUTING       — default "false"
 *   MITIGATION_CIRCUIT_BREAKER — default "false"
 *
 * A flag is active when its env var is exactly "true" (case-insensitive).
 */
export function mitigationFlags(env: Record<string, string | undefined> = process.env): MitigationFlags {
    const truthy = (v: string | undefined): boolean => v?.toLowerCase() === 'true';
    return {
        killSwitch: truthy(env.MITIGATION_KILL_SWITCH ?? 'true'),
        requeueLease: truthy(env.MITIGATION_REQUEUE_LEASE),
        requeueNode: truthy(env.MITIGATION_REQUEUE_NODE),
        routing: truthy(env.MITIGATION_ROUTING),
        circuitBreaker: truthy(env.MITIGATION_CIRCUIT_BREAKER),
    };
}

import type { Classification, PublicStatus } from './types';

export function publicStatusFor(classification: Classification): PublicStatus {
    switch (classification) {
        case 'SUCCESS':
            return 'OPERATIONAL';
        case 'HIGH_LATENCY':
            return 'DEGRADED';
        case 'TIMEOUT':
        case 'NETWORK_ERROR':
        case 'MODEL_UNREACHABLE':
        case 'OVERLOADED':
        case 'EMPTY_RESPONSE':
            return 'OUTAGE';
        case 'AUTH_ERROR':
            return 'AUTHENTICATION';
        case 'RATE_LIMITED':
            return 'RATE_LIMITED';
        case 'SUBSCRIPTION_REQUIRED':
            return 'PLAN_REQUIRED';
        case 'MODEL_NOT_FOUND':
            return 'MODEL_NOT_FOUND';
        case 'INVALID_REQUEST':
        case 'PROTOCOL_ERROR':
            return 'CONFIGURATION';
        default:
            return 'UNKNOWN';
    }
}

export function classifyHttp(status: number): Classification {
    if (status === 401) return 'AUTH_ERROR';
    if (status === 429) return 'RATE_LIMITED';
    if (status === 404) return 'MODEL_NOT_FOUND';
    if (status === 400) return 'INVALID_REQUEST';
    if (status === 408 || status === 504) return 'TIMEOUT';
    if (status === 503) return 'OVERLOADED';
    if (status >= 500) return 'MODEL_UNREACHABLE';
    return 'PROTOCOL_ERROR';
}

export function trimmedMean(values: number[]): number | undefined {
    if (!values.length) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const trim = sorted.length >= 10 ? Math.floor(sorted.length * 0.1) : 0;
    const usable = sorted.slice(trim, sorted.length - trim);
    return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

export function isLatencyAnomalous(latencyMs: number, baseline?: number): boolean {
    return (
        latencyMs > 10_000 ||
        (baseline !== undefined &&
            Number.isFinite(baseline) &&
            baseline > 0 &&
            latencyMs > baseline * 1.75)
    );
}

export function nominalCheckIntervalMinutes(tier: 'FREE' | 'PAID' | 'UNKNOWN'): number {
    // Cadence aligned to the 15-minute cron tick (wrangler crons */15). Both tiers check every
    // tick; the tier argument is kept for callers and future divergence.
    void tier;
    return 15;
}

export function checkIntervalMinutes(
    status: PublicStatus,
    hadRecentIncident: boolean,
    retryAfterSeconds?: number,
    tier: 'FREE' | 'PAID' | 'UNKNOWN' = 'FREE',
): number {
    return status === 'AUTHENTICATION'
        ? 60
        : status === 'RATE_LIMITED'
          ? // A 429 here is usually self-inflicted burst throttling, not an exhausted quota,
            // so honor any Retry-After but otherwise recover on the next cycle (floored to the
            // 15-minute cron cadence) instead of locking the model out for a full hour.
            Math.max(15, Math.ceil((retryAfterSeconds ?? 300) / 60))
          : status === 'DEGRADED' || (status === 'OUTAGE' && hadRecentIncident)
            ? 15
            : status === 'OUTAGE'
              ? 15
              : nominalCheckIntervalMinutes(tier);
}

export function nextCheckAt(
    status: PublicStatus,
    hadRecentIncident: boolean,
    retryAfterSeconds?: number,
    tier: 'FREE' | 'PAID' | 'UNKNOWN' = 'FREE',
): string {
    const minutes = checkIntervalMinutes(status, hadRecentIncident, retryAfterSeconds, tier);
    return new Date(Date.now() + minutes * 60_000).toISOString();
}

// The monitor only ever runs on a cron tick (every 15 minutes; see wrangler crons).
// A model whose next_check_at lands even a second after a tick would otherwise wait a
// whole extra cycle, drifting the cadence from ~15 toward ~30 minutes. Admitting
// anything that comes due before the next tick pins every tier to its exact nominal
// multiple of the cron period (15m). The margin must stay STRICTLY below one cron
// interval: at or above it, the cadence would be pulled down toward a shorter period.
// The 1s shy of a full interval keeps the widest drift tolerance under that ceiling.
export const CRON_INTERVAL_MS = 15 * 60_000;
export const SCHEDULE_GRACE_MS = CRON_INTERVAL_MS - 1_000;

export function eligibilityCutoff(nowMs: number): string {
    return new Date(nowMs + SCHEDULE_GRACE_MS).toISOString();
}

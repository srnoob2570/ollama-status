export const MONITOR_INTERVAL_MS = 5 * 60_000;

/**
 * Round a timestamp up to the next monitor cron-tick boundary.
 *
 * Returns null when the input is not a valid date string.
 */
export function roundUpToMonitorInterval(timestamp: string): number | null {
    const time = new Date(timestamp).getTime();
    return Number.isNaN(time) ? null : Math.ceil(time / MONITOR_INTERVAL_MS) * MONITOR_INTERVAL_MS;
}

/**
 * Generate a human-readable countdown label for the next scheduled check.
 *
 * When a monitor run is in progress, returns "Updating…".
 * When no check is scheduled, returns "No checks scheduled".
 * Otherwise, a countdown like "in 3m 42s" or "in 15s".
 *
 * The monitor runs on cron ticks (every MONITOR_INTERVAL_MS). A model
 * whose next_check_at falls within the schedule grace is shown relative
 * to the next cron boundary, not the literal next_check_at, to avoid
 * reporting an artificially long wait.
 *
 * @param nextCheckAt - ISO timestamp from the backend
 * @param updating   - whether a monitor run is currently active
 * @param currentTime - epoch ms (defaults to Date.now())
 */
export function nextUpdateLabel(
    nextCheckAt: string | null,
    updating: boolean,
    currentTime = Date.now(),
): string {
    if (updating) return 'Updating…';
    if (!nextCheckAt) return 'No checks scheduled';

    // The monitor runs on cron ticks (every MONITOR_INTERVAL_MS). The backend admits any model
    // whose next_check_at falls within the schedule grace (~ one cron interval), so a model just
    // checked is re-checked at the NEXT cron tick — not at next_check_at rounded up to the
    // following multiple, which used to add up to a whole extra interval to the countdown. Only
    // long backoffs (AUTHENTICATION 60m, a Retry-After) exceed the grace and are honored literally.
    const nextCronBoundary = Math.ceil(currentTime / MONITOR_INTERVAL_MS) * MONITOR_INTERVAL_MS;
    const scheduledAtMs = Date.parse(nextCheckAt);
    const dueWithinGrace =
        Number.isFinite(scheduledAtMs) && scheduledAtMs <= nextCronBoundary + MONITOR_INTERVAL_MS;
    const target = dueWithinGrace ? nextCronBoundary : Math.max(scheduledAtMs, nextCronBoundary);
    const remainingSeconds = Math.max(0, Math.ceil((target - currentTime) / 1_000));
    if (remainingSeconds === 0) return 'Starting now';

    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    return minutes ? `in ${minutes}m ${seconds}s` : `in ${seconds}s`;
}

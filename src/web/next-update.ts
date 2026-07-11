export const MONITOR_INTERVAL_MS = 5 * 60_000;

export function roundUpToMonitorInterval(timestamp: string): number | null {
    const time = new Date(timestamp).getTime();
    return Number.isNaN(time) ? null : Math.ceil(time / MONITOR_INTERVAL_MS) * MONITOR_INTERVAL_MS;
}

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

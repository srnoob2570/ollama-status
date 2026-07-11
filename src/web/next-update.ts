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

    const scheduledAt = roundUpToMonitorInterval(nextCheckAt);
    if (scheduledAt === null) return 'No checks scheduled';
    const nextCronBoundary = Math.ceil(currentTime / MONITOR_INTERVAL_MS) * MONITOR_INTERVAL_MS;
    const remainingSeconds = Math.max(
        0,
        Math.ceil((Math.max(scheduledAt, nextCronBoundary) - currentTime) / 1_000),
    );
    if (remainingSeconds === 0) return 'Starting now';

    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    return minutes ? `in ${minutes}m ${seconds}s` : `in ${seconds}s`;
}

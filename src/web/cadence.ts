/**
 * Format the check-interval legend displayed below the dashboard title.
 *
 * Example output: "Free models are checked every 5 minutes; paid models every 10 minutes.
 * Completion times may vary."
 */
export function cadenceLegend(intervals: { free: number; paid: number }): string {
    return `Free models are checked every ${intervals.free} minutes; paid models every ${intervals.paid} minutes. Completion times may vary.`;
}

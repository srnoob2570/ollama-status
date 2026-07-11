export function cadenceLegend(intervals: { free: number; paid: number }): string {
    return `Free models are checked every ${intervals.free} minutes; paid models every ${intervals.paid} minutes. Completion times may vary.`;
}

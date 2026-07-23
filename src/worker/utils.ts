/**
 * Round a number to four decimal places.
 *
 * Used for coverage and adherence ratios in cadence analysis
 * where floating-point drift beyond four decimals is noise.
 */
export function round4(n: number): number {
    return Math.round(n * 10_000) / 10_000;
}
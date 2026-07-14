/**
 * Low-cardinality operational metrics for the scheduler and probe system.
 *
 * All metrics are in-memory counters and histograms.  No model_id or
 * execution_id labels — only high-level dimensions for trend analysis.
 *
 * Usage:
 *   import { metrics } from './metrics.ts';
 *   metrics.schedulerTicksTotal.inc({ trigger: 'CRON' });
 *   metrics.probeTtftSeconds.observe({ classification: 'SUCCESS' }, 0.42);
 */

export interface CounterLabels {
    [key: string]: string;
}

export interface HistogramLabels {
    [key: string]: string;
}

export interface Counter {
    inc(labels?: CounterLabels, value?: number): void;
    collect(): Record<string, number>;
    reset(): void;
}

export interface Histogram {
    observe(labels: HistogramLabels, value: number): void;
    collect(): Record<string, { count: number; sum: number; min: number; max: number }>;
    reset(): void;
}

function makeCounter(): Counter {
    const buckets = new Map<string, number>();
    return {
        inc(labels?: CounterLabels, value = 1): void {
            const key = labels ? JSON.stringify(labels, Object.keys(labels).sort()) : '__total__';
            buckets.set(key, (buckets.get(key) ?? 0) + value);
        },
        collect(): Record<string, number> {
            const out: Record<string, number> = {};
            for (const [key, val] of buckets) {
                out[key] = val;
            }
            return out;
        },
        reset(): void {
            buckets.clear();
        },
    };
}

function makeHistogram(): Histogram {
    const buckets = new Map<string, number[]>();
    return {
        observe(labels: HistogramLabels, value: number): void {
            const key = JSON.stringify(labels, Object.keys(labels).sort());
            const list = buckets.get(key) ?? [];
            list.push(value);
            buckets.set(key, list);
        },
        collect(): Record<string, { count: number; sum: number; min: number; max: number }> {
            const out: Record<string, { count: number; sum: number; min: number; max: number }> = {};
            for (const [key, values] of buckets) {
                if (values.length === 0) continue;
                let sum = 0;
                let min = Infinity;
                let max = -Infinity;
                for (const v of values) {
                    sum += v;
                    if (v < min) min = v;
                    if (v > max) max = v;
                }
                out[key] = { count: values.length, sum, min, max };
            }
            return out;
        },
        reset(): void {
            buckets.clear();
        },
    };
}

export interface MetricRegistry {
    schedulerTicksTotal: Counter;
    modelExpectationsTotal: Counter;
    probeAttemptsTotal: Counter;
    probeTimeoutsTotal: Counter;
    probeTtftSeconds: Histogram;
    probeQueueWaitSeconds: Histogram;
    schedulerLagSeconds: Histogram;
    cadenceWindowsTotal: Counter;
    mitigationsTotal: Counter;
}

export function createRegistry(): MetricRegistry {
    return {
        schedulerTicksTotal: makeCounter(),
        modelExpectationsTotal: makeCounter(),
        probeAttemptsTotal: makeCounter(),
        probeTimeoutsTotal: makeCounter(),
        probeTtftSeconds: makeHistogram(),
        probeQueueWaitSeconds: makeHistogram(),
        schedulerLagSeconds: makeHistogram(),
        cadenceWindowsTotal: makeCounter(),
        mitigationsTotal: makeCounter(),
    };
}

// ── Default singleton ───────────────────────────────────────────────────────

export const metrics: MetricRegistry = createRegistry();

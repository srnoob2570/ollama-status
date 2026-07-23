import { describe, expect, it, beforeEach } from 'vitest';
import { createRegistry, metrics } from '../src/worker/metrics.ts';
import type { MetricRegistry } from '../src/worker/metrics.ts';

describe('MetricRegistry', () => {
    let reg: MetricRegistry;

    beforeEach(() => {
        reg = createRegistry();
    });

    describe('counters', () => {
        it('starts at zero', () => {
            expect(reg.schedulerTicksTotal.collect()).toEqual({});
            expect(reg.modelExpectationsTotal.collect()).toEqual({});
            expect(reg.probeAttemptsTotal.collect()).toEqual({});
            expect(reg.probeTimeoutsTotal.collect()).toEqual({});
            expect(reg.cadenceWindowsTotal.collect()).toEqual({});
            expect(reg.mitigationsTotal.collect()).toEqual({});
        });

        it('increments without labels', () => {
            reg.schedulerTicksTotal.inc();
            const collected = reg.schedulerTicksTotal.collect();
            expect(collected['__total__']).toBe(1);
        });

        it('increments with labels', () => {
            reg.schedulerTicksTotal.inc({ trigger: 'CRON' });
            reg.schedulerTicksTotal.inc({ trigger: 'CRON' });
            reg.schedulerTicksTotal.inc({ trigger: 'MANUAL' });
            const collected = reg.schedulerTicksTotal.collect();
            expect(collected).toEqual({
                '{"trigger":"CRON"}': 2,
                '{"trigger":"MANUAL"}': 1,
            });
        });

        it('increments with custom value', () => {
            reg.probeAttemptsTotal.inc({ state: 'QUEUED', purpose: 'AVAILABILITY' }, 5);
            const collected = reg.probeAttemptsTotal.collect();
            expect(collected['{"purpose":"AVAILABILITY","state":"QUEUED"}']).toBe(5);
        });

        it('resets all buckets', () => {
            reg.schedulerTicksTotal.inc({ trigger: 'CRON' });
            reg.schedulerTicksTotal.reset();
            expect(reg.schedulerTicksTotal.collect()).toEqual({});
        });
    });

    describe('histograms', () => {
        it('starts empty', () => {
            expect(reg.probeTtftSeconds.collect()).toEqual({});
            expect(reg.probeQueueWaitSeconds.collect()).toEqual({});
            expect(reg.schedulerLagSeconds.collect()).toEqual({});
        });

        it('records observations', () => {
            reg.probeTtftSeconds.observe({ classification: 'SUCCESS' }, 0.42);
            reg.probeTtftSeconds.observe({ classification: 'SUCCESS' }, 0.58);
            reg.probeTtftSeconds.observe({ classification: 'TIMEOUT' }, 30.0);
            const collected = reg.probeTtftSeconds.collect();
            expect(collected['{"classification":"SUCCESS"}']).toEqual({
                count: 2,
                sum: 1.0,
                min: 0.42,
                max: 0.58,
            });
            expect(collected['{"classification":"TIMEOUT"}']).toEqual({
                count: 1,
                sum: 30.0,
                min: 30.0,
                max: 30.0,
            });
        });

        it('resets all buckets', () => {
            reg.probeTtftSeconds.observe({ classification: 'SUCCESS' }, 0.5);
            reg.probeTtftSeconds.reset();
            expect(reg.probeTtftSeconds.collect()).toEqual({});
        });
    });

    describe('default singleton', () => {
        it('exports a pre-created registry', () => {
            expect(metrics).toBeDefined();
            expect(typeof metrics.schedulerTicksTotal.inc).toBe('function');
            expect(typeof metrics.probeTtftSeconds.observe).toBe('function');
        });
    });
});

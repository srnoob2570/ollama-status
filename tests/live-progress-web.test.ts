import { describe, expect, it } from 'vitest';
import { parseMonitorRunEvent } from '../src/web/live-progress.ts';

describe('parseMonitorRunEvent', () => {
    it('parses a well-formed monitor_progress payload', () => {
        const raw = JSON.stringify({
            phase: 'CHECKING',
            outcome: null,
            detail: null,
            started_at: '2026-07-23T12:00:00.000Z',
            finished_at: null,
            scheduled_model_count: 12,
            completed_model_count: 4,
            failed_probe_count: 1,
            current_model: 'llama3.1',
        });

        expect(parseMonitorRunEvent(raw)).toEqual({
            phase: 'CHECKING',
            outcome: null,
            detail: null,
            started_at: '2026-07-23T12:00:00.000Z',
            finished_at: null,
            scheduled_model_count: 12,
            completed_model_count: 4,
            failed_probe_count: 1,
            current_model: 'llama3.1',
        });
    });

    it('falls back to safe defaults for missing or mistyped fields', () => {
        expect(parseMonitorRunEvent('{}')).toEqual({
            phase: 'UNKNOWN',
            outcome: null,
            detail: null,
            started_at: undefined,
            finished_at: null,
            scheduled_model_count: 0,
            completed_model_count: 0,
            failed_probe_count: 0,
            current_model: null,
        });

        expect(parseMonitorRunEvent('{"phase":42,"scheduled_model_count":"12"}')).toEqual({
            phase: 'UNKNOWN',
            outcome: null,
            detail: null,
            started_at: undefined,
            finished_at: null,
            scheduled_model_count: 0,
            completed_model_count: 0,
            failed_probe_count: 0,
            current_model: null,
        });
    });

    it('returns null for invalid JSON', () => {
        expect(parseMonitorRunEvent('not json')).toBeNull();
    });

    it('returns null for a non-object JSON value', () => {
        expect(parseMonitorRunEvent('42')).toBeNull();
        expect(parseMonitorRunEvent('[1,2,3]')).toBeNull();
        expect(parseMonitorRunEvent('null')).toBeNull();
    });
});

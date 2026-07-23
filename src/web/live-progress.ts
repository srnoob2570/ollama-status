export type MonitorRunEvent = {
    phase: string;
    outcome: string | null;
    detail: string | null;
    started_at?: string;
    finished_at: string | null;
    scheduled_model_count: number;
    completed_model_count: number;
    failed_probe_count: number;
    current_model: string | null;
};

/**
 * Parse a `monitor_progress` NOTIFY payload delivered over the
 * /api/v1/monitor/stream SSE endpoint.
 *
 * Defensive about shape since the payload crosses a JSON-over-the-wire
 * boundary: a malformed or truncated event is dropped (returns null)
 * rather than corrupting the dashboard's monitor state.
 */
export function parseMonitorRunEvent(raw: string): MonitorRunEvent | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    return {
        phase: typeof value.phase === 'string' ? value.phase : 'UNKNOWN',
        outcome: typeof value.outcome === 'string' ? value.outcome : null,
        detail: typeof value.detail === 'string' ? value.detail : null,
        started_at: typeof value.started_at === 'string' ? value.started_at : undefined,
        finished_at: typeof value.finished_at === 'string' ? value.finished_at : null,
        scheduled_model_count:
            typeof value.scheduled_model_count === 'number' ? value.scheduled_model_count : 0,
        completed_model_count:
            typeof value.completed_model_count === 'number' ? value.completed_model_count : 0,
        failed_probe_count: typeof value.failed_probe_count === 'number' ? value.failed_probe_count : 0,
        current_model: typeof value.current_model === 'string' ? value.current_model : null,
    };
}

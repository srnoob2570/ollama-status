import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cadenceLegend } from './cadence';
import { nextUpdateLabel } from './next-update';
import { parseMonitorRunEvent } from './live-progress';

type HistoryRange = '1h' | '24h' | '7d' | '30d';
type HistorySegment = {
    status: string;
    classification?: string;
    checks: number;
};
type HistoryBucket = {
    startAt: string;
    status: string;
    checks: number;
    averageLatencyMs: number | null;
    latencySamples: number;
    segments?: HistorySegment[];
    pending?: boolean;
    checkedAt?: string | null;
    completedAt?: string | null;
    executionState?: 'SCHEDULED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'DEFERRED' | 'ABANDONED';
};
type Model = {
    id: string;
    remote_name: string;
    tier: 'FREE' | 'PAID' | 'UNKNOWN';
    intervalMinutes: number;
    effectiveStatus: string;
    effectiveClassification: string;
    history: HistoryBucket[];
};
type MonitorRun = {
    phase: string;
    outcome: string | null;
    detail: string | null;
    started_at?: string;
    scheduled_model_count: number;
    completed_model_count: number;
    failed_probe_count: number;
    current_model: string | null;
};
type Status = {
    lastUpdatedAt: string | null;
    checkIntervals: { free: number; paid: number };
    nextUpdates: { free: string | null; paid: string | null };
    range: HistoryRange;
    stale: boolean;
    infeasible: boolean;
    paidKeyConfigured: boolean;
    monitor: { started_at?: string } | null;
    monitorProgress: MonitorRun | null;
    monitorActive: boolean;
    stuckRun: MonitorRun | null;
    providers: Array<{ id: string; name: string; catalog_status: string }>;
    models: Model[];
};

const ranges: HistoryRange[] = ['1h', '24h', '7d', '30d'];
const labels: Record<string, string> = {
    OPERATIONAL: 'Operational',
    DEGRADED: 'Degraded',
    OUTAGE: 'Unavailable',
    AUTHENTICATION: 'Authentication',
    RATE_LIMITED: 'Rate limited',
    MODEL_NOT_FOUND: 'Model not found',
    CONFIGURATION: 'Configuration',
    PLAN_REQUIRED: 'Subscription required',
    UNKNOWN: 'Unknown',
};
const statusTone: Record<string, string> = {
    OPERATIONAL: 'operational',
    DEGRADED: 'degraded',
    PLAN_REQUIRED: 'attention',
    RATE_LIMITED: 'attention',
    OUTAGE: 'outage',
    AUTHENTICATION: 'outage',
    CONFIGURATION: 'outage',
    MODEL_NOT_FOUND: 'outage',
    UNKNOWN: 'unknown',
};
const statusSeverity: Record<string, number> = {
    OUTAGE: 0,
    AUTHENTICATION: 0,
    CONFIGURATION: 0,
    MODEL_NOT_FOUND: 0,
    PLAN_REQUIRED: 1,
    RATE_LIMITED: 1,
    DEGRADED: 2,
    OPERATIONAL: 3,
    UNKNOWN: 4,
};
const availabilityReasons: Record<string, string> = {
    HIGH_LATENCY: 'The model responded, but more slowly than the monitor threshold.',
    TIMEOUT: 'The monitoring request timed out before the model responded.',
    NETWORK_ERROR: 'The monitor could not reach the provider.',
    AUTH_ERROR: 'The monitoring credentials were rejected by the provider.',
    RATE_LIMITED: 'The provider is temporarily limiting monitoring requests.',
    MODEL_NOT_FOUND: 'The model is no longer available in the provider catalog.',
    MODEL_UNREACHABLE: 'The provider returned a server error while reaching the model.',
    OVERLOADED: 'The provider is currently overloaded.',
    EMPTY_RESPONSE: 'The model did not return a usable response.',
    PROTOCOL_ERROR: 'The provider returned an unexpected response to the monitor.',
    INVALID_REQUEST: 'The provider rejected the monitoring request.',
    SUBSCRIPTION_REQUIRED: 'This model requires a paid subscription.',
    UNKNOWN: 'The monitor has not received a diagnostic result for this model yet.',
};

function availabilityReason(status: string, classification: string): string | null {
    if (status === 'OPERATIONAL') return null;
    return (
        availabilityReasons[classification] ??
        'The monitor recorded this model as unavailable, but no further diagnostic was returned.'
    );
}

export function App() {
    const [range, setRange] = useState<HistoryRange>('1h');
    const [status, setStatus] = useState<Status | null>(null);
    const [error, setError] = useState('');
    const [currentTime, setCurrentTime] = useState(() => Date.now());

    useEffect(() => {
        let dead = false;
        const load = async () => {
            try {
                const response = await fetch(`/api/v1/status?range=${range}`);
                if (!response.ok) throw new Error('Status unavailable');
                const data = (await response.json()) as Status;
                if (!dead) {
                    setStatus(data);
                    setError('');
                }
            } catch {
                if (!dead) setError('We could not load the current monitor data.');
            }
        };
        void load();
        const timer = window.setInterval(() => void load(), 30_000);
        return () => {
            dead = true;
            clearInterval(timer);
        };
    }, [range]);

    useEffect(() => {
        const timer = window.setInterval(() => setCurrentTime(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        const source = new EventSource('/api/v1/monitor/stream');
        source.onmessage = (event) => {
            const run = parseMonitorRunEvent(event.data);
            if (!run) return;
            setStatus((current) =>
                current
                    ? {
                          ...current,
                          monitor: { started_at: run.started_at },
                          monitorProgress: run,
                          monitorActive: run.finished_at === null,
                      }
                    : current,
            );
        };
        return () => source.close();
    }, []);

    const summary = useMemo(
        () =>
            status?.models.reduce<Record<string, number>>((counts, model) => {
                counts[model.tier] = (counts[model.tier] ?? 0) + 1;
                return counts;
            }, {}) ?? {},
        [status],
    );

    if (error)
        return (
            <main className="shell">
                <header>
                    <p className="eyebrow">OLLAMA CLOUD</p>
                    <h1>Service status</h1>
                </header>
                <section className="notice error">{error}</section>
            </main>
        );
    if (!status)
        return (
            <main className="shell">
                <p className="loading">Checking the monitor…</p>
            </main>
        );

    return (
        <main className="shell">
            <header>
                <div>
                    <p className="eyebrow">OLLAMA CLOUD</p>
                    <h1>Service status</h1>
                    <p className="subtle">{cadenceLegend(status.checkIntervals)}</p>
                    <p className="project-disclaimer">
                        This is an independent, community-operated monitor. It is not an official
                        Ollama service and is not affiliated with, endorsed by, or operated by
                        Ollama. Availability is measured by automated checks and may differ from
                        your own account or region.
                    </p>
                </div>
                <div className="monitor-meta">
                    <LastDataUpdate value={status.lastUpdatedAt} />
                    <StatusSignals status={status} />
                </div>
            </header>
            {status.stale && (
                <section className="notice error">
                    MONITOR STALE — no scheduler run has started in the last 20 minutes.
                </section>
            )}
            {status.stuckRun && (
                <section className="notice error">
                    MONITOR STUCK — the last run started over 5 minutes ago and hasn&apos;t
                    finished. It will be abandoned and recovered on the next scheduler cycle.
                </section>
            )}
            {status.infeasible && (
                <section className="notice warning">
                    MONITOR OVERLOADED — recent runs couldn&apos;t check every model within the
                    5-minute cadence. Lower PROBE_DELAY_MAX_MS, raise FREE_PROBE_CONCURRENCY or
                    PAID_PROBE_CONCURRENCY (if the respective API key allows), or reduce the
                    catalog.
                </section>
            )}
            {!status.paidKeyConfigured && (
                <section className="notice info">
                    PAID MODELS DISABLED — no paid Ollama API key is configured. Paid-tier checks
                    are skipped to control cost; only free-tier models are actively monitored.
                </section>
            )}
            <section className="summary" aria-label="Catalog summary">
                {Object.entries(summary)
                    .filter(([, count]) => count > 0)
                    .map(([tier, count]) => (
                        <SummaryMetric
                            key={tier}
                            tier={tier}
                            count={count}
                            status={status}
                            currentTime={currentTime}
                        />
                    ))}
            </section>
            <ModelCategory
                title="Free models"
                models={status.models.filter((model) => model.tier === 'FREE')}
                range={status.range}
            />
            <ModelCategory
                title={status.paidKeyConfigured ? 'Paid models' : 'Paid models (not monitored)'}
                models={status.models.filter((model) => model.tier === 'PAID')}
                range={status.range}
                showHistory={status.paidKeyConfigured}
            />
            <ModelCategory
                title="Unclassified models"
                models={status.models.filter((model) => model.tier === 'UNKNOWN')}
                range={status.range}
            />
            <RangeSelector range={range} onChange={setRange} />
        </main>
    );
}

function LastDataUpdate({ value }: { value: string | null }) {
    if (!value) return <span className="last-update">Last data update: not available</span>;
    return (
        <time className="last-update" dateTime={value}>
            Last data update:{' '}
            {new Date(value).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'medium',
            })}
        </time>
    );
}

function StatusSignals({ status }: { status: Status }) {
    const catalog =
        status.providers.find((provider) => provider.id === 'ollama-free')?.catalog_status ??
        'UNKNOWN';
    const run = status.monitorProgress;
    const running = status.monitorActive;
    // Distinguish a genuinely active run from a stuck one (no finished_at but older than one cron
    // interval), and a failed/abandoned run from a completed one, instead of collapsing every
    // in-flight or errored state into the same "Run X/Y" / "Last run failed" label.
    const progress = status.stuckRun
        ? 'Monitor stuck'
        : running && run
          ? `Run ${run.completed_model_count}/${run.scheduled_model_count}`
          : run?.outcome === 'ERROR'
            ? run.phase === 'ABANDONED'
                ? 'Last run abandoned'
                : 'Last run failed'
            : 'Monitor ready';
    const signalTone = status.stuckRun || running || run?.outcome === 'ERROR' ? 'warn' : 'ok';
    const title = status.stuckRun
        ? `Stuck since ${run?.started_at ?? status.stuckRun.started_at ?? 'unknown'}`
        : run?.detail
          ? run.detail
          : undefined;
    return (
        <div className="signals" aria-label="Monitor status">
            <span className={catalog === 'OK' ? 'ok' : 'warn'}>Catalog {catalog}</span>
            <span className={signalTone} title={title}>
                {progress}
            </span>
            {running && run?.current_model && (
                <span className="checking" title={`Checking ${run.current_model}`}>
                    Checking {run.current_model}
                </span>
            )}
        </div>
    );
}

function SummaryMetric({
    tier,
    count,
    status,
    currentTime,
}: {
    tier: string;
    count: number;
    status: Status;
    currentTime: number;
}) {
    const label =
        tier === 'FREE' ? 'Free models' : tier === 'PAID' ? 'Paid models' : 'Unclassified';
    const nextCheckAt =
        tier === 'FREE'
            ? status.nextUpdates.free
            : tier === 'PAID'
              ? status.nextUpdates.paid
              : null;
    return (
        <div className={`metric ${tier.toLowerCase()} `}>
            <strong>{count}</strong>
            <span>{label}</span>
            {nextCheckAt !== null || tier !== 'UNKNOWN' ? (
                <span className="next-check">
                    Next check: {nextUpdateLabel(nextCheckAt, status.monitorActive, currentTime)}
                </span>
            ) : null}
        </div>
    );
}

function RangeSelector({
    range,
    onChange,
}: {
    range: HistoryRange;
    onChange: (range: HistoryRange) => void;
}) {
    return (
        <div className="range-control" role="group" aria-label="History range">
            {ranges.map((value) => (
                <button
                    key={value}
                    className={range === value ? 'selected' : ''}
                    aria-pressed={range === value}
                    onClick={() => onChange(value)}
                >
                    {value}
                </button>
            ))}
        </div>
    );
}

function ModelCategory({
    title,
    models,
    range,
    showHistory = true,
}: {
    title: string;
    models: Model[];
    range: HistoryRange;
    showHistory?: boolean;
}) {
    if (!models.length) return null;
    return (
        <section className="panel">
            <div className="panel-heading">
                <h2>{title}</h2>
                <span>{models.length} monitored</span>
            </div>
            <div className="model-list">
                {models.map((model) => (
                    <ModelRow key={model.id} model={model} range={range} showHistory={showHistory} />
                ))}
            </div>
        </section>
    );
}

function ModelRow({
    model,
    range,
    showHistory = true,
}: {
    model: Model;
    range: HistoryRange;
    showHistory?: boolean;
}) {
    const label = labels[model.effectiveStatus] ?? 'Unknown';
    const reason = availabilityReason(model.effectiveStatus, model.effectiveClassification);
    return (
        <article className="model">
            <span
                aria-hidden="true"
                className={`dot ${statusTone[model.effectiveStatus] ?? 'unknown'}`}
            />
            <div className="model-copy">
                <strong className="model-name">{model.remote_name}</strong>
                <div className="model-tags">
                    <span className="access" title={reason ?? undefined}>
                        {label}
                    </span>
                </div>
            </div>
            {showHistory && <History model={model} range={range} />}
        </article>
    );
}

type BucketSegmentView = {
    status: string;
    label: string;
    tone: string;
    classification?: string;
    checks: number;
    proportion: number;
};
type BucketDescription = {
    time: string;
    hasData: boolean;
    headlineLabel: string;
    headlineTone: string;
    headlinePrefix: string | null;
    reason: string | null;
    checks: number;
    averageLatencyMs: number | null;
    segments: BucketSegmentView[];
    ariaLabel: string;
    isExecution: boolean;
    checkedTime: string | null;
    completedTime: string | null;
    executionState: HistoryBucket['executionState'];
};

function describeBucket(bucket: HistoryBucket, range: HistoryRange): BucketDescription {
    const time = bucketLabel(bucket.startAt, range);
    const isExecution = range === '1h' && bucket.executionState !== undefined;
    const checkedTime = bucket.checkedAt ? bucketLabel(bucket.checkedAt, '1h') : null;
    const completedTime = bucket.completedAt ? bucketLabel(bucket.completedAt, '1h') : null;
    const hasData = bucket.checks > 0;
    const ranked = (bucket.segments ?? [])
        .filter((segment) => segment.checks > 0)
        .sort(
            (left, right) =>
                (statusSeverity[left.status] ?? statusSeverity.UNKNOWN) -
                    (statusSeverity[right.status] ?? statusSeverity.UNKNOWN) ||
                left.status.localeCompare(right.status),
        );
    const segmentTotal = ranked.reduce((total, segment) => total + segment.checks, 0);
    const segments = ranked.map((segment) => ({
        status: segment.status,
        label: labels[segment.status] ?? 'Unknown',
        tone: statusTone[segment.status] ?? 'unknown',
        classification: segment.classification,
        checks: segment.checks,
        proportion: segmentTotal ? Math.round((segment.checks / segmentTotal) * 100) : 0,
    }));
    // "worst" only makes sense when the segment mixes several statuses; a single
    // status reads plainly (e.g. "Operational") instead of "worst status Operational".
    const headlinePrefix = segments.length > 1 ? 'Worst' : null;
    const headlineLabel = hasData
        ? (labels[bucket.status] ?? 'Unknown')
        : bucket.pending
          ? 'Pending'
          : isExecution && bucket.executionState === 'DEFERRED'
            ? 'Deferred'
            : isExecution && bucket.executionState === 'ABANDONED'
              ? 'Abandoned'
              : isExecution
                ? 'No observation'
                : 'No data';
    const headlineTone = hasData
        ? (statusTone[bucket.status] ?? 'unknown')
        : bucket.pending
          ? 'pending'
          : 'unknown';
    const reason = hasData
        ? availabilityReason(
              bucket.status,
              ranked.find((segment) => segment.status === bucket.status)?.classification ??
                  'UNKNOWN',
          )
        : null;
    const checksText = bucket.checks === 1 ? '1 check' : `${bucket.checks} checks`;
    const averageText =
        bucket.averageLatencyMs === null
            ? 'no latency samples'
            : `average ${Math.round(bucket.averageLatencyMs)} ms`;
    const headline = headlinePrefix ? `worst status ${headlineLabel}` : headlineLabel;
    const ariaLabel = hasData
        ? isExecution
            ? `${time} scheduled · ${checkedTime ?? 'unknown result time'} · ${headline}${reason ? ` · ${reason}` : ''} · ${averageText}`
            : `${time} · ${headline}${reason ? ` · ${reason}` : ''} · ${checksText} · ${averageText}`
        : bucket.pending
          ? `${time} · pending next check`
          : isExecution
            ? `${time} · ${headlineLabel.toLowerCase()}`
            : `${time} · no data`;
    return {
        time,
        hasData,
        headlineLabel,
        headlineTone,
        headlinePrefix,
        reason,
        checks: bucket.checks,
        averageLatencyMs: bucket.averageLatencyMs,
        segments,
        ariaLabel,
        isExecution,
        checkedTime,
        completedTime,
        executionState: bucket.executionState,
    };
}

function History({ model, range }: { model: Model; range: HistoryRange }) {
    const [active, setActive] = useState<{
        key: string;
        rect: DOMRect;
        data: BucketDescription;
    } | null>(null);
    return (
        <div
            className={`history history-${range}`}
            aria-label={`${model.remote_name} ${range} status history; nominal interval ${model.intervalMinutes} minutes`}
        >
            {model.history.map((bucket, index) => {
                const key = `${bucket.startAt}-${bucket.checkedAt ?? bucket.executionState ?? index}`;
                const data = describeBucket(bucket, range);
                const show = (event: { currentTarget: HTMLElement }) =>
                    setActive({ key, rect: event.currentTarget.getBoundingClientRect(), data });
                const hide = () => setActive((current) => (current?.key === key ? null : current));
                return (
                    <span
                        className={`history-bar ${data.segments.length ? '' : data.headlineTone}`}
                        key={key}
                        role="img"
                        tabIndex={0}
                        aria-label={data.ariaLabel}
                        onMouseEnter={show}
                        onMouseLeave={hide}
                        onFocus={show}
                        onBlur={hide}
                    >
                        {data.segments.map((segment) => (
                            <span
                                aria-hidden="true"
                                className={`history-segment ${segment.tone}`}
                                key={segment.status}
                                style={{ flexGrow: segment.checks }}
                            />
                        ))}
                    </span>
                );
            })}
            {active && <HistoryTooltip rect={active.rect} data={active.data} />}
        </div>
    );
}

function HistoryTooltip({ rect, data }: { rect: DOMRect; data: BucketDescription }) {
    const ref = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) return;
        const box = element.getBoundingClientRect();
        const margin = 8;
        const gap = 10;
        const left = Math.max(
            margin,
            Math.min(
                rect.left + rect.width / 2 - box.width / 2,
                window.innerWidth - box.width - margin,
            ),
        );
        const above = rect.top - box.height - gap;
        const top = above >= margin ? above : rect.bottom + gap;
        setPosition({ left, top });
    }, [rect, data]);
    return createPortal(
        <div
            ref={ref}
            className="history-tooltip"
            role="tooltip"
            aria-hidden="true"
            style={{
                left: `${position ? position.left : rect.left}px`,
                top: `${position ? position.top : rect.top}px`,
                visibility: position ? 'visible' : 'hidden',
            }}
        >
            <div className="tt-header">{data.isExecution ? 'Execution details' : data.time}</div>
            <div className="tt-status">
                <span aria-hidden="true" className={`dot ${data.headlineTone}`} />
                <span>
                    {data.headlinePrefix
                        ? `${data.headlinePrefix}: ${data.headlineLabel}`
                        : data.headlineLabel}
                </span>
            </div>
            {data.reason && (
                <div className="tt-reason">
                    <span className="tt-reason-label">Why</span>
                    <span>{data.reason}</span>
                </div>
            )}
            {data.isExecution && (
                <div className="tt-metrics">
                    <span className="tt-metric-label">Scheduled</span>
                    <span className="tt-metric-value">{data.time}</span>
                    <span className="tt-metric-label">Execution</span>
                    <span className="tt-metric-value">
                        {data.executionState?.toLowerCase() ?? '—'}
                    </span>
                    <span className="tt-metric-label">Completed</span>
                    <span className="tt-metric-value">{data.completedTime ?? '—'}</span>
                </div>
            )}
            {data.hasData && (
                <>
                    <div className="tt-metrics">
                        {!data.isExecution && (
                            <>
                                <span className="tt-metric-label">Checks</span>
                                <span className="tt-metric-value">{data.checks}</span>
                            </>
                        )}
                        <span className="tt-metric-label">
                            {data.isExecution ? 'Latency' : 'Avg latency'}
                        </span>
                        <span className="tt-metric-value">
                            {data.averageLatencyMs === null
                                ? '—'
                                : `${Math.round(data.averageLatencyMs)} ms`}
                        </span>
                    </div>
                    {!data.isExecution && data.segments.length > 0 && (
                        <div className="tt-breakdown">
                            <div className="tt-bar">
                                {data.segments.map((segment) => (
                                    <span
                                        aria-hidden="true"
                                        className={`history-segment ${segment.tone}`}
                                        key={segment.status}
                                        style={{ flexGrow: segment.checks }}
                                    />
                                ))}
                            </div>
                            <ul className="tt-legend">
                                {data.segments.map((segment) => (
                                    <li key={segment.status}>
                                        <span
                                            aria-hidden="true"
                                            className={`dot ${segment.tone}`}
                                        />
                                        <span className="tt-legend-label">{segment.label}</span>
                                        <span className="tt-legend-count">{segment.checks}</span>
                                        <span className="tt-legend-pct">{segment.proportion}%</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </>
            )}
        </div>,
        document.body,
    );
}

function bucketLabel(value: string, range: HistoryRange): string {
    const date = new Date(value);
    if (range === '1h')
        return date.toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        });
    return range === '24h'
        ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric' })
        : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

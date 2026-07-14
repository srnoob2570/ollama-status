import { CRON_INTERVAL_MS, nominalCheckIntervalMinutes } from './status.ts';
import { enqueueManualMonitorJob } from './monitor-jobs.ts';
import { analyzeCadence } from './cadence.ts';
import type { ApiEnv } from './types.ts';
import { now } from './types.ts';

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
const invalid = (message: string) => json({ error: message }, 400);

// `caches.default` is the Workers implicit cache, but the lib's CacheStorage type omits the
// `default` property, so cast it lazily. Used to serve public read endpoints from cache (60s
// TTL) and keep the dashboard's 30s polling off D1 ~98% of the time. Evaluated at call time so
// the module loads in test environments where `caches` is not a global.
function defaultCache(): Cache {
    return (caches as unknown as { default: Cache }).default;
}

const HISTORY_1H_WINDOW_MS = 60 * 60_000;
const CONFIRMATION_MAX_BYTES = 8 * 1024;
const MONITOR_RUN_TIMESTAMP_MAX_AGE_MS = 5 * 60_000;

export type HistoryRange = '1h' | '24h' | '7d' | '30d';
export type StatusRow = {
    provider_id: string;
    model_id: string;
    public_status: string;
    classification: string;
    last_check_at: string | null;
    last_latency_ms: number | null;
};
export type HistoryCheck = {
    provider_id: string;
    model_id: string;
    checked_at: string;
    public_status: string;
    classification: string;
    total_duration_ms: number | null;
    rtt_ms: number | null;
    ttft_ms: number | null;
    execution_id?: string | null;
};
export type HistoryExecutionState =
    'SCHEDULED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'DEFERRED' | 'ABANDONED';
export type HistoryExecution = {
    id: string;
    model_id: string;
    tier: string;
    interval_minutes: number;
    scheduled_at: string;
    started_at: string | null;
    completed_at: string | null;
    state: HistoryExecutionState;
};
export type HistorySegment = { status: string; classification?: string; checks: number };
export type HistoryBucket = {
    startAt: string;
    status: string;
    checks: number;
    segments: HistorySegment[];
    averageLatencyMs: number | null;
    latencySamples: number;
    checkedAt?: string | null;
    completedAt?: string | null;
    executionState?: HistoryExecutionState;
    // True when a real scheduled execution exists but its availability result has not landed.
    // Only meaningful when checks === 0.
    pending?: boolean;
};
type ScheduledModel = { tier: string; next_check_at: string | null };

function groupBy<T, K>(items: T[], keyForItem: (item: T) => K): Map<K, T[]> {
    const grouped = new Map<K, T[]>();
    for (const item of items) {
        const key = keyForItem(item);
        const existing = grouped.get(key);
        if (existing) existing.push(item);
        else grouped.set(key, [item]);
    }
    return grouped;
}

const rangeConfiguration = (
    requestedRange: string | null,
    timestamp = new Date(),
): { range: HistoryRange; bucketCount: number; bucketDurationMs: number; start: Date } => {
    const range: HistoryRange =
        requestedRange === '24h' || requestedRange === '7d' || requestedRange === '30d'
            ? requestedRange
            : '1h';
    const bucketDurationMs = range === '1h' ? 0 : range === '24h' ? 3_600_000 : 86_400_000;
    const bucketCount = range === '1h' ? 0 : range === '24h' ? 24 : range === '7d' ? 7 : 30;
    const start = new Date(timestamp);
    if (range === '1h') {
        start.setTime(timestamp.getTime() - HISTORY_1H_WINDOW_MS);
    } else {
        if (range === '24h') start.setUTCMinutes(0, 0, 0);
        else start.setUTCHours(0, 0, 0, 0);
        start.setTime(start.getTime() - (bucketCount - 1) * bucketDurationMs);
    }
    return { range, bucketCount, bucketDurationMs, start };
};

const statusWeight: Record<string, number> = {
    UNKNOWN: 0,
    OPERATIONAL: 1,
    DEGRADED: 2,
    PLAN_REQUIRED: 3,
    RATE_LIMITED: 3,
    OUTAGE: 4,
    AUTHENTICATION: 4,
    CONFIGURATION: 4,
    MODEL_NOT_FOUND: 4,
};

export function worstStatus(statuses: string[]): string {
    return statuses.reduce(
        (worst, status) =>
            (statusWeight[status] ?? statusWeight.UNKNOWN) >
            (statusWeight[worst] ?? statusWeight.UNKNOWN)
                ? status
                : worst,
        'UNKNOWN',
    );
}

export function historyBuckets(
    checks: HistoryCheck[],
    range: string | null,
    timestamp = new Date(),
): HistoryBucket[] {
    const config = rangeConfiguration(range, timestamp);
    if (config.range === '1h') return executionHistoryBuckets([], checks, timestamp);
    const buckets = Array.from({ length: config.bucketCount }, (_, index) => ({
        startAt: new Date(config.start.getTime() + index * config.bucketDurationMs).toISOString(),
        status: 'UNKNOWN',
        checks: 0,
        segmentCounts: new Map<string, { status: string; classification: string; checks: number }>(),
        totalDurations: [] as number[],
        rtts: [] as number[],
        ttfts: [] as number[],
        pending: false,
    }));
    for (const check of checks) {
        const index = Math.floor(
            (new Date(check.checked_at).getTime() - config.start.getTime()) /
                config.bucketDurationMs,
        );
        if (index < 0 || index >= buckets.length) continue;
        const bucket = buckets[index];
        bucket.status = bucket.checks
            ? worstStatus([bucket.status, check.public_status])
            : check.public_status;
        bucket.checks += 1;
        bucket.pending = false;
        const segmentKey = `${check.public_status}:${check.classification}`;
        const segment = bucket.segmentCounts.get(segmentKey);
        if (segment) segment.checks += 1;
        else
            bucket.segmentCounts.set(segmentKey, {
                status: check.public_status,
                classification: check.classification,
                checks: 1,
            });
        if (typeof check.ttft_ms === 'number')
            bucket.ttfts.push(check.ttft_ms);
        if (typeof check.total_duration_ms === 'number')
            bucket.totalDurations.push(check.total_duration_ms);
        if (typeof check.rtt_ms === 'number') bucket.rtts.push(check.rtt_ms);
    }
    return buckets.map(({ totalDurations, rtts, ttfts, segmentCounts, ...bucket }) => {
        const timings = ttfts.length ? ttfts : totalDurations.length ? totalDurations : rtts;
        const averageLatencyMs = timings.length
            ? timings.reduce((sum, value) => sum + value, 0) / timings.length
            : null;
        const segments = [...segmentCounts.values()]
            .sort(
                (left, right) =>
                    (statusWeight[right.status] ?? statusWeight.UNKNOWN) -
                        (statusWeight[left.status] ?? statusWeight.UNKNOWN) ||
                    left.status.localeCompare(right.status),
            );
        return { ...bucket, segments, averageLatencyMs, latencySamples: timings.length };
    });
}

export function checkLatency(check: HistoryCheck): number | null {
    return typeof check.ttft_ms === 'number'
        ? check.ttft_ms
        : typeof check.total_duration_ms === 'number'
          ? check.total_duration_ms
          : typeof check.rtt_ms === 'number'
            ? check.rtt_ms
            : null;
}

function completedExecutionBucket(
    startAt: string,
    check: HistoryCheck,
    completedAt: string,
    executionState: HistoryExecutionState = 'COMPLETED',
): HistoryBucket {
    const latency = checkLatency(check);
    return {
        startAt,
        checkedAt: check.checked_at,
        completedAt,
        executionState,
        status: check.public_status,
        checks: 1,
        segments: [
            { status: check.public_status, classification: check.classification, checks: 1 },
        ],
        averageLatencyMs: latency,
        latencySamples: latency === null ? 0 : 1,
        pending: false,
    };
}

function effectiveExecutionCheck(
    execution: HistoryExecution,
    checks: HistoryCheck[],
): HistoryCheck | undefined {
    const executionChecks = checks.filter((check) => check.execution_id === execution.id);
    // Prefer a Paid check whenever one exists for this execution: it only exists once the Free
    // probe reported SUBSCRIPTION_REQUIRED and the Paid probe subsequently completed, so it is
    // always the more current classification. Branching on `execution.tier` instead is wrong: that
    // value is frozen at scheduling time and is still 'UNKNOWN' during a model's very first
    // classification cycle, even though a Paid check already exists for that same execution.
    return (
        executionChecks.find((check) => check.provider_id === 'ollama-paid') ??
        executionChecks.find((check) => check.provider_id === 'ollama-free') ??
        executionChecks[0]
    );
}

export function executionHistoryBuckets(
    executions: HistoryExecution[],
    checks: HistoryCheck[],
    timestamp = new Date(),
): HistoryBucket[] {
    const endMs = timestamp.getTime();
    const startMs = endMs - HISTORY_1H_WINDOW_MS;
    const executionBuckets = executions
        .filter((execution) => {
            const scheduledMs = Date.parse(execution.scheduled_at);
            return scheduledMs >= startMs && scheduledMs <= endMs;
        })
        .map((execution): HistoryBucket => {
            const check = effectiveExecutionCheck(execution, checks);
            if (check && execution.state === 'COMPLETED')
                return completedExecutionBucket(
                    execution.scheduled_at,
                    check,
                    execution.completed_at ?? check.checked_at,
                    execution.state,
                );
            return {
                startAt: execution.scheduled_at,
                checkedAt: null,
                completedAt: execution.completed_at,
                executionState: execution.state,
                status: 'UNKNOWN',
                checks: 0,
                segments: [],
                averageLatencyMs: null,
                latencySamples: 0,
                pending: execution.state === 'SCHEDULED' || execution.state === 'RUNNING',
            };
        });
    const legacyBuckets = checks
        .filter((check) => {
            const checkedMs = Date.parse(check.checked_at);
            return !check.execution_id && checkedMs >= startMs && checkedMs <= endMs;
        })
        .map((check) => completedExecutionBucket(check.checked_at, check, check.checked_at));
    return [...executionBuckets, ...legacyBuckets].sort(
        (left, right) => Date.parse(left.startAt) - Date.parse(right.startAt),
    );
}

export function effectiveProvider(
    tier: string,
    modelId: string,
    statuses: StatusRow[],
): 'ollama-free' | 'ollama-paid' {
    return tier === 'PAID' &&
        statuses.some(
            (status) => status.model_id === modelId && status.provider_id === 'ollama-paid',
        )
        ? 'ollama-paid'
        : 'ollama-free';
}

export function nextUpdatesForModels(models: ScheduledModel[]): {
    free: string | null;
    paid: string | null;
} {
    const nextUpdates = { free: null as string | null, paid: null as string | null };
    for (const model of models) {
        const category = model.tier === 'FREE' ? 'free' : model.tier === 'PAID' ? 'paid' : null;
        if (
            !category ||
            !model.next_check_at ||
            (nextUpdates[category] && nextUpdates[category] <= model.next_check_at)
        )
            continue;
        nextUpdates[category] = model.next_check_at;
    }
    return nextUpdates;
}

export function publicApiCacheKey(request: Request, path: string): Request {
    const url = new URL(request.url);
    const cacheUrl = new URL(url.origin);
    cacheUrl.pathname = path;
    if (path === '/api/v1/status') {
        const requestedRange = url.searchParams.get('range');
        const range =
            requestedRange === '24h' || requestedRange === '7d' || requestedRange === '30d'
                ? requestedRange
                : '1h';
        cacheUrl.searchParams.set('range', range);
    } else if (/^\/api\/v1\/models\/[^/]+\/history$/.test(path)) {
        const requestedRange = url.searchParams.get('range');
        const range =
            requestedRange === '24h' || requestedRange === '7d' || requestedRange === '30d'
                ? requestedRange
                : '1h';
        cacheUrl.searchParams.set('range', range);
    }
    return new Request(cacheUrl.toString(), { method: 'GET' });
}

// Run outcomes that count as a successful (alive) monitor run for "last updated" purposes.
// `OK` = fully probed every due model; `PARTIAL` = completed without error but the per-tick budget
// ran out before probing every due model (monitor is alive, just couldn't keep up). The SQL
// query in monitorRuns mirrors this exact set — keep them in sync when adding outcomes.
const SUCCESSFUL_OUTCOMES = ['OK', 'PARTIAL'] as const;

export function lastSuccessfulFinishedAt(
    runs: Pick<MonitorRun, 'outcome' | 'finished_at'>[],
): string | null {
    return runs.reduce<string | null>(
        (latest, run) =>
            (SUCCESSFUL_OUTCOMES as readonly string[]).includes(run.outcome ?? '') &&
            run.finished_at &&
            (!latest || run.finished_at > latest)
                ? run.finished_at
                : latest,
        null,
    );
}

// A configuration is infeasible when the monitor keeps completing without error but can't probe
// every due model within the per-tick budget — i.e. the most recent completed runs are ALL
// PARTIAL. A single transient PARTIAL (one slow probe) must NOT trip it; only sustained budget
// exhaustion signals an incompatible cadence/concurrency/delay combination. `runs` must be
// ordered most-recent first (as monitorRuns returns them).
const INFEASIBLE_STREAK = 3;
export function isInfeasible(runs: Pick<MonitorRun, 'outcome' | 'finished_at'>[]): boolean {
    const completed = runs.filter((run) => run.finished_at && run.outcome);
    if (completed.length < INFEASIBLE_STREAK) return false;
    return completed.slice(0, INFEASIBLE_STREAK).every((run) => run.outcome === 'PARTIAL');
}

// A run is "stuck" when it has no finished_at yet is older than one cron interval: its Worker
// isolate is either still hung on a stalled fetch or was evicted mid-run. Read-side only (no
// writes): the next cron tick reclaims the lock and closes the orphaned run for real (see
// runMonitor's ABANDONED sweep). Kept as an exported pure helper so the reconciliation is
// unit-testable without a live D1.
export const RUN_STALE_AGE_MS = CRON_INTERVAL_MS;
export function isStuckRun(
    run: { finished_at: string | null; started_at?: string | null },
    nowMs: number,
    maxAgeMs: number = RUN_STALE_AGE_MS,
): boolean {
    return (
        !run.finished_at &&
        !!run.started_at &&
        nowMs - new Date(run.started_at).getTime() > maxAgeMs
    );
}
// Splits the most recent runs into a genuinely-active run (no finished_at, younger than the
// staleness threshold) and a stuck one (no finished_at, older than the threshold). Returns nulls
// when none match, so the dashboard can distinguish "active", "stuck/recovering", and "no recent
// run" instead of freezing on a stale `Run X/Y`.
export function findActiveRun<T extends { finished_at: string | null; started_at?: string | null }>(
    runs: T[],
    nowMs: number,
): { current: T | null; stuck: T | null } {
    const current = runs.find((run) => !run.finished_at && !isStuckRun(run, nowMs)) ?? null;
    const stuck = runs.find((run) => isStuckRun(run, nowMs)) ?? null;
    return { current, stuck };
}

export function latencyMetrics(checks: HistoryCheck[]) {
    const ttfts = checks
        .map((check) => check.ttft_ms)
        .filter((value): value is number => typeof value === 'number');
    const totalDurations = checks
        .map((check) => check.total_duration_ms)
        .filter((value): value is number => typeof value === 'number');
    const rtts = checks
        .map((check) => check.rtt_ms)
        .filter((value): value is number => typeof value === 'number');
    const latencySource = ttfts.length ? 'TTFT' : totalDurations.length ? 'TOTAL_DURATION' : rtts.length ? 'RTT' : null;
    const timings = (ttfts.length ? ttfts : totalDurations.length ? totalDurations : rtts).sort((a, b) => a - b);
    const percentile = (p: number) =>
        timings.length
            ? timings[Math.min(timings.length - 1, Math.ceil(timings.length * p) - 1)]
            : null;
    return {
        p50LatencyMs: percentile(0.5),
        p95LatencyMs: percentile(0.95),
        samples: timings.length,
        latencySource,
    };
}

export async function api(
    request: Request,
    env: ApiEnv,
    ctx: ExecutionContext,
    path: string,
): Promise<Response> {
    if (path === '/api/internal/confirmation' && request.method === 'POST')
        return confirmation(request, env);
    if (path === '/api/internal/monitor-run' && request.method === 'POST')
        return monitorRun(request, env);
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    // Public GET endpoints change only when the monitor writes (every ~5 min), so a 60s Cache API
    // TTL serves the dashboard's 30s polling from cache ~98% of the time. Data is at most ~1 min
    // stale while the next check is up to 5 min away, so this never hides a state change that the
    // dashboard would otherwise already see as fresh.
    const cacheKey = publicApiCacheKey(request, path);
    const cacheStore = defaultCache();
    const cached = await cacheStore.match(cacheKey);
    if (cached) return cached;
    const response = await publicGetResponse(request, env, path);
    if (response.status === 200) {
        response.headers.set('cache-control', 'public, max-age=60');
        ctx.waitUntil(cacheStore.put(cacheKey, response.clone()));
    }
    return response;
}

async function publicGetResponse(request: Request, env: ApiEnv, path: string): Promise<Response> {
    if (path === '/api/health') {
        try {
            await env.DB.prepare('SELECT 1').first();
            return json({ ok: true, time: now() });
        } catch {
            return json({ ok: false }, 503);
        }
    }
    if (path === '/api/v1/status')
        return publicStatus(env, new URL(request.url).searchParams.get('range'));
    if (path === '/api/v1/incidents') return incidents(env);
    if (path === '/api/v1/monitor') return monitor(env);
    if (path === '/api/v1/monitor/cadence')
        return cadenceHandler(env, new URL(request.url).searchParams.get('window'));
    const modelMatch = path.match(/^\/api\/v1\/models\/([^/]+)(\/history)?$/);
    if (modelMatch)
        return modelDetail(
            env,
            decodeURIComponent(modelMatch[1]),
            Boolean(modelMatch[2]),
            new URL(request.url).searchParams.get('range'),
        );
    return json({ error: 'Not found' }, 404);
}

async function confirmation(request: Request, env: ApiEnv): Promise<Response> {
    if (!env.CONFIRMATION_HMAC_SECRET) return new Response('Not configured', { status: 503 });
    const contentLength = request.headers.get('content-length');
    if (contentLength && Number.parseInt(contentLength, 10) > CONFIRMATION_MAX_BYTES)
        return new Response('Payload too large', { status: 413 });
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > CONFIRMATION_MAX_BYTES)
        return new Response('Payload too large', { status: 413 });
    const signature = request.headers.get('x-confirmation-signature') ?? '';
    const expected = await hmac(raw, env.CONFIRMATION_HMAC_SECRET);
    if (!constantTimeEqual(signature, expected))
        return new Response('Unauthorized', { status: 401 });
    let body: {
        incidentId?: string;
        nonce?: string;
        classification?: string;
    };
    try {
        body = JSON.parse(raw) as typeof body;
    } catch {
        return invalid('Invalid JSON');
    }
    if (
        !body.incidentId ||
        !body.nonce ||
        !body.classification ||
        !['SUCCESS', 'TIMEOUT', 'NETWORK_ERROR', 'AUTH_ERROR'].includes(body.classification)
    )
        return invalid('Invalid confirmation');
    const changes = await env.DB.prepare(
        "UPDATE region_confirmations SET status='RECEIVED',result_classification=?,received_at=? WHERE incident_id=? AND nonce=? AND status='PENDING' AND expires_at>? ",
    )
        .bind(body.classification, now(), body.incidentId, body.nonce, now())
        .run();
    if (!changes.meta.changes) return json({ error: 'Unknown or expired nonce' }, 404);
    await env.DB.prepare('UPDATE incidents SET external_confirmed_at=? WHERE id=?')
        .bind(now(), body.incidentId)
        .run();
    return json({ accepted: true });
}

async function monitorRun(request: Request, env: ApiEnv): Promise<Response> {
    if (!env.CONFIRMATION_HMAC_SECRET) return new Response('Not configured', { status: 503 });
    const contentLength = request.headers.get('content-length');
    if (contentLength && Number.parseInt(contentLength, 10) > CONFIRMATION_MAX_BYTES)
        return new Response('Payload too large', { status: 413 });
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > CONFIRMATION_MAX_BYTES)
        return new Response('Payload too large', { status: 413 });
    const signature = request.headers.get('x-monitor-signature') ?? '';
    const expected = await hmac(raw, env.CONFIRMATION_HMAC_SECRET);
    if (!constantTimeEqual(signature, expected))
        return new Response('Unauthorized', { status: 401 });

    let body: { timestamp?: unknown };
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid('Invalid JSON');
        body = parsed as typeof body;
    } catch {
        return invalid('Invalid JSON');
    }
    if (
        typeof body.timestamp !== 'number' ||
        !Number.isSafeInteger(body.timestamp) ||
        Math.abs(Date.now() - body.timestamp * 1_000) > MONITOR_RUN_TIMESTAMP_MAX_AGE_MS
    )
        return invalid('Invalid or expired timestamp');

    const job = await enqueueManualMonitorJob(env);
    return json({ jobId: job.jobId, state: 'QUEUED' }, 202);
}

async function hmac(value: string, secret: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const bytes = new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)),
    );
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

async function publicStatus(env: ApiEnv, requestedRange: string | null): Promise<Response> {
    const timestamp = new Date();
    const configuration = rangeConfiguration(requestedRange, timestamp);
    const [providers, modelResult, statuses, checks, executions, monitor] = await Promise.all([
        env.DB.prepare(
            'SELECT id,name,catalog_status,catalog_checked_at FROM providers WHERE active=1 ORDER BY name',
        ).all(),
        env.DB.prepare(
            "SELECT id,remote_name,tier,next_check_at FROM models WHERE provider_id='ollama-free' AND active=1 AND excluded=0 ORDER BY tier,remote_name",
        ).all<{ id: string; remote_name: string; tier: string; next_check_at: string | null }>(),
        env.DB.prepare(
            'SELECT provider_id,model_id,public_status,classification,last_check_at,last_latency_ms FROM provider_model_status',
        ).all<StatusRow>(),
        env.DB.prepare(
            "SELECT c.provider_id,c.model_id,c.checked_at,c.public_status,c.classification,c.total_duration_ms,c.rtt_ms,c.ttft_ms,c.execution_id FROM checks c JOIN models m ON m.id=c.model_id WHERE m.provider_id='ollama-free' AND c.checked_at>=? AND c.checked_at<=? ORDER BY c.checked_at",
        )
            .bind(configuration.start.toISOString(), timestamp.toISOString())
            .all<HistoryCheck>(),
        env.DB.prepare(
            `SELECT id,model_id,tier,interval_minutes,scheduled_at,started_at,completed_at,state
             FROM model_check_executions
             WHERE ?='1h' AND scheduled_at>=? AND scheduled_at<=?
             ORDER BY scheduled_at`,
        )
            .bind(configuration.range, configuration.start.toISOString(), timestamp.toISOString())
            .all<HistoryExecution>(),
        monitorRuns(env),
    ]);
    const statusesByModelProvider = new Map(
        statuses.results.map((status) => [`${status.provider_id}:${status.model_id}`, status]),
    );
    const statusesByModel = groupBy(statuses.results, (status) => status.model_id);
    const checksByModel = groupBy(checks.results, (check) => check.model_id);
    const executionsByModel = groupBy(executions.results, (execution) => execution.model_id);
    const models = await Promise.all(
        modelResult.results.map(async (model) => {
            const modelStatuses = statusesByModel.get(model.id) ?? [];
            const providerId = effectiveProvider(model.tier, model.id, modelStatuses);
            const modelChecks = checksByModel.get(model.id) ?? [];
            const providerChecks = modelChecks.filter((check) => check.provider_id === providerId);
            const intervalMinutes = nominalCheckIntervalMinutes(
                model.tier === 'PAID' ? 'PAID' : model.tier === 'FREE' ? 'FREE' : 'UNKNOWN',
                env,
            );
            const effectiveStatus = statusesByModelProvider.get(`${providerId}:${model.id}`);
            let cadence: unknown = null;
            try {
                cadence = await analyzeCadence(env.DB, model.id, '1h');
            } catch {
                cadence = null;
            }
            return {
                ...model,
                effectiveProvider: providerId.replace('ollama-', ''),
                effectiveStatus: effectiveStatus?.public_status ?? 'UNKNOWN',
                effectiveClassification: effectiveStatus?.classification ?? 'UNKNOWN',
                lastCheckAt: effectiveStatus?.last_check_at ?? null,
                lastLatencyMs: effectiveStatus?.last_latency_ms ?? null,
                intervalMinutes,
                metrics: latencyMetrics(providerChecks),
                history:
                    configuration.range === '1h'
                        ? executionHistoryBuckets(
                              executionsByModel.get(model.id) ?? [],
                              modelChecks,
                              timestamp,
                          )
                        : historyBuckets(providerChecks, configuration.range, timestamp),
                cadence,
            };
        }),
    );
    return json({
        lastUpdatedAt: monitor.lastSuccessfulFinishedAt,
        checkIntervals: {
            free: nominalCheckIntervalMinutes('FREE', env),
            paid: nominalCheckIntervalMinutes('PAID', env),
        },
        nextUpdates: nextUpdatesForModels(modelResult.results),
        range: configuration.range,
        monitor: monitor.lastRun,
        monitorProgress: monitor.currentRun ?? monitor.lastRun,
        monitorActive: monitor.currentRun !== null,
        stuckRun: monitor.stuckRun,
        stale: monitor.stale,
        infeasible: monitor.infeasible,
        providers: providers.results,
        models,
    });
}

async function modelDetail(
    env: ApiEnv,
    modelId: string,
    history: boolean,
    range: string | null,
): Promise<Response> {
    const model = await env.DB.prepare(
        "SELECT * FROM models WHERE id=? AND provider_id='ollama-free'",
    )
        .bind(modelId)
        .first<{ tier: string }>();
    if (!model) return json({ error: 'Model not found' }, 404);
    if (!history) return json({ model });
    const configuration = rangeConfiguration(range);
    const from = configuration.start.toISOString();
    const checks = await env.DB.prepare(
        'SELECT provider_id,checked_at,classification,public_status,total_duration_ms,rtt_ms,ttft_ms,load_duration_ms FROM checks WHERE model_id=? AND checked_at>=? ORDER BY checked_at',
    )
        .bind(modelId, from)
        .all();
    return json({
        model,
        range: configuration.range,
        metrics: latencyMetrics(checks.results as HistoryCheck[]),
        checks: checks.results,
    });
}

async function incidents(env: ApiEnv): Promise<Response> {
    const result = await env.DB.prepare(
        `SELECT i.*,m.remote_name,p.name provider_name FROM incidents i JOIN models m ON m.id=i.model_id JOIN providers p ON p.id=i.provider_id ORDER BY i.started_at DESC LIMIT 100`,
    ).all();
    return json({ incidents: result.results });
}

async function monitor(env: ApiEnv): Promise<Response> {
    const runs = await monitorRuns(env);
    return json(runs);
}

async function cadenceHandler(env: ApiEnv, rawWindow: string | null): Promise<Response> {
    const window = rawWindow === '24h' ? '24h' : '1h';
    const models = await env.DB.prepare(
        'SELECT id, remote_name, tier FROM models WHERE active=1 AND excluded=0 ORDER BY tier, remote_name',
    ).all<{ id: string; remote_name: string; tier: string }>();

    const results = await Promise.all(
        models.results.map((model) =>
            analyzeCadence(env.DB, model.id, window).then((c) => ({
                modelId: model.id,
                modelName: model.remote_name,
                tier: model.tier,
                nominalExpected: c.nominalExpected,
                satisfied: c.satisfied,
                suppressed: c.suppressed,
                missed: c.missed,
                nominalCoverage: c.nominalCoverage,
                policyAdherence: c.policyAdherence,
                state: c.state,
                dominantReason: c.dominantReason,
            })),
        ),
    );

    const reasonDistribution = new Map<string, number>();
    let degradedCount = 0;
    let breachedCount = 0;
    for (const r of results) {
        if (r.state === 'DEGRADED') degradedCount++;
        if (r.state === 'BREACHED') breachedCount++;
        if (r.dominantReason) {
            reasonDistribution.set(r.dominantReason, (reasonDistribution.get(r.dominantReason) ?? 0) + 1);
        }
    }

    return json({
        window,
        evaluatedAt: now(),
        models: results,
        summary: {
            totalModels: results.length,
            degradedCount,
            breachedCount,
            reasonDistribution: Object.fromEntries(reasonDistribution),
        },
    });
}

type MonitorRun = {
    id: string;
    started_at: string;
    finished_at: string | null;
    outcome: string | null;
    detail: string | null;
    phase: string;
    catalog_model_count: number;
    scheduled_model_count: number;
    completed_model_count: number;
    free_probe_count: number;
    paid_probe_count: number;
    paid_skipped_count: number;
    failed_probe_count: number;
    current_model: string | null;
};

async function monitorRuns(env: ApiEnv) {
    const [result, successfulResult] = await Promise.all([
        env.DB.prepare(
            `SELECT id,started_at,finished_at,outcome,detail,phase,catalog_model_count,scheduled_model_count,
    completed_model_count,free_probe_count,paid_probe_count,paid_skipped_count,failed_probe_count,current_model
    FROM monitor_runs ORDER BY started_at DESC LIMIT 20`,
        ).all<MonitorRun>(),
        env.DB.prepare(
            // Mirrors SUCCESSFUL_OUTCOMES — keep in sync when adding run outcomes.
            "SELECT outcome,finished_at FROM monitor_runs WHERE outcome IN ('OK','PARTIAL') AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1",
        ).all<Pick<MonitorRun, 'outcome' | 'finished_at'>>(),
    ]);
    const latest = result.results[0] ?? null;
    // Reconcile a genuinely-active run vs a stuck one (no finished_at but older than one cron
    // interval) so the dashboard doesn't freeze on a stale `Run X/Y`. Read-side only; the next
    // cron tick reclaims the lock and closes the orphaned run for real (runMonitor's ABANDONED
    // sweep).
    const { current, stuck: stuckRun } = findActiveRun(result.results, Date.now());
    const stale =
        !latest?.started_at || Date.now() - new Date(latest.started_at).getTime() > 20 * 60_000;
    return {
        stale,
        infeasible: isInfeasible(result.results),
        lastRun: latest,
        currentRun: current,
        stuckRun,
        lastSuccessfulFinishedAt: lastSuccessfulFinishedAt(successfulResult.results),
        runs: result.results,
    };
}

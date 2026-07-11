import { ensureProviders } from './monitor';
import type { Env } from './types';
import { now } from './types';

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

// Fixed 5-minute buckets for the 1h range, decoupled from the per-tier check cadence so
// staggered/async checks land wherever they land without creating false "no data" gaps.
const HISTORY_1H_BUCKET_MINUTES = 5;

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
};
export type HistorySegment = { status: string; checks: number };
export type HistoryBucket = {
    startAt: string;
    status: string;
    checks: number;
    segments: HistorySegment[];
    averageLatencyMs: number | null;
    latencySamples: number;
    // True on an empty bucket that contains "now" — the current cycle's check hasn't
    // landed yet (run in progress or next check still pending). Older empty buckets are
    // genuine "no data" gaps. Only meaningful when checks === 0.
    pending?: boolean;
};
type ScheduledModel = { tier: string; next_check_at: string | null };

const rangeConfiguration = (
    requestedRange: string | null,
    timestamp = new Date(),
): { range: HistoryRange; bucketCount: number; bucketDurationMs: number; start: Date } => {
    const range: HistoryRange =
        requestedRange === '24h' || requestedRange === '7d' || requestedRange === '30d'
            ? requestedRange
            : '1h';
    const bucketDurationMs =
        range === '1h'
            ? HISTORY_1H_BUCKET_MINUTES * 60_000
            : range === '24h'
              ? 3_600_000
              : 86_400_000;
    const bucketCount =
        range === '1h'
            ? 60 / HISTORY_1H_BUCKET_MINUTES
            : range === '24h'
              ? 24
              : range === '7d'
                ? 7
                : 30;
    const start = new Date(timestamp);
    if (range === '1h') {
        // Grid-align to the 5-minute slot containing `now` so bucket boundaries depend only
        // on each check's timestamp, not on when the request happens. The window shifts
        // discretely (only when `now` crosses a slot boundary) instead of sliding
        // continuously, so a check never flits between buckets across refreshes — no
        // transient holes that later "refill". The last bucket is the slot containing `now`.
        const slotStartMs = Math.floor(timestamp.getTime() / bucketDurationMs) * bucketDurationMs;
        start.setTime(slotStartMs - (bucketCount - 1) * bucketDurationMs);
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
    const lastIndex = config.bucketCount - 1;
    // Only the 1h range distinguishes "pending" from "no data"; coarser ranges keep their
    // existing semantics where an empty bucket is simply "no data".
    const markPending = config.range === '1h';
    const buckets = Array.from({ length: config.bucketCount }, (_, index) => ({
        startAt: new Date(config.start.getTime() + index * config.bucketDurationMs).toISOString(),
        status: 'UNKNOWN',
        checks: 0,
        segmentCounts: new Map<string, number>(),
        totalDurations: [] as number[],
        rtts: [] as number[],
        // The last bucket ends at `timestamp` (now); when empty it means the current cycle's
        // check hasn't landed yet (run in progress or next check still pending), not a gap.
        pending: markPending && index === lastIndex,
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
        bucket.segmentCounts.set(
            check.public_status,
            (bucket.segmentCounts.get(check.public_status) ?? 0) + 1,
        );
        if (typeof check.total_duration_ms === 'number')
            bucket.totalDurations.push(check.total_duration_ms);
        if (typeof check.rtt_ms === 'number') bucket.rtts.push(check.rtt_ms);
    }
    return buckets.map(({ totalDurations, rtts, segmentCounts, ...bucket }) => {
        const timings = totalDurations.length ? totalDurations : rtts;
        const averageLatencyMs = timings.length
            ? timings.reduce((sum, value) => sum + value, 0) / timings.length
            : null;
        const segments = [...segmentCounts]
            .map(([status, checks]) => ({ status, checks }))
            .sort(
                (left, right) =>
                    (statusWeight[right.status] ?? statusWeight.UNKNOWN) -
                        (statusWeight[left.status] ?? statusWeight.UNKNOWN) ||
                    left.status.localeCompare(right.status),
            );
        return { ...bucket, segments, averageLatencyMs, latencySamples: timings.length };
    });
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

function latencyMetrics(checks: HistoryCheck[]) {
    const totalDurations = checks
        .map((check) => check.total_duration_ms)
        .filter((value): value is number => typeof value === 'number');
    const rtts = checks
        .map((check) => check.rtt_ms)
        .filter((value): value is number => typeof value === 'number');
    const latencySource = totalDurations.length ? 'TOTAL_DURATION' : rtts.length ? 'RTT' : null;
    const timings = (totalDurations.length ? totalDurations : rtts).sort((a, b) => a - b);
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
    env: Env,
    ctx: ExecutionContext,
    path: string,
): Promise<Response> {
    if (path === '/api/internal/confirmation' && request.method === 'POST')
        return confirmation(request, env);
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    // Public GET endpoints change only when the monitor writes (every ~5 min), so a 60s Cache API
    // TTL serves the dashboard's 30s polling from cache ~98% of the time. Data is at most ~1 min
    // stale while the next check is up to 5 min away, so this never hides a state change that the
    // dashboard would otherwise already see as fresh.
    const cacheKey = new Request(request.url, { method: 'GET' });
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

async function publicGetResponse(request: Request, env: Env, path: string): Promise<Response> {
    if (path === '/api/v1/status')
        return publicStatus(env, new URL(request.url).searchParams.get('range'));
    if (path === '/api/v1/incidents') return incidents(env);
    if (path === '/api/v1/monitor') return monitor(env);
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

async function confirmation(request: Request, env: Env): Promise<Response> {
    if (!env.CONFIRMATION_HMAC_SECRET) return new Response('Not configured', { status: 503 });
    const raw = await request.text();
    const signature = request.headers.get('x-confirmation-signature') ?? '';
    const expected = await hmac(raw, env.CONFIRMATION_HMAC_SECRET);
    if (!constantTimeEqual(signature, expected))
        return new Response('Unauthorized', { status: 401 });
    const body = JSON.parse(raw) as {
        incidentId?: string;
        nonce?: string;
        classification?: string;
    };
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

async function publicStatus(env: Env, requestedRange: string | null): Promise<Response> {
    await ensureProviders(env);
    const timestamp = new Date();
    const configuration = rangeConfiguration(requestedRange, timestamp);
    const [providers, modelResult, statuses, checks, monitor] = await Promise.all([
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
            "SELECT c.provider_id,c.model_id,c.checked_at,c.public_status,c.classification,c.total_duration_ms,c.rtt_ms FROM checks c JOIN models m ON m.id=c.model_id WHERE m.provider_id='ollama-free' AND c.checked_at>=? ORDER BY c.checked_at",
        )
            .bind(configuration.start.toISOString())
            .all<HistoryCheck>(),
        monitorRuns(env),
    ]);
    const models = modelResult.results.map((model) => {
        const providerId = effectiveProvider(model.tier, model.id, statuses.results);
        const providerChecks = checks.results.filter(
            (check) => check.model_id === model.id && check.provider_id === providerId,
        );
        const effectiveStatus = statuses.results.find(
            (status) => status.model_id === model.id && status.provider_id === providerId,
        );
        return {
            ...model,
            effectiveProvider: providerId.replace('ollama-', ''),
            effectiveStatus: effectiveStatus?.public_status ?? 'UNKNOWN',
            effectiveClassification: effectiveStatus?.classification ?? 'UNKNOWN',
            lastCheckAt: effectiveStatus?.last_check_at ?? null,
            lastLatencyMs: effectiveStatus?.last_latency_ms ?? null,
            metrics: latencyMetrics(providerChecks),
            history: historyBuckets(providerChecks, configuration.range, timestamp),
        };
    });
    return json({
        lastUpdatedAt: monitor.lastSuccessfulFinishedAt,
        nextUpdates: nextUpdatesForModels(modelResult.results),
        range: configuration.range,
        monitor: monitor.lastRun,
        monitorProgress: monitor.currentRun ?? monitor.lastRun,
        monitorActive: monitor.currentRun !== null,
        stale: monitor.stale,
        infeasible: monitor.infeasible,
        providers: providers.results,
        models,
    });
}

async function modelDetail(
    env: Env,
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
        'SELECT provider_id,checked_at,classification,public_status,total_duration_ms,rtt_ms,load_duration_ms FROM checks WHERE model_id=? AND checked_at>=? ORDER BY checked_at',
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

async function incidents(env: Env): Promise<Response> {
    const result = await env.DB.prepare(
        `SELECT i.*,m.remote_name,p.name provider_name FROM incidents i JOIN models m ON m.id=i.model_id JOIN providers p ON p.id=i.provider_id ORDER BY i.started_at DESC LIMIT 100`,
    ).all();
    return json({ incidents: result.results });
}

async function monitor(env: Env): Promise<Response> {
    const runs = await monitorRuns(env);
    return json(runs);
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

async function monitorRuns(env: Env) {
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
    const current = result.results.find((run) => !run.finished_at) ?? null;
    const stale =
        !latest?.started_at || Date.now() - new Date(latest.started_at).getTime() > 20 * 60_000;
    return {
        stale,
        infeasible: isInfeasible(result.results),
        lastRun: latest,
        currentRun: current,
        lastSuccessfulFinishedAt: lastSuccessfulFinishedAt(successfulResult.results),
        runs: result.results,
    };
}

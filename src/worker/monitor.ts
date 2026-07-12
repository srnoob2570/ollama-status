import { OllamaHttpError, OllamaProvider, PROBE_TIMEOUT_MS } from './ollama.ts';
import { entitlementFromFreeProbe, shouldProbePaid } from './entitlement.ts';
import { maxResponseTokens } from './probe-config.ts';
import {
    CRON_INTERVAL_MS,
    eligibilityCutoff,
    nextCheckAt,
    nominalCheckIntervalMinutes,
    trimmedMean,
} from './status.ts';
import type { Classification, Env, Model, ProbeResult, Provider } from './types.ts';
import { id, now } from './types.ts';

const providerSeeds = [
    { id: 'ollama-free', name: 'Ollama Cloud Free', secret: 'OLLAMA_API_KEY_FREE' },
    { id: 'ollama-paid', name: 'Ollama Cloud Paid', secret: 'OLLAMA_API_KEY_PAID' },
] as const;

// The whole active catalog (34 models today) must fit in one run, or models get starved
// past their cadence and drift to "checked N minutes ago". Kept above catalog size with
// room to grow.
const MAX_MODELS_PER_RUN = 40;
const PROBE_CONCURRENCY_MAX = 16;
const FREE_PROBE_CONCURRENCY_DEFAULT = 1;
const PAID_PROBE_CONCURRENCY_DEFAULT = 6;
const PROBE_DELAY_MIN_MS_DEFAULT = 0;
const PROBE_DELAY_MAX_MS_DEFAULT = 5_000;
const LOCK_LEASE_MS = 6 * 60_000;
// Absolute wall-clock budget after which a run is forcibly aborted regardless of why it stalled.
// A legitimate run finishes within one cron interval (the soft deadline in runDeadlineMs stops it
// starting new batches ~245s in, and the in-flight batch adds ~55s of margin). This hard stop only
// fires when a run has already overstayed that budget — i.e. it is stuck on a stalled fetch (a
// probe stream, a catalog /tags, or the GitHub confirmation dispatch) that the per-probe 45s timer
// or the fetch's own timeout didn't catch. Aborting cancels only in-flight fetches (D1 writes don't
// accept a signal and already have Cloudflare-side timeouts), so a legitimate run in its final D1
// write phase is unaffected. The run is then closed as ABANDONED/hard_stop and the next cron tick
// reclaims the lock, so a stuck run can never block the scheduler indefinitely or renew its lease
// past the next tick. Capped at one cron interval so recovery happens on the next cycle.
const RUN_HARD_STOP_MS = CRON_INTERVAL_MS;
// Upper bound for the external-confirmation GitHub dispatch, which has no per-request timeout of
// its own. A slow/hung GitHub API must not hold a probe batch (and thus the run) open.
const CONFIRMATION_TIMEOUT_MS = 15_000;

// Process-local guards that skip idempotent D1 writes repeated every cron tick. They reset if
// the Worker isolate is evicted, in which case the guarded write runs once more (still
// idempotent). Trades negligible staleness for a large write-budget reduction on the free plan.
let providersSeeded = false;
let lastRolledHour: string | null = null;
let lastCleanupDay: string | null = null;

// Free and Paid probes use independent worker pools. Paid work only becomes eligible after the
// corresponding Free probe reports SUBSCRIPTION_REQUIRED, so a higher Paid limit can overlap
// later Free classifications without increasing pressure on the Free API key.
function configuredProbeConcurrency(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, PROBE_CONCURRENCY_MAX);
}

export function freeProbeConcurrency(env: Env): number {
    return configuredProbeConcurrency(env.FREE_PROBE_CONCURRENCY, FREE_PROBE_CONCURRENCY_DEFAULT);
}

export function paidProbeConcurrency(env: Env): number {
    return configuredProbeConcurrency(env.PAID_PROBE_CONCURRENCY, PAID_PROBE_CONCURRENCY_DEFAULT);
}

// Random delay in [min, max] applied before each probe so staggered requests don't burst.
export function probeDelayMs(env: Env): { min: number; max: number } {
    const minParsed = Number.parseInt(env.PROBE_DELAY_MIN_MS ?? '', 10);
    const maxParsed = Number.parseInt(env.PROBE_DELAY_MAX_MS ?? '', 10);
    const min =
        Number.isFinite(minParsed) && minParsed >= 0 ? minParsed : PROBE_DELAY_MIN_MS_DEFAULT;
    const max =
        Number.isFinite(maxParsed) && maxParsed >= 0 ? maxParsed : PROBE_DELAY_MAX_MS_DEFAULT;
    if (min > max) return { min: max, max: min };
    return { min, max };
}

export function randomDelay(env: Env): number {
    const { min, max } = probeDelayMs(env);
    if (max === min) return min;
    return min + Math.floor(Math.random() * (max - min + 1));
}

// Buffer beyond probe timeout + max delay so a last in-flight batch started just before the
// deadline still finishes inside the cron interval (and the lock is released before the next
// tick, preventing skipped ticks that would double the effective cadence to ~10 min).
const RUN_DEADLINE_BUFFER_MS = 5_000;

// Absolute wall-clock deadline by which the probe loop must stop starting new batches so the
// run finishes within one cron interval. `startedMs` is the run's started_at epoch ms. The
// margin absorbs a full in-flight batch (one probe up to PROBE_TIMEOUT_MS + the configured max
// delay) plus a small buffer. If the margin alone exceeds the cron interval (e.g. a huge
// configured delay), the deadline falls at/ before the start, marking the run infeasible.
export function runDeadlineMs(startedMs: number, env: Env): number {
    const safetyMarginMs = PROBE_TIMEOUT_MS + probeDelayMs(env).max + RUN_DEADLINE_BUFFER_MS;
    return startedMs + CRON_INTERVAL_MS - safetyMarginMs;
}

function keyFor(env: Env, ref: Provider['secret_ref']) {
    return env[ref] ?? '';
}
function hasKey(env: Env, provider: Provider) {
    return keyFor(env, provider.secret_ref).trim().length > 0;
}
function excluded(env: Env, model: string) {
    return (env.EXCLUDED_MODELS ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .includes(model);
}
function isFailure(c: Classification) {
    return !['SUCCESS', 'HIGH_LATENCY', 'SUBSCRIPTION_REQUIRED'].includes(c);
}
export function nextCheckTier(
    provider: Provider,
    model: Model,
    result: ProbeResult,
): 'FREE' | 'PAID' | 'UNKNOWN' {
    if (provider.id === 'ollama-paid') return 'PAID';
    if (provider.id === 'ollama-free') {
        if (result.classification === 'SUBSCRIPTION_REQUIRED') return 'PAID';
        if (result.classification === 'SUCCESS' || result.classification === 'HIGH_LATENCY')
            return 'FREE';
    }
    return model.tier ?? 'UNKNOWN';
}

export async function ensureProviders(env: Env): Promise<void> {
    if (providersSeeded) return;
    const timestamp = now();
    for (const seed of providerSeeds)
        await env.DB.prepare(
            "INSERT OR IGNORE INTO providers (id,name,kind,base_url,secret_ref,created_at) VALUES (?,?,'ollama',?,?,?)",
        )
            .bind(seed.id, seed.name, env.OLLAMA_BASE_URL, seed.secret, timestamp)
            .run();
    providersSeeded = true;
}

export async function acquireLock(env: Env, name: string, owner: string): Promise<boolean> {
    const timestamp = now(),
        lease = new Date(Date.now() + LOCK_LEASE_MS).toISOString();
    const result = await env.DB.prepare(
        `INSERT INTO scheduler_locks(name, lease_until, owner, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET lease_until=excluded.lease_until, owner=excluded.owner, updated_at=excluded.updated_at
    WHERE scheduler_locks.lease_until < excluded.updated_at`,
    )
        .bind(name, lease, owner, timestamp)
        .run();
    return result.meta.changes === 1;
}

async function releaseLock(env: Env, name: string, owner: string): Promise<void> {
    await env.DB.prepare('DELETE FROM scheduler_locks WHERE name=? AND owner=?')
        .bind(name, owner)
        .run();
}

export async function renewLock(env: Env, name: string, owner: string): Promise<boolean> {
    const timestamp = now(),
        lease = new Date(Date.now() + LOCK_LEASE_MS).toISOString();
    const result = await env.DB.prepare(
        'UPDATE scheduler_locks SET lease_until=?,updated_at=? WHERE name=? AND owner=?',
    )
        .bind(lease, timestamp, name, owner)
        .run();
    return result.meta.changes === 1;
}

async function providers(env: Env): Promise<Provider[]> {
    const result = await env.DB.prepare(
        'SELECT id,name,base_url,secret_ref FROM providers WHERE active=1',
    ).all<Provider>();
    return result.results.map((p) => ({
        ...p,
        secret_ref: p.secret_ref as Provider['secret_ref'],
    }));
}

async function syncCatalog(
    env: Env,
    provider: Provider,
    signal?: AbortSignal,
): Promise<number | null> {
    const client = new OllamaProvider(
        provider,
        keyFor(env, provider.secret_ref),
        maxResponseTokens(env.OLLAMA_MAX_TOKENS),
    );
    try {
        const catalog = await client.tags(signal);
        const timestamp = now();
        const existingModels = await env.DB.prepare(
            'SELECT id,remote_name,last_show_at,digest,active FROM models WHERE provider_id=?',
        )
            .bind('ollama-free')
            .all<{
                id: string;
                remote_name: string;
                last_show_at: string | null;
                digest: string | null;
                active: number;
            }>();
        const existingByRemoteName = new Map(
            existingModels.results.map((model) => [model.remote_name, model]),
        );
        for (const remote of catalog.models) {
            // Reuse the former free-account ID during the one-time schema transition.
            // It is now the global model identity and preserves all compatible history.
            const remoteDigest = remote.digest ?? null;
            const existing = existingByRemoteName.get(remote.name);
            const modelId = existing?.id ?? `ollama:${remote.name}`;
            // Skip the upsert when nothing material changed: re-running it would only rewrite
            // updated_at and reactivate an already-active row with the same digest, burning one
            // write per model per cycle for no effect. A new model, a digest change, or a
            // previously deactivated row (active=0) still re-upserts to (re)insert/refresh as before.
            if (!existing || existing.digest !== remoteDigest || existing.active !== 1) {
                await env.DB.prepare(
                    `INSERT INTO models(id,provider_id,remote_name,active,excluded,digest,next_check_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest, active=1, updated_at=excluded.updated_at`,
                )
                    .bind(
                        modelId,
                        provider.id,
                        remote.name,
                        1,
                        excluded(env, remote.name) ? 1 : 0,
                        remoteDigest,
                        timestamp,
                        timestamp,
                        timestamp,
                    )
                    .run();
            }
            if (
                !existing?.last_show_at ||
                existing.digest !== remoteDigest ||
                Date.now() - new Date(existing.last_show_at).getTime() >= 24 * 60 * 60_000
            ) {
                try {
                    const details = await client.show(remote.name, signal);
                    await env.DB.prepare(
                        'UPDATE models SET details_json=?,last_show_at=? WHERE id=?',
                    )
                        .bind(JSON.stringify(details), timestamp, modelId)
                        .run();
                } catch {
                    /* show metadata is diagnostic only; catalog remains valid */
                }
            }
        }
        await env.DB.prepare(
            "UPDATE providers SET catalog_status='OK',catalog_checked_at=? WHERE id=?",
        )
            .bind(timestamp, provider.id)
            .run();
        return catalog.models.length;
    } catch (error) {
        const code =
            error instanceof OllamaHttpError
                ? `HTTP_${error.status}`
                : error instanceof TypeError
                  ? 'NETWORK'
                  : 'CATALOG_ERROR';
        await env.DB.prepare(
            'UPDATE providers SET catalog_status=?,catalog_checked_at=? WHERE id=?',
        )
            .bind(code, now(), provider.id)
            .run();
        return null;
    }
}

async function baseline(
    env: Env,
    providerId: string,
    modelId: string,
): Promise<number | undefined> {
    const result = await env.DB.prepare(
        "SELECT total_duration_ms FROM checks WHERE provider_id=? AND model_id=? AND classification='SUCCESS' AND total_duration_ms IS NOT NULL ORDER BY checked_at DESC LIMIT 20",
    )
        .bind(providerId, modelId)
        .all<{ total_duration_ms: number }>();
    return trimmedMean(result.results.map((x) => x.total_duration_ms));
}

async function storeProbe(
    env: Env,
    provider: Provider,
    model: Model,
    result: ProbeResult,
    executionId: string,
    scheduledAtMs: number,
): Promise<void> {
    const timestamp = now();
    const inserted = await env.DB.prepare(
        `INSERT INTO checks(id,provider_id,model_id,checked_at,classification,public_status,http_status,total_duration_ms,rtt_ms,load_duration_ms,error_code,execution_id)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?
         WHERE EXISTS (SELECT 1 FROM model_check_executions WHERE id=? AND state='RUNNING')`,
    )
        .bind(
            id('chk'),
            provider.id,
            model.id,
            timestamp,
            result.classification,
            result.publicStatus,
            result.httpStatus ?? null,
            result.totalDurationMs ?? null,
            result.rttMs,
            result.loadDurationMs ?? null,
            result.errorCode ?? null,
            executionId,
            executionId,
        )
        .run();
    if (inserted.meta.changes !== 1) throw new Error('execution_not_running');
    await materializeStatus(env, provider, model, result, timestamp, scheduledAtMs);
}

export async function materializeStatus(
    env: Env,
    provider: Provider,
    model: Model,
    result: ProbeResult,
    timestamp: string,
    scheduledAtMs: number = Date.parse(timestamp),
): Promise<void> {
    const prior = await env.DB.prepare(
        'SELECT * FROM provider_model_status WHERE provider_id=? AND model_id=?',
    )
        .bind(provider.id, model.id)
        .first<{
            public_status: string;
            consecutive_successes: number;
            consecutive_failures: number;
            consecutive_high_latency: number;
            incident_id: string | null;
        }>();
    const success = result.classification === 'SUCCESS';
    const high = result.classification === 'HIGH_LATENCY';
    const active = prior?.incident_id
        ? await env.DB.prepare("SELECT id,status FROM incidents WHERE id=? AND status='OPEN'")
              .bind(prior.incident_id)
              .first<{ id: string }>()
        : null;
    const failures = isFailure(result.classification) ? (prior?.consecutive_failures ?? 0) + 1 : 0;
    const successes = success ? (prior?.consecutive_successes ?? 0) + 1 : 0;
    const highLatency = high ? (prior?.consecutive_high_latency ?? 0) + 1 : 0;
    const recentFailures = await fiveCheckFailures(env, provider.id, model.id);
    const status = materializedStatus({
        priorStatus: prior?.public_status ?? 'UNKNOWN',
        classification: result.classification,
        resultStatus: result.publicStatus,
        successes,
        failures,
        recentFailures,
        highLatency,
        hasActiveIncident: Boolean(active),
    });
    const confirmedFailure =
        isFailure(result.classification) && (failures >= 2 || recentFailures >= 3);
    const confirmedHighLatency = high && highLatency >= 2;

    await env.DB.prepare(
        `INSERT INTO provider_model_status(provider_id,model_id,public_status,classification,consecutive_successes,consecutive_failures,consecutive_high_latency,last_check_at,last_latency_ms,incident_id,next_check_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider_id,model_id) DO UPDATE SET public_status=excluded.public_status,classification=excluded.classification,consecutive_successes=excluded.consecutive_successes,consecutive_failures=excluded.consecutive_failures,consecutive_high_latency=excluded.consecutive_high_latency,last_check_at=excluded.last_check_at,last_latency_ms=excluded.last_latency_ms,incident_id=excluded.incident_id,next_check_at=excluded.next_check_at,updated_at=excluded.updated_at`,
    )
        .bind(
            provider.id,
            model.id,
            status,
            result.classification,
            successes,
            failures,
            highLatency,
            timestamp,
            result.totalDurationMs ?? null,
            prior?.incident_id ?? null,
            nextCheckAt(
                result.publicStatus,
                result.publicStatus === 'OUTAGE',
                result.retryAfterSeconds,
                nextCheckTier(provider, model, result),
                env,
                scheduledAtMs,
                Date.parse(timestamp),
            ),
            timestamp,
        )
        .run();
    if (provider.id === 'ollama-free') {
        const tier =
            result.classification === 'SUBSCRIPTION_REQUIRED'
                ? 'PAID'
                : ['SUCCESS', 'HIGH_LATENCY'].includes(result.classification)
                  ? 'FREE'
                  : null;
        // Only persist tier when it actually changes; a stable FREE/PAID model would otherwise
        // rewrite the same row every probe (one write per model per cycle for no effect).
        if (tier && model.tier !== tier)
            await env.DB.prepare('UPDATE models SET tier=?,updated_at=? WHERE id=?')
                .bind(tier, timestamp, model.id)
                .run();
    }
    if (status !== 'OPERATIONAL' && !active && (confirmedFailure || confirmedHighLatency)) {
        const incidentId = id('inc');
        await env.DB.batch([
            env.DB.prepare(
                'INSERT INTO incidents(id,provider_id,model_id,kind,started_at,summary,last_classification) VALUES (?,?,?,?,?,?,?)',
            ).bind(
                incidentId,
                provider.id,
                model.id,
                status,
                timestamp,
                `${model.remote_name} is ${status.toLowerCase()} for ${provider.name}`,
                result.classification,
            ),
            env.DB.prepare(
                'UPDATE provider_model_status SET incident_id=? WHERE provider_id=? AND model_id=?',
            ).bind(incidentId, provider.id, model.id),
        ]);
        try {
            await requestExternalConfirmation(env, incidentId);
        } catch (error) {
            console.warn(`external confirmation dispatch failed: ${error}`);
        }
    } else if (status === 'OPERATIONAL' && active && successes >= 2) {
        await env.DB.batch([
            env.DB.prepare(
                "UPDATE incidents SET status='RESOLVED',resolved_at=?,last_classification=? WHERE id=?",
            ).bind(timestamp, result.classification, active.id),
            env.DB.prepare(
                'UPDATE provider_model_status SET incident_id=NULL WHERE provider_id=? AND model_id=?',
            ).bind(provider.id, model.id),
        ]);
    }
}

export function materializedStatus(input: {
    priorStatus: string;
    classification: Classification;
    resultStatus: ProbeResult['publicStatus'];
    successes: number;
    failures: number;
    recentFailures: number;
    highLatency: number;
    hasActiveIncident: boolean;
}): string {
    if (input.classification === 'SUBSCRIPTION_REQUIRED') return 'PLAN_REQUIRED';
    if (isFailure(input.classification) && (input.failures >= 2 || input.recentFailures >= 3))
        return input.resultStatus;
    if (input.classification === 'HIGH_LATENCY' && input.highLatency >= 2) return 'DEGRADED';
    if (input.successes >= 2 || (input.classification === 'SUCCESS' && !input.hasActiveIncident))
        return 'OPERATIONAL';
    return input.priorStatus;
}

async function requestExternalConfirmation(env: Env, incidentId: string): Promise<void> {
    if (!env.GITHUB_REPOSITORY || !env.GITHUB_ACTIONS_TOKEN || !env.CONFIRMATION_CALLBACK_URL)
        return;
    const nonce = crypto.randomUUID(),
        expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    await env.DB.prepare(
        'INSERT INTO region_confirmations(id,incident_id,nonce,expires_at) VALUES (?,?,?,?)',
    )
        .bind(id('confirm'), incidentId, nonce, expiresAt)
        .run();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIRMATION_TIMEOUT_MS);
    let response: Response;
    try {
        response = await fetch(
            `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/external-confirmation.yml/dispatches`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
                    Accept: 'application/vnd.github+json',
                    'content-type': 'application/json',
                    'user-agent': 'ollama-status-monitor',
                },
                body: JSON.stringify({
                    ref: 'master',
                    inputs: {
                        endpoint: env.CONFIRMATION_CALLBACK_URL,
                        nonce,
                        incident_id: incidentId,
                    },
                }),
                signal: controller.signal,
            },
        );
    } finally {
        clearTimeout(timer);
    }
    if (!response.ok) throw new Error('confirmation_dispatch_failed');
    await env.DB.prepare('UPDATE incidents SET external_confirmation_requested_at=? WHERE id=?')
        .bind(now(), incidentId)
        .run();
}

async function fiveCheckFailures(env: Env, providerId: string, modelId: string): Promise<number> {
    const result = await env.DB.prepare(
        'SELECT classification FROM checks WHERE provider_id=? AND model_id=? ORDER BY checked_at DESC LIMIT 5',
    )
        .bind(providerId, modelId)
        .all<{ classification: Classification }>();
    return result.results.filter((x) => isFailure(x.classification)).length;
}

async function probeModel(
    env: Env,
    provider: Provider,
    model: Model,
    executionId: string,
    scheduledAtMs: number,
    signal?: AbortSignal,
): Promise<ProbeResult> {
    // Configurable delay spreads probes over time so free API keys (1 concurrent model)
    // don't burst into 429s, without making a scheduled run take minutes.
    await new Promise((resolve) => setTimeout(resolve, randomDelay(env)));
    const client = new OllamaProvider(
        provider,
        keyFor(env, provider.secret_ref),
        maxResponseTokens(env.OLLAMA_MAX_TOKENS),
    );
    // A transient failure is left to reschedule on its own cadence (~5 min) instead of
    // blocking the run with an inline retry that staggers every model behind it; a single
    // failed check never materializes an incident on its own, so nothing is lost.
    const result = await client.probe(
        model.remote_name,
        await baseline(env, provider.id, model.id),
        signal,
    );
    if (provider.id === 'ollama-free' && result.classification === 'MODEL_NOT_FOUND')
        await env.DB.prepare(
            "UPDATE models SET excluded=1,exclusion_reason='unavailable after catalog' WHERE id=?",
        )
            .bind(model.id)
            .run();
    await storeProbe(env, provider, model, result, executionId, scheduledAtMs);
    return result;
}

function failedProbe(result: ProbeResult): number {
    return isFailure(result.classification) ? 1 : 0;
}

type ScheduledExecution = {
    id: string;
    model: Model;
};

type PaidProbeTask = ScheduledExecution & {
    freeResult: ProbeResult;
};

async function completeExecution(
    env: Env,
    freeProvider: Provider,
    paidProvider: Provider | undefined,
    execution: ScheduledExecution,
    runId: string,
    scheduledAtMs: number,
    freeResult: ProbeResult,
    paidResult?: ProbeResult,
): Promise<void> {
    const effectiveProvider = paidResult && paidProvider ? paidProvider : freeProvider;
    const effectiveResult = paidResult ?? freeResult;
    const paid = paidResult ? 1 : 0;
    const paidSkipped =
        !paidResult && entitlementFromFreeProbe(freeResult.classification) === 'PAID' ? 1 : 0;
    const failed = failedProbe(freeResult) + (paidResult ? failedProbe(paidResult) : 0);
    const completedAt = now();
    const terminal = await env.DB.batch([
        env.DB.prepare(
            `UPDATE models SET next_check_at=?,updated_at=? WHERE id=?
             AND EXISTS (SELECT 1 FROM model_check_executions WHERE id=? AND state='RUNNING')`,
        ).bind(
            nextCheckAt(
                effectiveResult.publicStatus,
                effectiveResult.publicStatus === 'OUTAGE',
                effectiveResult.retryAfterSeconds,
                nextCheckTier(effectiveProvider, execution.model, effectiveResult),
                env,
                scheduledAtMs,
                Date.parse(completedAt),
            ),
            completedAt,
            execution.model.id,
            execution.id,
        ),
        env.DB.prepare(
            `UPDATE monitor_runs SET completed_model_count=completed_model_count+1,
             free_probe_count=free_probe_count+1, paid_probe_count=paid_probe_count+?,
             paid_skipped_count=paid_skipped_count+?, failed_probe_count=failed_probe_count+?, current_model=?
             WHERE id=? AND EXISTS (
                 SELECT 1 FROM model_check_executions WHERE id=? AND state='RUNNING'
             )`,
        ).bind(paid, paidSkipped, failed, execution.model.remote_name, runId, execution.id),
        env.DB.prepare(
            "UPDATE model_check_executions SET state='COMPLETED',completed_at=?,detail=NULL WHERE id=? AND state='RUNNING'",
        ).bind(completedAt, execution.id),
    ]);
    if (terminal[2].meta.changes !== 1) throw new Error('execution_transition_conflict');
}

async function failExecution(
    env: Env,
    executionId: string,
    signal: AbortSignal | undefined,
    error: unknown,
): Promise<void> {
    const state = signal?.aborted ? 'ABANDONED' : 'FAILED';
    const detail = error instanceof Error ? error.message.slice(0, 200) : 'probe_failed';
    await env.DB.prepare(
        "UPDATE model_check_executions SET state=?,completed_at=?,detail=? WHERE id=? AND state='RUNNING'",
    )
        .bind(state, now(), detail, executionId)
        .run();
}

async function probeFree(
    env: Env,
    freeProvider: Provider,
    paidProvider: Provider | undefined,
    execution: ScheduledExecution,
    runId: string,
    scheduledAtMs: number,
    signal?: AbortSignal,
): Promise<PaidProbeTask | undefined> {
    // Claim before Free I/O. It stays RUNNING while queued for Paid work, so recovery can
    // abandon an interrupted execution without allowing a late worker to overwrite it.
    const running = await env.DB.prepare(
        "UPDATE model_check_executions SET state='RUNNING',started_at=?,detail=NULL WHERE id=? AND state='SCHEDULED'",
    )
        .bind(now(), execution.id)
        .run();
    if (running.meta.changes !== 1) throw new Error('execution_not_scheduled');
    try {
        const freeResult = await probeModel(
            env,
            freeProvider,
            execution.model,
            execution.id,
            scheduledAtMs,
            signal,
        );
        const paidAvailable = Boolean(paidProvider && hasKey(env, paidProvider));
        if (shouldProbePaid(freeResult.classification, paidAvailable) && paidProvider) {
            return { ...execution, freeResult };
        }
        await completeExecution(
            env,
            freeProvider,
            paidProvider,
            execution,
            runId,
            scheduledAtMs,
            freeResult,
        );
        return undefined;
    } catch (error) {
        await failExecution(env, execution.id, signal, error);
        throw error;
    }
}

async function probePaid(
    env: Env,
    freeProvider: Provider,
    paidProvider: Provider,
    task: PaidProbeTask,
    runId: string,
    scheduledAtMs: number,
    signal?: AbortSignal,
): Promise<void> {
    try {
        const paidResult = await probeModel(
            env,
            paidProvider,
            task.model,
            task.id,
            scheduledAtMs,
            signal,
        );
        await completeExecution(
            env,
            freeProvider,
            paidProvider,
            task,
            runId,
            scheduledAtMs,
            task.freeResult,
            paidResult,
        );
    } catch (error) {
        await failExecution(env, task.id, signal, error);
        throw error;
    }
}

export async function runMonitor(
    env: Env,
    ctx: ExecutionContext,
    scheduledTimeMs: number = Date.now(),
): Promise<void> {
    const owner = crypto.randomUUID();
    if (!(await acquireLock(env, 'monitor', owner))) return;
    const runId = id('run'),
        started = now(),
        startedMs = Date.now(),
        scheduledAt = new Date(scheduledTimeMs).toISOString();
    let runCreated = false;
    // Hard stop: a run that overstays RUN_HARD_STOP_MS is forcibly aborted so a stalled fetch (probe
    // stream, /tags, /show, or the GitHub confirmation dispatch) can't hold the run and the lock
    // open indefinitely. Aborting cancels in-flight fetches via this signal; D1 writes don't accept
    // it and complete on their own Cloudflare-side timeouts. The run is closed as ABANDONED and the
    // next cron tick reclaims the lock — recovery never depends on the lease expiring.
    const runController = new AbortController();
    const hardStop = setTimeout(() => runController.abort(), RUN_HARD_STOP_MS);
    try {
        // A lock owner must always have a visible run, including initialization failures.
        await env.DB.batch([
            env.DB.prepare(
                `UPDATE model_check_executions SET state='ABANDONED',completed_at=?,detail='interrupted'
                 WHERE state IN ('SCHEDULED','RUNNING') AND run_id IN (SELECT id FROM monitor_runs WHERE finished_at IS NULL)`,
            ).bind(started),
            env.DB.prepare(
                "UPDATE monitor_runs SET finished_at=?,outcome='ERROR',phase='ABANDONED',detail='interrupted',current_model=NULL WHERE finished_at IS NULL",
            ).bind(started),
        ]);
        const insertedRun = await env.DB.prepare(
            "INSERT OR IGNORE INTO monitor_runs(id,started_at,scheduled_at,phase) VALUES (?,?,?,'CATALOG')",
        )
            .bind(runId, started, scheduledAt)
            .run();
        if (insertedRun.meta.changes !== 1) return;
        runCreated = true;
        await ensureProviders(env);
        const activeProviders = await providers(env);
        const freeProvider = activeProviders.find((provider) => provider.id === 'ollama-free');
        const paidProvider = activeProviders.find((provider) => provider.id === 'ollama-paid');
        if (!freeProvider) throw new Error('global_catalog_unavailable');
        const catalogModelCount = await syncCatalog(env, freeProvider, runController.signal);
        if (catalogModelCount === null) throw new Error('global_catalog_unavailable');
        const due = await env.DB.prepare(
            `SELECT id,provider_id,remote_name,digest,last_show_at,tier FROM models WHERE provider_id='ollama-free' AND active=1 AND excluded=0 AND (next_check_at IS NULL OR next_check_at <= ?) ORDER BY next_check_at LIMIT ${MAX_MODELS_PER_RUN}`,
        )
            .bind(eligibilityCutoff(scheduledTimeMs))
            .all<Model>();
        const executions = due.results.map((model) => ({
            id: id('exec'),
            model,
            intervalMinutes: nominalCheckIntervalMinutes(model.tier ?? 'UNKNOWN', env),
        }));
        if (executions.length)
            await env.DB.batch(
                executions.map((execution) =>
                    env.DB.prepare(
                        `INSERT INTO model_check_executions(id,run_id,model_id,tier,interval_minutes,scheduled_at,state)
                         VALUES (?,?,?,?,?,?,'SCHEDULED')`,
                    ).bind(
                        execution.id,
                        runId,
                        execution.model.id,
                        execution.model.tier ?? 'UNKNOWN',
                        execution.intervalMinutes,
                        scheduledAt,
                    ),
                ),
            );
        await env.DB.prepare(
            "UPDATE monitor_runs SET phase='CHECKING',catalog_model_count=?,scheduled_model_count=? WHERE id=?",
        )
            .bind(catalogModelCount, due.results.length, runId)
            .run();
        const freeConcurrency = freeProbeConcurrency(env);
        const paidConcurrency = paidProbeConcurrency(env);
        const freeQueue: ScheduledExecution[] = executions;
        const paidQueue: PaidProbeTask[] = [];
        // Time-box the run so it finishes within one cron interval. Free and Paid workers are
        // independent: a Free result can feed the Paid queue while the Free pool immediately
        // moves to the next model. Once the soft deadline is reached, neither pool starts new
        // I/O; active probes finish normally and only queued Paid work is deferred.
        const deadlineMs = runDeadlineMs(startedMs, env);
        let budgetExceeded = false,
            rejectedExecutions = 0;
        let activeFree = 0,
            activePaid = 0;
        type WorkerResult =
            | { pool: 'free'; task?: PaidProbeTask }
            | { pool: 'paid' }
            | { pool: 'error'; error: unknown };
        const active = new Set<Promise<WorkerResult>>();
        const settled: WorkerResult[] = [];
        const track = (
            pool: 'free' | 'paid',
            work: Promise<PaidProbeTask | undefined> | Promise<void>,
        ) => {
            if (pool === 'free') activeFree += 1;
            else activePaid += 1;
            let tracked: Promise<WorkerResult>;
            tracked = work
                .then((task) =>
                    pool === 'free'
                        ? { pool, task: task as PaidProbeTask | undefined }
                        : { pool },
                )
                .catch((error: unknown) => ({ pool: 'error' as const, error }))
                .then((result) => {
                    settled.push(result);
                    return result;
                })
                .finally(() => {
                    active.delete(tracked);
                    if (pool === 'free') activeFree -= 1;
                    else activePaid -= 1;
                });
            active.add(tracked);
        };
        const consumeSettled = () => {
            for (const result of settled.splice(0)) {
                if (result.pool === 'free' && result.task) paidQueue.push(result.task);
                if (result.pool === 'error') {
                    rejectedExecutions += 1;
                    console.warn(`monitor probe rejected: ${result.error}`);
                }
            }
        };
        const deferPending = async () => {
            const deferredAt = now();
            await env.DB.prepare(
                `UPDATE model_check_executions SET state='DEFERRED',completed_at=?,detail='run_budget_exceeded'
                 WHERE run_id=? AND state='SCHEDULED'`,
            )
                .bind(deferredAt, runId)
                .run();
            // A Paid task has already completed its Free classification and is RUNNING only
            // because it waits for a Paid worker. Do not include active Free/Paid probes here:
            // they are allowed to finish and preserve their normal terminal writes.
            const waitingPaidIds = paidQueue.map((task) => task.id);
            if (waitingPaidIds.length)
                await env.DB.prepare(
                    `UPDATE model_check_executions SET state='DEFERRED',completed_at=?,detail='run_budget_exceeded'
                     WHERE run_id=? AND state='RUNNING' AND id IN (${waitingPaidIds.map(() => '?').join(',')})`,
                )
                    .bind(deferredAt, runId, ...waitingPaidIds)
                    .run();
        };
        const waitForWorker = async () => {
            if (active.size) await Promise.race(active);
            consumeSettled();
        };
        while (freeQueue.length || paidQueue.length || active.size) {
            if (runController.signal.aborted || Date.now() >= startedMs + RUN_HARD_STOP_MS)
                throw new Error('run_hard_stop');
            if (Date.now() >= deadlineMs) {
                budgetExceeded = true;
                break;
            }
            consumeSettled();
            const canStartFree = freeQueue.length > 0 && activeFree < freeConcurrency;
            const canStartPaid = paidQueue.length > 0 && activePaid < paidConcurrency;
            if (!canStartFree && !canStartPaid) {
                await waitForWorker();
                continue;
            }
            // Renew before launching work, not while merely waiting for active probes. A lost
            // lease still abandons every non-terminal execution in the catch path below.
            if (!(await renewLock(env, 'monitor', owner))) throw new Error('monitor_lock_lost');
            while (freeQueue.length && activeFree < freeConcurrency && Date.now() < deadlineMs) {
                const execution = freeQueue.shift();
                if (!execution) break;
                track(
                    'free',
                    probeFree(
                        env,
                        freeProvider,
                        paidProvider,
                        execution,
                        runId,
                        scheduledTimeMs,
                        runController.signal,
                    ),
                );
            }
            while (paidQueue.length && activePaid < paidConcurrency && Date.now() < deadlineMs) {
                const task = paidQueue.shift();
                if (!task || !paidProvider) break;
                track(
                    'paid',
                    probePaid(
                        env,
                        freeProvider,
                        paidProvider,
                        task,
                        runId,
                        scheduledTimeMs,
                        runController.signal,
                    ),
                );
            }
        }
        if (budgetExceeded) {
            // Surface the infeasibility explicitly instead of silently drifting cadence: the
            // run completed without error but couldn't probe every due model within the budget.
            console.warn(
                `monitor run ${runId} budget_exceeded: ${due.results.length} due, deadline reached`,
            );
            // Let already-started Free/Paid probes write their normal results. Their Free
            // completions may add more Paid tasks, which are collected before the final defer.
            while (active.size) await waitForWorker();
            // The hard-stop timer can fire while the soft-deadline drain waits for an active
            // probe. Do not close that run as COMPLETED/PARTIAL: route it through the catch
            // below so every non-terminal execution and the run itself become ABANDONED.
            if (runController.signal.aborted || Date.now() >= startedMs + RUN_HARD_STOP_MS)
                throw new Error('run_hard_stop');
            await deferPending();
        }
        const partial = budgetExceeded || rejectedExecutions > 0;
        const detail = [
            budgetExceeded ? `budget_exceeded:${due.results.length}` : null,
            rejectedExecutions ? `execution_failures:${rejectedExecutions}` : null,
        ]
            .filter((value): value is string => value !== null)
            .join(';');
        await env.DB.prepare(
            "UPDATE monitor_runs SET finished_at=?,outcome=?,phase='COMPLETED',detail=?,current_model=NULL WHERE id=?",
        )
            .bind(now(), partial ? 'PARTIAL' : 'OK', detail || null, runId)
            .run();
    } catch (error) {
        // A hard stop means the run overstayed its budget and was aborted mid-flight; close it as
        // abandoned (not failed) so the UI can distinguish a stuck/interrupted run from a real
        // monitor error, and so the next tick reclaims the lock cleanly. Keep `detail` diagnostic.
        const hardStopHit =
            runController.signal.aborted ||
            (error instanceof Error && error.message === 'run_hard_stop');
        const detail = hardStopHit
            ? 'hard_stop'
            : error instanceof Error && error.message === 'global_catalog_unavailable'
              ? 'catalog_unavailable'
              : 'monitor_failed';
        if (runCreated)
            await env.DB.batch([
                env.DB.prepare(
                    `UPDATE model_check_executions SET state='ABANDONED',completed_at=?,detail=?
                     WHERE run_id=? AND state IN ('SCHEDULED','RUNNING')`,
                ).bind(now(), detail, runId),
                env.DB.prepare(
                    `UPDATE monitor_runs SET finished_at=?,outcome='ERROR',phase=${hardStopHit ? "'ABANDONED'" : "'FAILED'"},detail=?,current_model=NULL WHERE id=?`,
                ).bind(now(), detail, runId),
            ]);
    } finally {
        clearTimeout(hardStop);
        try {
            await releaseLock(env, 'monitor', owner);
        } finally {
            ctx.waitUntil(cleanup(env).catch((error) => console.warn(`cleanup failed: ${error}`)));
        }
    }
}

export async function cleanup(env: Env, timestampMs: number = Date.now()): Promise<void> {
    // The rollup targets the previous (closed) hour, whose checks have all landed, so re-running
    // it within the same hour is idempotent. Only write it once per hour instead of every cycle.
    const hour = new Date(timestampMs - 60 * 60_000).toISOString().slice(0, 13);
    if (hour !== lastRolledHour) {
        await env.DB.prepare(
            `INSERT OR REPLACE INTO hourly_model_rollups(model_id,hour_at,sample_count,success_count,avg_latency_ms,p50_latency_ms,p95_latency_ms)
    SELECT model_id, ?, COUNT(*), SUM(CASE WHEN classification='SUCCESS' THEN 1 ELSE 0 END), AVG(total_duration_ms), NULL, NULL
    FROM checks WHERE checked_at >= ? AND checked_at < ? GROUP BY model_id`,
        )
            .bind(
                `${hour}:00:00.000Z`,
                `${hour}:00:00.000Z`,
                new Date(timestampMs).toISOString().slice(0, 13) + ':00:00.000Z',
            )
            .run();
        lastRolledHour = hour;
    }
    // Retention deletes are idempotent; run them once per UTC day instead of every cron cycle.
    const today = new Date(timestampMs).toISOString().slice(0, 10);
    if (today !== lastCleanupDay) {
        const threshold = new Date(timestampMs - 90 * 24 * 60 * 60_000).toISOString();
        await env.DB.prepare('DELETE FROM checks WHERE checked_at < ?').bind(threshold).run();
        await env.DB.prepare(
            `DELETE FROM model_check_executions WHERE scheduled_at < ?
             AND NOT EXISTS (SELECT 1 FROM checks WHERE checks.execution_id=model_check_executions.id)`,
        )
            .bind(threshold)
            .run();
        const rollupThreshold = new Date(timestampMs - 730 * 24 * 60 * 60_000).toISOString();
        await env.DB.prepare('DELETE FROM hourly_model_rollups WHERE hour_at < ?')
            .bind(rollupThreshold)
            .run();
        lastCleanupDay = today;
    }
}

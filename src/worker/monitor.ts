import { OllamaHttpError, OllamaProvider, PROBE_TIMEOUT_MS } from './ollama';
import { entitlementFromFreeProbe, shouldProbePaid } from './entitlement';
import { maxResponseTokens } from './probe-config';
import { CRON_INTERVAL_MS, eligibilityCutoff, nextCheckAt, trimmedMean } from './status';
import type { Classification, Env, Model, ProbeResult, Provider } from './types';
import { id, now } from './types';

const providerSeeds = [
    { id: 'ollama-free', name: 'Ollama Cloud Free', secret: 'OLLAMA_API_KEY_FREE' },
    { id: 'ollama-paid', name: 'Ollama Cloud Paid', secret: 'OLLAMA_API_KEY_PAID' },
] as const;

// The whole active catalog (34 models today) must fit in one run, or models get starved
// past their cadence and drift to "checked N minutes ago". Kept above catalog size with
// room to grow.
const MAX_MODELS_PER_RUN = 40;
const PROBE_CONCURRENCY_DEFAULT = 1;
const PROBE_CONCURRENCY_MAX = 16;
const PROBE_DELAY_MIN_MS_DEFAULT = 0;
const PROBE_DELAY_MAX_MS_DEFAULT = 5_000;
const LOCK_LEASE_MS = 6 * 60_000;

// Process-local guards that skip idempotent D1 writes repeated every cron tick. They reset if
// the Worker isolate is evicted, in which case the guarded write runs once more (still
// idempotent). Trades negligible staleness for a large write-budget reduction on the free plan.
let providersSeeded = false;
let lastRolledHour: string | null = null;
let lastCleanupDay: string | null = null;

// Probes run in parallel batches so one slow or timing-out model can't stagger the rest of
// the run across minutes. Concurrency is configurable via PROBE_CONCURRENCY: free API keys
// allow only 1 in-flight model, so the default stays at 1 to avoid per-model 429s; paid keys
// can raise it (~3-10) to finish runs faster. The inter-probe delay (PROBE_DELAY_MIN_MS ..
// PROBE_DELAY_MAX_MS) spreads requests over time instead of bursting them all at once.
export function probeConcurrency(env: Env): number {
    const parsed = Number.parseInt(env.PROBE_CONCURRENCY ?? '', 10);
    if (!Number.isFinite(parsed) || parsed < 1) return PROBE_CONCURRENCY_DEFAULT;
    return Math.min(parsed, PROBE_CONCURRENCY_MAX);
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

async function syncCatalog(env: Env, provider: Provider): Promise<number | null> {
    const client = new OllamaProvider(
        provider,
        keyFor(env, provider.secret_ref),
        maxResponseTokens(env.OLLAMA_MAX_TOKENS),
    );
    try {
        const catalog = await client.tags();
        const timestamp = now();
        for (const remote of catalog.models) {
            // Reuse the former free-account ID during the one-time schema transition.
            // It is now the global model identity and preserves all compatible history.
            const remoteDigest = remote.digest ?? null;
            const existing = await env.DB.prepare(
                'SELECT id,last_show_at,digest,active FROM models WHERE provider_id=? AND remote_name=?',
            )
                .bind('ollama-free', remote.name)
                .first<{
                    id: string;
                    last_show_at: string | null;
                    digest: string | null;
                    active: number;
                }>();
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
                    const details = await client.show(remote.name);
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
): Promise<void> {
    const timestamp = now();
    const tier = nextCheckTier(provider, model, result);
    await env.DB.batch([
        env.DB.prepare(
            'INSERT INTO checks(id,provider_id,model_id,checked_at,classification,public_status,http_status,total_duration_ms,rtt_ms,load_duration_ms,error_code) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        ).bind(
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
        ),
        env.DB.prepare('UPDATE models SET next_check_at=?,updated_at=? WHERE id=?').bind(
            nextCheckAt(
                result.publicStatus,
                result.publicStatus === 'OUTAGE',
                result.retryAfterSeconds,
                tier,
            ),
            timestamp,
            model.id,
        ),
    ]);
    await materializeStatus(env, provider, model, result, timestamp);
}

export async function materializeStatus(
    env: Env,
    provider: Provider,
    model: Model,
    result: ProbeResult,
    timestamp: string,
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
        await env.INCIDENT_EVENTS.send({
            incidentId,
            eventType: 'opened',
            summary: `${model.remote_name} is ${status.toLowerCase()}`,
            occurredAt: timestamp,
        });
        await requestExternalConfirmation(env, incidentId);
    } else if (status === 'OPERATIONAL' && active && successes >= 2) {
        await env.DB.batch([
            env.DB.prepare(
                "UPDATE incidents SET status='RESOLVED',resolved_at=?,last_classification=? WHERE id=?",
            ).bind(timestamp, result.classification, active.id),
            env.DB.prepare(
                'UPDATE provider_model_status SET incident_id=NULL WHERE provider_id=? AND model_id=?',
            ).bind(provider.id, model.id),
        ]);
        await env.INCIDENT_EVENTS.send({
            incidentId: active.id,
            eventType: 'resolved',
            summary: `${model.remote_name} recovered`,
            occurredAt: timestamp,
        });
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
    const response = await fetch(
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
                ref: 'main',
                inputs: { endpoint: env.CONFIRMATION_CALLBACK_URL, nonce, incident_id: incidentId },
            }),
        },
    );
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

async function probeModel(env: Env, provider: Provider, model: Model): Promise<ProbeResult> {
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
    );
    if (provider.id === 'ollama-free' && result.classification === 'MODEL_NOT_FOUND')
        await env.DB.prepare(
            "UPDATE models SET excluded=1,exclusion_reason='unavailable after catalog' WHERE id=?",
        )
            .bind(model.id)
            .run();
    await storeProbe(env, provider, model, result);
    return result;
}

function failedProbe(result: ProbeResult): number {
    return isFailure(result.classification) ? 1 : 0;
}

async function recordModelProgress(
    env: Env,
    runId: string,
    model: Model,
    progress: { free: number; paid: number; paidSkipped: number; failed: number },
): Promise<void> {
    await env.DB.prepare(
        `UPDATE monitor_runs SET completed_model_count=completed_model_count+1,
    free_probe_count=free_probe_count+?, paid_probe_count=paid_probe_count+?,
    paid_skipped_count=paid_skipped_count+?, failed_probe_count=failed_probe_count+?, current_model=?
    WHERE id=?`,
    )
        .bind(
            progress.free,
            progress.paid,
            progress.paidSkipped,
            progress.failed,
            model.remote_name,
            runId,
        )
        .run();
}

async function probeByEntitlement(
    env: Env,
    freeProvider: Provider,
    paidProvider: Provider | undefined,
    model: Model,
    runId: string,
): Promise<void> {
    // Per-model live progress is recorded once at the end by recordModelProgress, which already
    // sets current_model. The run-level phase is already 'CHECKING' from runMonitor, so a second
    // per-model write here only refreshed current_model a few seconds earlier at the cost of one
    // write per model per cycle.
    const freeResult = await probeModel(env, freeProvider, model);
    const entitlement = entitlementFromFreeProbe(freeResult.classification);
    const paidAvailable = Boolean(paidProvider && hasKey(env, paidProvider));
    let paid = 0,
        paidSkipped = 0,
        failed = failedProbe(freeResult);

    if (shouldProbePaid(freeResult.classification, paidAvailable) && paidProvider) {
        const paidResult = await probeModel(env, paidProvider, model);
        paid = 1;
        failed += failedProbe(paidResult);
    } else if (entitlement === 'PAID') {
        paidSkipped = 1;
    }
    await recordModelProgress(env, runId, model, { free: 1, paid, paidSkipped, failed });
}

export async function runMonitor(env: Env, ctx: ExecutionContext): Promise<void> {
    const owner = crypto.randomUUID();
    if (!(await acquireLock(env, 'monitor', owner))) return;
    const runId = id('run'),
        started = now();
    let runCreated = false;
    try {
        // A lock owner must always have a visible run, including initialization failures.
        await env.DB.prepare(
            "UPDATE monitor_runs SET finished_at=?,outcome='ERROR',phase='ABANDONED',detail='interrupted',current_model=NULL WHERE finished_at IS NULL",
        )
            .bind(started)
            .run();
        await env.DB.prepare("INSERT INTO monitor_runs(id,started_at,phase) VALUES (?,?,'CATALOG')")
            .bind(runId, started)
            .run();
        runCreated = true;
        await ensureProviders(env);
        const activeProviders = await providers(env);
        const freeProvider = activeProviders.find((provider) => provider.id === 'ollama-free');
        const paidProvider = activeProviders.find((provider) => provider.id === 'ollama-paid');
        if (!freeProvider) throw new Error('global_catalog_unavailable');
        const catalogModelCount = await syncCatalog(env, freeProvider);
        if (catalogModelCount === null) throw new Error('global_catalog_unavailable');
        const due = await env.DB.prepare(
            `SELECT id,provider_id,remote_name,digest,last_show_at,tier FROM models WHERE provider_id='ollama-free' AND active=1 AND excluded=0 AND (next_check_at IS NULL OR next_check_at <= ?) ORDER BY next_check_at LIMIT ${MAX_MODELS_PER_RUN}`,
        )
            .bind(eligibilityCutoff(Date.now()))
            .all<Model>();
        await env.DB.prepare(
            "UPDATE monitor_runs SET phase='CHECKING',catalog_model_count=?,scheduled_model_count=? WHERE id=?",
        )
            .bind(catalogModelCount, due.results.length, runId)
            .run();
        const concurrency = probeConcurrency(env);
        // Time-box the run so it finishes within one cron interval: stop starting new batches
        // once the deadline is reached, leaving the lock free for the next tick. Models not
        // probed stay due and are picked up first next tick (the due query orders by
        // next_check_at). Without this, a slow/long run holds the lock past the next tick and
        // that tick is silently skipped, doubling the effective cadence to ~10 min.
        const deadlineMs = runDeadlineMs(Date.parse(started), env);
        let budgetExceeded = false;
        for (let i = 0; i < due.results.length; i += concurrency) {
            if (Date.now() >= deadlineMs) {
                budgetExceeded = true;
                break;
            }
            if (!(await renewLock(env, 'monitor', owner))) throw new Error('monitor_lock_lost');
            await Promise.all(
                due.results
                    .slice(i, i + concurrency)
                    .map((model) =>
                        probeByEntitlement(env, freeProvider, paidProvider, model, runId),
                    ),
            );
        }
        if (budgetExceeded) {
            // Surface the infeasibility explicitly instead of silently drifting cadence: the
            // run completed without error but couldn't probe every due model within the budget.
            console.warn(
                `monitor run ${runId} budget_exceeded: ${due.results.length} due, deadline reached`,
            );
        }
        await env.DB.prepare(
            "UPDATE monitor_runs SET finished_at=?,outcome=?,phase='COMPLETED',detail=?,current_model=NULL WHERE id=?",
        )
            .bind(
                now(),
                budgetExceeded ? 'PARTIAL' : 'OK',
                budgetExceeded ? `budget_exceeded:${due.results.length}` : null,
                runId,
            )
            .run();
    } catch (error) {
        const detail =
            error instanceof Error && error.message === 'global_catalog_unavailable'
                ? 'catalog_unavailable'
                : 'monitor_failed';
        if (runCreated)
            await env.DB.prepare(
                "UPDATE monitor_runs SET finished_at=?,outcome='ERROR',phase='FAILED',detail=?,current_model=NULL WHERE id=?",
            )
                .bind(now(), detail, runId)
                .run();
    } finally {
        try {
            await releaseLock(env, 'monitor', owner);
        } finally {
            ctx.waitUntil(cleanup(env));
        }
    }
}

async function cleanup(env: Env): Promise<void> {
    // The rollup targets the previous (closed) hour, whose checks have all landed, so re-running
    // it within the same hour is idempotent. Only write it once per hour instead of every cycle.
    const hour = new Date(Date.now() - 60 * 60_000).toISOString().slice(0, 13);
    if (hour !== lastRolledHour) {
        await env.DB.prepare(
            `INSERT OR REPLACE INTO hourly_model_rollups(model_id,hour_at,sample_count,success_count,avg_latency_ms,p50_latency_ms,p95_latency_ms)
    SELECT model_id, ?, COUNT(*), SUM(CASE WHEN classification='SUCCESS' THEN 1 ELSE 0 END), AVG(total_duration_ms), NULL, NULL
    FROM checks WHERE checked_at >= ? AND checked_at < ? GROUP BY model_id`,
        )
            .bind(
                `${hour}:00:00.000Z`,
                `${hour}:00:00.000Z`,
                new Date().toISOString().slice(0, 13) + ':00:00.000Z',
            )
            .run();
        lastRolledHour = hour;
    }
    // Retention deletes are idempotent; run them once per UTC day instead of every 5-minute cycle.
    const today = new Date().toISOString().slice(0, 10);
    if (today !== lastCleanupDay) {
        const threshold = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();
        await env.DB.prepare('DELETE FROM checks WHERE checked_at < ?').bind(threshold).run();
        const rollupThreshold = new Date(Date.now() - 730 * 24 * 60 * 60_000).toISOString();
        await env.DB.prepare('DELETE FROM hourly_model_rollups WHERE hour_at < ?')
            .bind(rollupThreshold)
            .run();
        lastCleanupDay = today;
    }
}

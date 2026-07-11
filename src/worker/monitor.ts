import { OllamaHttpError, OllamaProvider } from './ollama'
import { entitlementFromFreeProbe, shouldProbePaid } from './entitlement'
import { maxResponseTokens } from './probe-config'
import { nextCheckAt, trimmedMean } from './status'
import type { Classification, Env, Model, ProbeResult, Provider } from './types'
import { id, now } from './types'

const providerSeeds = [
  { id: 'ollama-free', name: 'Ollama Cloud Free', secret: 'OLLAMA_API_KEY_FREE' },
  { id: 'ollama-paid', name: 'Ollama Cloud Paid', secret: 'OLLAMA_API_KEY_PAID' },
] as const

function keyFor(env: Env, ref: Provider['secret_ref']) { return env[ref] ?? '' }
function hasKey(env: Env, provider: Provider) { return keyFor(env, provider.secret_ref).trim().length > 0 }
function excluded(env: Env, model: string) { return (env.EXCLUDED_MODELS ?? '').split(',').map(x => x.trim()).filter(Boolean).includes(model) }
function isFailure(c: Classification) { return !['SUCCESS', 'HIGH_LATENCY', 'SUBSCRIPTION_REQUIRED'].includes(c) }
export function nextCheckTier(provider: Provider, model: Model, result: ProbeResult): 'FREE' | 'PAID' | 'UNKNOWN' {
  if (provider.id === 'ollama-paid') return 'PAID'
  if (provider.id === 'ollama-free') {
    if (result.classification === 'SUBSCRIPTION_REQUIRED') return 'PAID'
    if (result.classification === 'SUCCESS' || result.classification === 'HIGH_LATENCY') return 'FREE'
  }
  return model.tier ?? 'UNKNOWN'
}

export async function ensureProviders(env: Env): Promise<void> {
  const timestamp = now()
  for (const seed of providerSeeds) await env.DB.prepare(
    'INSERT OR IGNORE INTO providers (id,name,kind,base_url,secret_ref,created_at) VALUES (?,?,\'ollama\',?,?,?)',
  ).bind(seed.id, seed.name, env.OLLAMA_BASE_URL, seed.secret, timestamp).run()
}

export async function acquireLock(env: Env, name: string, owner: string): Promise<boolean> {
  const timestamp = now(), lease = new Date(Date.now() + 4 * 60_000).toISOString()
  const result = await env.DB.prepare(`INSERT INTO scheduler_locks(name, lease_until, owner, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET lease_until=excluded.lease_until, owner=excluded.owner, updated_at=excluded.updated_at
    WHERE scheduler_locks.lease_until < excluded.updated_at`).bind(name, lease, owner, timestamp).run()
  return result.meta.changes === 1
}

async function releaseLock(env: Env, name: string, owner: string): Promise<void> {
  await env.DB.prepare('DELETE FROM scheduler_locks WHERE name=? AND owner=?').bind(name, owner).run()
}

async function providers(env: Env): Promise<Provider[]> {
  const result = await env.DB.prepare('SELECT id,name,base_url,secret_ref FROM providers WHERE active=1').all<Provider>()
  return result.results.map(p => ({ ...p, secret_ref: p.secret_ref as Provider['secret_ref'] }))
}

async function syncCatalog(env: Env, provider: Provider): Promise<number | null> {
  const client = new OllamaProvider(provider, keyFor(env, provider.secret_ref), maxResponseTokens(env.OLLAMA_MAX_TOKENS))
  try {
    const catalog = await client.tags()
    const timestamp = now()
    for (const remote of catalog.models) {
      // Reuse the former free-account ID during the one-time schema transition.
      // It is now the global model identity and preserves all compatible history.
      const existing = await env.DB.prepare('SELECT id,last_show_at,digest FROM models WHERE provider_id=? AND remote_name=?').bind('ollama-free', remote.name).first<Model>()
      const modelId = existing?.id ?? `ollama:${remote.name}`
      await env.DB.prepare(`INSERT INTO models(id,provider_id,remote_name,active,excluded,digest,next_check_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest, active=1, updated_at=excluded.updated_at`).bind(
        modelId, provider.id, remote.name, 1, excluded(env, remote.name) ? 1 : 0, remote.digest ?? null, timestamp, timestamp, timestamp,
      ).run()
      if (!existing?.last_show_at || existing.digest !== remote.digest || Date.now() - new Date(existing.last_show_at).getTime() >= 24 * 60 * 60_000) {
        try {
          const details = await client.show(remote.name)
          await env.DB.prepare('UPDATE models SET details_json=?,last_show_at=? WHERE id=?').bind(JSON.stringify(details), timestamp, modelId).run()
        } catch { /* show metadata is diagnostic only; catalog remains valid */ }
      }
    }
    await env.DB.prepare("UPDATE providers SET catalog_status='OK',catalog_checked_at=? WHERE id=?").bind(timestamp, provider.id).run()
    return catalog.models.length
  } catch (error) {
    const code = error instanceof OllamaHttpError ? `HTTP_${error.status}` : error instanceof TypeError ? 'NETWORK' : 'CATALOG_ERROR'
    await env.DB.prepare('UPDATE providers SET catalog_status=?,catalog_checked_at=? WHERE id=?').bind(code, now(), provider.id).run()
    return null
  }
}

async function baseline(env: Env, providerId: string, modelId: string): Promise<number | undefined> {
  const result = await env.DB.prepare("SELECT total_duration_ms FROM checks WHERE provider_id=? AND model_id=? AND classification='SUCCESS' AND total_duration_ms IS NOT NULL ORDER BY checked_at DESC LIMIT 20").bind(providerId, modelId).all<{ total_duration_ms: number }>()
  return trimmedMean(result.results.map(x => x.total_duration_ms))
}

async function storeProbe(env: Env, provider: Provider, model: Model, result: ProbeResult): Promise<void> {
  const timestamp = now()
  const tier = nextCheckTier(provider, model, result)
  await env.DB.batch([
    env.DB.prepare('INSERT INTO checks(id,provider_id,model_id,checked_at,classification,public_status,http_status,total_duration_ms,rtt_ms,load_duration_ms,error_code) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(
      id('chk'), provider.id, model.id, timestamp, result.classification, result.publicStatus, result.httpStatus ?? null, result.totalDurationMs ?? null, result.rttMs, result.loadDurationMs ?? null, result.errorCode ?? null,
    ),
    env.DB.prepare('UPDATE models SET next_check_at=?,updated_at=? WHERE id=?').bind(nextCheckAt(result.publicStatus, result.publicStatus === 'OUTAGE', undefined, tier), timestamp, model.id),
  ])
  await materializeStatus(env, provider, model, result, timestamp)
}

async function materializeStatus(env: Env, provider: Provider, model: Model, result: ProbeResult, timestamp: string): Promise<void> {
  const prior = await env.DB.prepare('SELECT * FROM provider_model_status WHERE provider_id=? AND model_id=?').bind(provider.id, model.id).first<{ public_status: string; consecutive_successes: number; consecutive_failures: number; consecutive_high_latency: number; incident_id: string | null }>()
  const success = result.classification === 'SUCCESS'
  const high = result.classification === 'HIGH_LATENCY'
  const active = prior?.incident_id ? await env.DB.prepare("SELECT id,status FROM incidents WHERE id=? AND status='OPEN'").bind(prior.incident_id).first<{ id: string }>() : null
  const failures = isFailure(result.classification) ? (prior?.consecutive_failures ?? 0) + 1 : 0
  const successes = success ? (prior?.consecutive_successes ?? 0) + 1 : 0
  const highLatency = high ? (prior?.consecutive_high_latency ?? 0) + 1 : 0
  let status = prior?.public_status ?? 'UNKNOWN'
  if (result.classification === 'SUBSCRIPTION_REQUIRED') status = 'PLAN_REQUIRED'
  else if (failures >= 2 || await fiveCheckFailures(env, provider.id, model.id) >= 3) status = result.publicStatus
  else if (highLatency >= 2) status = 'DEGRADED'
  else if (successes >= 2 || (success && !active)) status = 'OPERATIONAL'

  await env.DB.prepare(`INSERT INTO provider_model_status(provider_id,model_id,public_status,classification,consecutive_successes,consecutive_failures,consecutive_high_latency,last_check_at,last_latency_ms,incident_id,next_check_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider_id,model_id) DO UPDATE SET public_status=excluded.public_status,classification=excluded.classification,consecutive_successes=excluded.consecutive_successes,consecutive_failures=excluded.consecutive_failures,consecutive_high_latency=excluded.consecutive_high_latency,last_check_at=excluded.last_check_at,last_latency_ms=excluded.last_latency_ms,incident_id=excluded.incident_id,next_check_at=excluded.next_check_at,updated_at=excluded.updated_at`).bind(
    provider.id, model.id, status, result.classification, successes, failures, highLatency, timestamp, result.totalDurationMs ?? null, prior?.incident_id ?? null, nextCheckAt(result.publicStatus, result.publicStatus === 'OUTAGE', undefined, nextCheckTier(provider, model, result)), timestamp,
  ).run()
  if (provider.id === 'ollama-free') {
    const tier = result.classification === 'SUBSCRIPTION_REQUIRED' ? 'PAID' : ['SUCCESS', 'HIGH_LATENCY'].includes(result.classification) ? 'FREE' : null
    if (tier) await env.DB.prepare('UPDATE models SET tier=?,updated_at=? WHERE id=?').bind(tier, timestamp, model.id).run()
  }
  if (status !== 'OPERATIONAL' && !active && (failures >= 2 || highLatency >= 2)) {
    const incidentId = id('inc')
    await env.DB.batch([
      env.DB.prepare('INSERT INTO incidents(id,provider_id,model_id,kind,started_at,summary,last_classification) VALUES (?,?,?,?,?,?,?)').bind(incidentId, provider.id, model.id, status, timestamp, `${model.remote_name} is ${status.toLowerCase()} for ${provider.name}`, result.classification),
      env.DB.prepare('UPDATE provider_model_status SET incident_id=? WHERE provider_id=? AND model_id=?').bind(incidentId, provider.id, model.id),
    ])
    await env.INCIDENT_EVENTS.send({ incidentId, eventType: 'opened', summary: `${model.remote_name} is ${status.toLowerCase()}`, occurredAt: timestamp })
    await requestExternalConfirmation(env, incidentId)
  } else if (status === 'OPERATIONAL' && active && successes >= 2) {
    await env.DB.batch([
      env.DB.prepare("UPDATE incidents SET status='RESOLVED',resolved_at=?,last_classification=? WHERE id=?").bind(timestamp, result.classification, active.id),
      env.DB.prepare('UPDATE provider_model_status SET incident_id=NULL WHERE provider_id=? AND model_id=?').bind(provider.id, model.id),
    ])
    await env.INCIDENT_EVENTS.send({ incidentId: active.id, eventType: 'resolved', summary: `${model.remote_name} recovered`, occurredAt: timestamp })
  }
}

async function requestExternalConfirmation(env: Env, incidentId: string): Promise<void> {
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_ACTIONS_TOKEN || !env.CONFIRMATION_CALLBACK_URL) return
  const nonce = crypto.randomUUID(), expiresAt = new Date(Date.now() + 30 * 60_000).toISOString()
  await env.DB.prepare('INSERT INTO region_confirmations(id,incident_id,nonce,expires_at) VALUES (?,?,?,?)').bind(id('confirm'), incidentId, nonce, expiresAt).run()
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/external-confirmation.yml/dispatches`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`, Accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'ollama-status-monitor' },
    body: JSON.stringify({ ref: 'main', inputs: { endpoint: env.CONFIRMATION_CALLBACK_URL, nonce, incident_id: incidentId } }),
  })
  if (!response.ok) throw new Error('confirmation_dispatch_failed')
  await env.DB.prepare('UPDATE incidents SET external_confirmation_requested_at=? WHERE id=?').bind(now(), incidentId).run()
}

async function fiveCheckFailures(env: Env, providerId: string, modelId: string): Promise<number> {
  const result = await env.DB.prepare('SELECT classification FROM checks WHERE provider_id=? AND model_id=? ORDER BY checked_at DESC LIMIT 5').bind(providerId, modelId).all<{ classification: Classification }>()
  return result.results.filter(x => isFailure(x.classification)).length
}

async function probeModel(env: Env, provider: Provider, model: Model): Promise<ProbeResult> {
  // Small jitter avoids synchronized bursts without making a scheduled run take minutes.
  await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 1_500)))
  const client = new OllamaProvider(provider, keyFor(env, provider.secret_ref), maxResponseTokens(env.OLLAMA_MAX_TOKENS))
  let result = await client.probe(model.remote_name, await baseline(env, provider.id, model.id))
  if (['TIMEOUT', 'NETWORK_ERROR', 'MODEL_UNREACHABLE', 'OVERLOADED'].includes(result.classification)) {
    await new Promise(resolve => setTimeout(resolve, 20_000))
    result = await client.probe(model.remote_name, await baseline(env, provider.id, model.id))
  }
  if (provider.id === 'ollama-free' && result.classification === 'MODEL_NOT_FOUND') await env.DB.prepare("UPDATE models SET excluded=1,exclusion_reason='unavailable after catalog' WHERE id=?").bind(model.id).run()
  await storeProbe(env, provider, model, result)
  return result
}

function failedProbe(result: ProbeResult): number { return isFailure(result.classification) ? 1 : 0 }

async function recordModelProgress(env: Env, runId: string, model: Model, progress: { free: number; paid: number; paidSkipped: number; failed: number }): Promise<void> {
  await env.DB.prepare(`UPDATE monitor_runs SET completed_model_count=completed_model_count+1,
    free_probe_count=free_probe_count+?, paid_probe_count=paid_probe_count+?,
    paid_skipped_count=paid_skipped_count+?, failed_probe_count=failed_probe_count+?, current_model=?
    WHERE id=?`).bind(progress.free, progress.paid, progress.paidSkipped, progress.failed, model.remote_name, runId).run()
}

async function probeByEntitlement(env: Env, freeProvider: Provider, paidProvider: Provider | undefined, model: Model, runId: string): Promise<void> {
  await env.DB.prepare("UPDATE monitor_runs SET phase='CHECKING',current_model=? WHERE id=?").bind(model.remote_name, runId).run()
  const freeResult = await probeModel(env, freeProvider, model)
  const entitlement = entitlementFromFreeProbe(freeResult.classification)
  const paidAvailable = Boolean(paidProvider && hasKey(env, paidProvider))
  let paid = 0, paidSkipped = 0, failed = failedProbe(freeResult)

  if (shouldProbePaid(freeResult.classification, paidAvailable) && paidProvider) {
    const paidResult = await probeModel(env, paidProvider, model)
    paid = 1
    failed += failedProbe(paidResult)
  } else if (entitlement === 'PAID') {
    paidSkipped = 1
  }
  await recordModelProgress(env, runId, model, { free: 1, paid, paidSkipped, failed })
}

export async function runMonitor(env: Env, ctx: ExecutionContext): Promise<void> {
  const owner = crypto.randomUUID()
  if (!await acquireLock(env, 'monitor', owner)) return
  const runId = id('run'), started = now()
  // A lock owner must always have a visible run, including initialization failures.
  await env.DB.prepare("UPDATE monitor_runs SET finished_at=?,outcome='ERROR',phase='ABANDONED',detail='interrupted',current_model=NULL WHERE finished_at IS NULL").bind(started).run()
  await env.DB.prepare("INSERT INTO monitor_runs(id,started_at,phase) VALUES (?,?,'CATALOG')").bind(runId, started).run()
  try {
    await ensureProviders(env)
    const activeProviders = await providers(env)
    const freeProvider = activeProviders.find(provider => provider.id === 'ollama-free')
    const paidProvider = activeProviders.find(provider => provider.id === 'ollama-paid')
    if (!freeProvider) throw new Error('global_catalog_unavailable')
    const catalogModelCount = await syncCatalog(env, freeProvider)
    if (catalogModelCount === null) throw new Error('global_catalog_unavailable')
    const due = await env.DB.prepare("SELECT id,provider_id,remote_name,digest,last_show_at,tier FROM models WHERE provider_id='ollama-free' AND active=1 AND excluded=0 AND (next_check_at IS NULL OR next_check_at <= ?) ORDER BY next_check_at LIMIT 24").bind(now()).all<Model>()
    await env.DB.prepare("UPDATE monitor_runs SET phase='CHECKING',catalog_model_count=?,scheduled_model_count=? WHERE id=?").bind(catalogModelCount, due.results.length, runId).run()
    for (let i = 0; i < due.results.length; i += 2) {
      await Promise.all(due.results.slice(i, i + 2).map(model => probeByEntitlement(env, freeProvider, paidProvider, model, runId)))
    }
    await env.DB.prepare("UPDATE monitor_runs SET finished_at=?,outcome='OK',phase='COMPLETED',current_model=NULL WHERE id=?").bind(now(), runId).run()
  } catch (error) {
    const detail = error instanceof Error && error.message === 'global_catalog_unavailable' ? 'catalog_unavailable' : 'monitor_failed'
    await env.DB.prepare("UPDATE monitor_runs SET finished_at=?,outcome='ERROR',phase='FAILED',detail=?,current_model=NULL WHERE id=?").bind(now(), detail, runId).run()
  }
  await releaseLock(env, 'monitor', owner)
  ctx.waitUntil(cleanup(env))
}

async function cleanup(env: Env): Promise<void> {
  const hour = new Date(Date.now() - 60 * 60_000).toISOString().slice(0, 13)
  await env.DB.prepare(`INSERT OR REPLACE INTO hourly_model_rollups(model_id,hour_at,sample_count,success_count,avg_latency_ms,p50_latency_ms,p95_latency_ms)
    SELECT model_id, ?, COUNT(*), SUM(CASE WHEN classification='SUCCESS' THEN 1 ELSE 0 END), AVG(total_duration_ms), NULL, NULL
    FROM checks WHERE checked_at >= ? AND checked_at < ? GROUP BY model_id`).bind(`${hour}:00:00.000Z`, `${hour}:00:00.000Z`, new Date().toISOString().slice(0, 13) + ':00:00.000Z').run()
  const threshold = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString()
  await env.DB.prepare('DELETE FROM checks WHERE checked_at < ?').bind(threshold).run()
  const rollupThreshold = new Date(Date.now() - 730 * 24 * 60 * 60_000).toISOString()
  await env.DB.prepare('DELETE FROM hourly_model_rollups WHERE hour_at < ?').bind(rollupThreshold).run()
}

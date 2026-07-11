import { describe, expect, it } from 'vitest'
import { checkIntervalMinutes, classifyHttp, isLatencyAnomalous, nextCheckAt, publicStatusFor, trimmedMean } from '../src/worker/status'
import { entitlementFromFreeProbe, shouldProbePaid } from '../src/worker/entitlement'
import { maxResponseTokens } from '../src/worker/probe-config'
import { OllamaProvider } from '../src/worker/ollama'
import { effectiveProvider, historyBuckets, lastSuccessfulFinishedAt, nextUpdatesForModels, worstStatus } from '../src/worker/api'
import { nextCheckTier } from '../src/worker/monitor'
import { nextUpdateLabel, roundUpToMonitorInterval } from '../src/web/next-update'

describe('Ollama status classification', () => {
  it('generates UTC hourly buckets and leaves periods without checks unknown', () => {
    const reference = new Date('2026-07-10T13:34:00.000Z')
    const buckets = historyBuckets([
      { provider_id: 'ollama-free', model_id: 'm1', checked_at: '2026-07-10T13:15:00.000Z', public_status: 'OPERATIONAL', classification: 'SUCCESS', total_duration_ms: 25, rtt_ms: 30 },
    ], '24h', reference)

    expect(buckets).toHaveLength(24)
    expect(buckets[0]).toMatchObject({ startAt: '2026-07-09T14:00:00.000Z', status: 'UNKNOWN', checks: 0 })
    expect(buckets.at(-1)).toMatchObject({ startAt: '2026-07-10T13:00:00.000Z', status: 'OPERATIONAL', checks: 1, averageLatencyMs: 25, latencySamples: 1 })
  })

  it('generates seven and thirty UTC daily buckets', () => {
    const reference = new Date('2026-07-10T13:34:00.000Z')
    expect(historyBuckets([], '7d', reference)).toHaveLength(7)
    expect(historyBuckets([], '7d', reference)[0].startAt).toBe('2026-07-04T00:00:00.000Z')
    expect(historyBuckets([], '30d', reference)).toHaveLength(30)
    expect(historyBuckets([], '30d', reference)[0].startAt).toBe('2026-06-11T00:00:00.000Z')
  })

  it('uses the worst observed status within each history bucket', () => {
    expect(worstStatus(['OPERATIONAL', 'DEGRADED', 'RATE_LIMITED'])).toBe('RATE_LIMITED')
    expect(worstStatus(['PLAN_REQUIRED', 'AUTHENTICATION', 'OPERATIONAL'])).toBe('AUTHENTICATION')
    const buckets = historyBuckets([
      { provider_id: 'ollama-free', model_id: 'm1', checked_at: '2026-07-10T13:10:00.000Z', public_status: 'OPERATIONAL', classification: 'SUCCESS', total_duration_ms: null, rtt_ms: 30 },
      { provider_id: 'ollama-free', model_id: 'm1', checked_at: '2026-07-10T13:20:00.000Z', public_status: 'OUTAGE', classification: 'TIMEOUT', total_duration_ms: null, rtt_ms: 30 },
    ], '24h', new Date('2026-07-10T13:34:00.000Z'))
    expect(buckets.at(-1)).toMatchObject({ status: 'OUTAGE', checks: 2 })
  })

  it('uses RTT for the bucket average only when total duration is unavailable', () => {
    const buckets = historyBuckets([
      { provider_id: 'ollama-free', model_id: 'm1', checked_at: '2026-07-10T13:10:00.000Z', public_status: 'OPERATIONAL', classification: 'SUCCESS', total_duration_ms: null, rtt_ms: 20 },
      { provider_id: 'ollama-free', model_id: 'm1', checked_at: '2026-07-10T13:20:00.000Z', public_status: 'OPERATIONAL', classification: 'SUCCESS', total_duration_ms: null, rtt_ms: 40 },
    ], '24h', new Date('2026-07-10T13:34:00.000Z'))
    expect(buckets.at(-1)).toMatchObject({ averageLatencyMs: 30, latencySamples: 2 })
  })

  it('prefers paid results for paid models and otherwise retains the free subscription status', () => {
    const freeOnly = [{ provider_id: 'ollama-free', model_id: 'm1', public_status: 'PLAN_REQUIRED', classification: 'SUBSCRIPTION_REQUIRED', last_check_at: null, last_latency_ms: null }]
    const withPaid = [...freeOnly, { provider_id: 'ollama-paid', model_id: 'm1', public_status: 'OPERATIONAL', classification: 'SUCCESS', last_check_at: null, last_latency_ms: null }]
    expect(effectiveProvider('FREE', 'm1', withPaid)).toBe('ollama-free')
    expect(effectiveProvider('PAID', 'm1', freeOnly)).toBe('ollama-free')
    expect(effectiveProvider('PAID', 'm1', withPaid)).toBe('ollama-paid')
  })

  it('uses the most recent completed successful monitor run as the data update time', () => {
    expect(lastSuccessfulFinishedAt([
      { outcome: 'OK', finished_at: '2026-07-10T12:00:00.000Z' },
      { outcome: 'ERROR', finished_at: '2026-07-10T13:00:00.000Z' },
      { outcome: 'OK', finished_at: '2026-07-10T12:30:00.000Z' },
      { outcome: 'OK', finished_at: null },
    ])).toBe('2026-07-10T12:30:00.000Z')
    expect(lastSuccessfulFinishedAt([{ outcome: 'ERROR', finished_at: '2026-07-10T13:00:00.000Z' }])).toBeNull()
  })

  it('finds the earliest scheduled active check for each monitored tier', () => {
    expect(nextUpdatesForModels([
      { tier: 'FREE', next_check_at: '2026-07-10T12:10:00.000Z' },
      { tier: 'FREE', next_check_at: '2026-07-10T12:05:00.000Z' },
      { tier: 'PAID', next_check_at: '2026-07-10T12:15:00.000Z' },
      { tier: 'UNKNOWN', next_check_at: '2026-07-10T12:00:00.000Z' },
      { tier: 'PAID', next_check_at: null },
    ])).toEqual({ free: '2026-07-10T12:05:00.000Z', paid: '2026-07-10T12:15:00.000Z' })
    expect(nextUpdatesForModels([])).toEqual({ free: null, paid: null })
    expect(nextUpdatesForModels([{ tier: 'FREE', next_check_at: null }])).toEqual({ free: null, paid: null })
  })

  it('rounds checks to the next five-minute scheduler boundary and pauses countdowns while updating', () => {
    expect(roundUpToMonitorInterval('2026-07-10T12:01:01.000Z')).toBe(Date.parse('2026-07-10T12:05:00.000Z'))
    expect(nextUpdateLabel('2026-07-10T12:01:01.000Z', false, Date.parse('2026-07-10T12:00:00.000Z'))).toBe('in 5m 0s')
    expect(nextUpdateLabel('2026-07-10T12:01:01.000Z', true, Date.parse('2026-07-10T12:00:00.000Z'))).toBe('Updating…')
    expect(nextUpdateLabel(null, false, Date.parse('2026-07-10T12:00:00.000Z'))).toBe('No checks scheduled')
  })

  it('keeps account failures distinct from model failures', () => {
    expect(classifyHttp(401)).toBe('AUTH_ERROR')
    expect(classifyHttp(429)).toBe('RATE_LIMITED')
    expect(classifyHttp(404)).toBe('MODEL_NOT_FOUND')
    expect(publicStatusFor('AUTH_ERROR')).toBe('AUTHENTICATION')
    expect(publicStatusFor('MODEL_NOT_FOUND')).toBe('MODEL_NOT_FOUND')
    expect(publicStatusFor('SUBSCRIPTION_REQUIRED')).toBe('PLAN_REQUIRED')
  })

  it('uses the documented latency floor and baseline multiplier', () => {
    expect(isLatencyAnomalous(10_001, 1_000)).toBe(true)
    expect(isLatencyAnomalous(8_000, 6_000)).toBe(false)
    expect(isLatencyAnomalous(10_501, 6_000)).toBe(true)
  })

  it('trims outliers only with enough samples', () => {
    expect(trimmedMean([1, 2, 3])).toBe(2)
    expect(trimmedMean([1, 2, 3, 4, 5, 6, 7, 8, 9, 1_000])).toBe(5.5)
  })

  it('backs off authentication and quota failures', () => {
    const now = Date.now()
    expect(new Date(nextCheckAt('AUTHENTICATION', false)).getTime() - now).toBeGreaterThanOrEqual(59 * 60_000)
    expect(new Date(nextCheckAt('RATE_LIMITED', false, 7200)).getTime() - now).toBeGreaterThanOrEqual(119 * 60_000)
  })

  it('checks free models every five minutes and paid models every fifteen', () => {
    expect(checkIntervalMinutes('OPERATIONAL', false, undefined, 'FREE')).toBe(5)
    expect(checkIntervalMinutes('OPERATIONAL', false, undefined, 'PAID')).toBe(15)
    expect(checkIntervalMinutes('DEGRADED', false, undefined, 'PAID')).toBe(5)
  })

  it('keeps the paid cadence after a paid-provider probe', () => {
    const paidProvider = { id: 'ollama-paid', name: 'Paid', base_url: 'https://example.test', secret_ref: 'OLLAMA_API_KEY_PAID' as const }
    const unclassifiedModel = { id: 'm1', provider_id: 'ollama-free', remote_name: 'm1', digest: null, last_show_at: null, tier: 'UNKNOWN' as const }
    const successfulProbe = { classification: 'SUCCESS' as const, publicStatus: 'OPERATIONAL' as const, rttMs: 1 }
    expect(nextCheckTier(paidProvider, unclassifiedModel, successfulProbe)).toBe('PAID')
    expect(checkIntervalMinutes(successfulProbe.publicStatus, false, undefined, nextCheckTier(paidProvider, unclassifiedModel, successfulProbe))).toBe(15)
  })

  it('uses the free probe as the only entitlement decision', () => {
    expect(entitlementFromFreeProbe('SUCCESS')).toBe('FREE')
    expect(entitlementFromFreeProbe('SUBSCRIPTION_REQUIRED')).toBe('PAID')
    expect(entitlementFromFreeProbe('AUTH_ERROR')).toBe('UNKNOWN')
    expect(shouldProbePaid('SUCCESS', true)).toBe(false)
    expect(shouldProbePaid('SUBSCRIPTION_REQUIRED', false)).toBe(false)
    expect(shouldProbePaid('SUBSCRIPTION_REQUIRED', true)).toBe(true)
  })

  it('uses a bounded configured response-token limit', () => {
    expect(maxResponseTokens(undefined)).toBe(8)
    expect(maxResponseTokens('32')).toBe(32)
    expect(maxResponseTokens('0')).toBe(8)
    expect(maxResponseTokens('4097')).toBe(8)
  })

  it('accepts the first content chunk of an Ollama Chat stream', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('{"model":"cloud","message":{"role":"assistant","content":"OK"},"done":false}\n', { status: 200 })
    try {
      const provider = new OllamaProvider({ id: 'ollama-free', name: 'Free', base_url: 'https://example.test/api', secret_ref: 'OLLAMA_API_KEY_FREE' }, 'test-key')
      const result = await provider.probe('cloud')
      expect(result.classification).toBe('SUCCESS')
      expect(result.totalDurationMs).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('classifies a Chat entitlement response before attempting to read its stream', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'this model requires a subscription, upgrade for access' }), { status: 403 })
    try {
      const provider = new OllamaProvider({ id: 'ollama-free', name: 'Free', base_url: 'https://example.test/api', secret_ref: 'OLLAMA_API_KEY_FREE' }, 'test-key')
      expect((await provider.probe('paid-model')).classification).toBe('SUBSCRIPTION_REQUIRED')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('accepts a thinking fragment as evidence that inference started', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('{"message":{"thinking":"considering"},"done":false}\n', { status: 200 })
    try {
      const provider = new OllamaProvider({ id: 'ollama-free', name: 'Free', base_url: 'https://example.test/api', secret_ref: 'OLLAMA_API_KEY_FREE' }, 'test-key')
      expect((await provider.probe('thinking-model')).classification).toBe('SUCCESS')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

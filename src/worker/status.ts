import type { Classification, PublicStatus } from './types'

export function publicStatusFor(classification: Classification): PublicStatus {
  switch (classification) {
    case 'SUCCESS': return 'OPERATIONAL'
    case 'HIGH_LATENCY': return 'DEGRADED'
    case 'TIMEOUT': case 'NETWORK_ERROR': case 'MODEL_UNREACHABLE': case 'OVERLOADED': return 'OUTAGE'
    case 'AUTH_ERROR': return 'AUTHENTICATION'
    case 'RATE_LIMITED': return 'RATE_LIMITED'
    case 'SUBSCRIPTION_REQUIRED': return 'PLAN_REQUIRED'
    case 'MODEL_NOT_FOUND': return 'MODEL_NOT_FOUND'
    case 'INVALID_REQUEST': case 'PROTOCOL_ERROR': return 'CONFIGURATION'
    default: return 'UNKNOWN'
  }
}

export function classifyHttp(status: number): Classification {
  if (status === 401) return 'AUTH_ERROR'
  if (status === 429) return 'RATE_LIMITED'
  if (status === 404) return 'MODEL_NOT_FOUND'
  if (status === 400) return 'INVALID_REQUEST'
  if (status === 408 || status === 504) return 'TIMEOUT'
  if (status === 503) return 'OVERLOADED'
  if (status >= 500) return 'MODEL_UNREACHABLE'
  return 'PROTOCOL_ERROR'
}

export function trimmedMean(values: number[]): number | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const trim = sorted.length >= 10 ? Math.floor(sorted.length * 0.1) : 0
  const usable = sorted.slice(trim, sorted.length - trim)
  return usable.reduce((sum, value) => sum + value, 0) / usable.length
}

export function isLatencyAnomalous(latencyMs: number, baseline?: number): boolean {
  return latencyMs > Math.max(10_000, (baseline ?? 0) * 1.75)
}

export function checkIntervalMinutes(status: PublicStatus, hadRecentIncident: boolean, retryAfterSeconds?: number, tier: 'FREE' | 'PAID' | 'UNKNOWN' = 'FREE'): number {
  return status === 'AUTHENTICATION' ? 60
    : status === 'RATE_LIMITED' ? Math.max(60, Math.ceil((retryAfterSeconds ?? 0) / 60))
    : status === 'DEGRADED' || (status === 'OUTAGE' && hadRecentIncident) ? 5
    : status === 'OUTAGE' ? 15
    : tier === 'PAID' ? 15 : 5
}

export function nextCheckAt(status: PublicStatus, hadRecentIncident: boolean, retryAfterSeconds?: number, tier: 'FREE' | 'PAID' | 'UNKNOWN' = 'FREE'): string {
  const minutes = checkIntervalMinutes(status, hadRecentIncident, retryAfterSeconds, tier)
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

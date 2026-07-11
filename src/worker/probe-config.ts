const DEFAULT_MAX_RESPONSE_TOKENS = 8
const MAX_SAFE_RESPONSE_TOKENS = 4_096

export function maxResponseTokens(value: string | undefined): number {
  if (!value) return DEFAULT_MAX_RESPONSE_TOKENS
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SAFE_RESPONSE_TOKENS) return DEFAULT_MAX_RESPONSE_TOKENS
  return parsed
}

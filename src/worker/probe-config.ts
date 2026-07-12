// Some reasoning-capable models spend tokens on hidden "thinking" before emitting any visible
// content/thinking fragment, even with `think: false`. A too-small budget can exhaust itself
// before any token is observed, misclassifying a healthy model as EMPTY_RESPONSE.
const DEFAULT_MAX_RESPONSE_TOKENS = 32;
const MAX_SAFE_RESPONSE_TOKENS = 4_096;

export function maxResponseTokens(value: string | undefined): number {
    if (!value) return DEFAULT_MAX_RESPONSE_TOKENS;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SAFE_RESPONSE_TOKENS)
        return DEFAULT_MAX_RESPONSE_TOKENS;
    return parsed;
}

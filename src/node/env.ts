import type { D1DatabaseLike, Env } from '../worker/types.ts';

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} not configured`);
    return value;
}

// ASSETS is Cloudflare-only: grep confirms it is read exclusively from src/worker/index.ts,
// which the Node target never loads. The cast documents that this field is intentionally unused
// here rather than silently `undefined`.
export function buildEnv(db: D1DatabaseLike): Env {
    return {
        DB: db,
        ASSETS: undefined as unknown as Env['ASSETS'],
        OLLAMA_BASE_URL: required('OLLAMA_BASE_URL'),
        OLLAMA_MAX_TOKENS: process.env.OLLAMA_MAX_TOKENS,
        FREE_CHECK_INTERVAL_MINUTES: process.env.FREE_CHECK_INTERVAL_MINUTES,
        PAID_CHECK_INTERVAL_MINUTES: process.env.PAID_CHECK_INTERVAL_MINUTES,
        FREE_PROBE_CONCURRENCY: process.env.FREE_PROBE_CONCURRENCY,
        PAID_PROBE_CONCURRENCY: process.env.PAID_PROBE_CONCURRENCY,
        PROBE_DELAY_MIN_MS: process.env.PROBE_DELAY_MIN_MS,
        PROBE_DELAY_MAX_MS: process.env.PROBE_DELAY_MAX_MS,
        OLLAMA_API_KEY_FREE: required('OLLAMA_API_KEY_FREE'),
        OLLAMA_API_KEY_PAID: required('OLLAMA_API_KEY_PAID'),
        CONFIRMATION_HMAC_SECRET: process.env.CONFIRMATION_HMAC_SECRET,
        CONFIRMATION_CALLBACK_URL: process.env.CONFIRMATION_CALLBACK_URL,
        GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
        GITHUB_ACTIONS_TOKEN: process.env.GITHUB_ACTIONS_TOKEN,
        EXCLUDED_MODELS: process.env.EXCLUDED_MODELS,
        ENVIRONMENT: process.env.ENVIRONMENT,
    };
}

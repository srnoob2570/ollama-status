import type { ApiEnv, D1DatabaseLike, MonitorEnv } from '../worker/types.ts';

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} not configured`);
    return value;
}

// ASSETS is Cloudflare-only: grep confirms it is read exclusively from src/worker/index.ts,
// which the Node target never loads. The cast documents that this field is intentionally unused
// here rather than silently `undefined`.
function apiEnv(db: D1DatabaseLike): ApiEnv {
    return {
        DB: db,
        ASSETS: undefined as unknown as ApiEnv['ASSETS'],
        CONFIRMATION_HMAC_SECRET: process.env.CONFIRMATION_HMAC_SECRET,
        FREE_CHECK_INTERVAL_MINUTES: process.env.FREE_CHECK_INTERVAL_MINUTES,
        PAID_CHECK_INTERVAL_MINUTES: process.env.PAID_CHECK_INTERVAL_MINUTES,
    };
}

export function buildWebEnv(db: D1DatabaseLike): ApiEnv {
    return apiEnv(db);
}

export function buildRunnerEnv(db: D1DatabaseLike): MonitorEnv {
    return {
        ...apiEnv(db),
        OLLAMA_BASE_URL: required('OLLAMA_BASE_URL'),
        OLLAMA_MAX_TOKENS: process.env.OLLAMA_MAX_TOKENS,
        FREE_PROBE_CONCURRENCY: process.env.FREE_PROBE_CONCURRENCY,
        PAID_PROBE_CONCURRENCY: process.env.PAID_PROBE_CONCURRENCY,
        PROBE_DELAY_MIN_MS: process.env.PROBE_DELAY_MIN_MS,
        PROBE_DELAY_MAX_MS: process.env.PROBE_DELAY_MAX_MS,
        OLLAMA_API_KEY_FREE: required('OLLAMA_API_KEY_FREE'),
        OLLAMA_API_KEY_PAID: process.env.OLLAMA_API_KEY_PAID ?? '',
        CONFIRMATION_CALLBACK_URL: process.env.CONFIRMATION_CALLBACK_URL,
        GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
        GITHUB_ACTIONS_TOKEN: process.env.GITHUB_ACTIONS_TOKEN,
        EXCLUDED_MODELS: process.env.EXCLUDED_MODELS,
        ENVIRONMENT: process.env.ENVIRONMENT,
    };
}

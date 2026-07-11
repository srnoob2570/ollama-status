export type Classification =
    | 'SUCCESS'
    | 'HIGH_LATENCY'
    | 'TIMEOUT'
    | 'NETWORK_ERROR'
    | 'AUTH_ERROR'
    | 'RATE_LIMITED'
    | 'MODEL_NOT_FOUND'
    | 'MODEL_UNREACHABLE'
    | 'OVERLOADED'
    | 'EMPTY_RESPONSE'
    | 'PROTOCOL_ERROR'
    | 'INVALID_REQUEST'
    | 'SUBSCRIPTION_REQUIRED'
    | 'UNKNOWN';

export type PublicStatus =
    | 'OPERATIONAL'
    | 'DEGRADED'
    | 'OUTAGE'
    | 'AUTHENTICATION'
    | 'RATE_LIMITED'
    | 'MODEL_NOT_FOUND'
    | 'CONFIGURATION'
    | 'PLAN_REQUIRED'
    | 'UNKNOWN';

export interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    OLLAMA_BASE_URL: string;
    OLLAMA_MAX_TOKENS?: string;
    FREE_CHECK_INTERVAL_MINUTES?: string;
    PAID_CHECK_INTERVAL_MINUTES?: string;
    // Throttle controls so free API keys (1 concurrent model) don't burst into 429s.
    // Paid keys can raise PROBE_CONCURRENCY (~3-10) to finish runs faster.
    PROBE_CONCURRENCY?: string;
    PROBE_DELAY_MIN_MS?: string;
    PROBE_DELAY_MAX_MS?: string;
    OLLAMA_API_KEY_FREE: string;
    OLLAMA_API_KEY_PAID: string;
    CONFIRMATION_HMAC_SECRET?: string;
    CONFIRMATION_CALLBACK_URL?: string;
    GITHUB_REPOSITORY?: string;
    GITHUB_ACTIONS_TOKEN?: string;
    EXCLUDED_MODELS?: string;
    ENVIRONMENT?: string;
}

export interface Provider {
    id: string;
    name: string;
    base_url: string;
    secret_ref: 'OLLAMA_API_KEY_FREE' | 'OLLAMA_API_KEY_PAID';
}
export interface Model {
    id: string;
    provider_id: string;
    remote_name: string;
    digest: string | null;
    last_show_at: string | null;
    tier?: 'FREE' | 'PAID' | 'UNKNOWN';
}
export interface ProbeResult {
    classification: Classification;
    publicStatus: PublicStatus;
    httpStatus?: number;
    totalDurationMs?: number;
    rttMs: number;
    loadDurationMs?: number;
    errorCode?: string;
    retryAfterSeconds?: number;
}

export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

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

// ── Diagnostic dimensions (spec 002) ──────────────────────────────────────────

export type FailureDomain =
    | 'MODEL'
    | 'PROVIDER'
    | 'ACCOUNT'
    | 'NETWORK_PATH'
    | 'SCHEDULER_CAPACITY'
    | 'NODE_RUNTIME'
    | 'STORAGE'
    | 'PROTOCOL'
    | 'CONFIGURATION'
    | 'NONE'
    | 'UNKNOWN';

export type ReasonCode =
    // Timeout / cancel
    | 'timeout_before_headers'
    | 'timeout_waiting_first_byte'
    | 'timeout_waiting_first_token'
    | 'run_hard_stop'
    | 'lease_expired'
    // Scheduler
    | 'lock_contended'
    | 'duplicate_tick'
    | 'selection_limit'
    | 'run_budget_exceeded'
    | 'manual_run_fulfilled_tick'
    // Source
    | 'catalog_unavailable'
    | 'catalog_protocol_error'
    | 'metadata_deferred'
    // Credential
    | 'credential_missing'
    | 'credential_auth_failed'
    | 'credential_rate_limited'
    | 'credential_cooldown'
    | 'no_eligible_credential'
    | 'plan_access_denied'
    // Provider / model
    | 'subscription_required'
    | 'model_not_found'
    | 'provider_overloaded'
    | 'provider_http_timeout'
    | 'provider_http_5xx'
    | 'empty_response'
    // Protocol / network
    | 'network_error'
    | 'invalid_stream'
    | 'stream_too_large'
    | 'stream_error'
    // Node / storage
    | 'node_offline'
    | 'no_eligible_node'
    | 'db_write_failed'
    | 'stale_result'
    | 'no_result'
    // Meta
    | 'no_action'
    | 'unattributed'
    | 'legacy_execution';

export type EvidenceSource =
    | 'HTTP_STATUS'
    | 'ABORT_SIGNAL'
    | 'STREAM_STATE'
    | 'EMPTY_RESPONSE'
    | 'CLASSIFIER_RULE'
    | 'TIMEOUT_PHASE'
    | 'LEASE_EXPIRY'
    | 'SCHEDULER_DECISION'
    | 'UNKNOWN';

export type Retryability =
    | 'NONE'
    | 'AFTER_RETRY_AFTER'
    | 'OTHER_REGION'
    | 'OTHER_CREDENTIAL'
    | 'AFTER_BACKOFF'
    | 'AFTER_LEASE_RENEWAL';

export type TimeoutStage =
    | 'REQUEST_OR_HEADERS'
    | 'FIRST_BYTE'
    | 'FIRST_TOKEN'
    | 'NONE';

// ── Lifecycle types (spec 002) ────────────────────────────────────────────────

export type TickTrigger = 'CRON' | 'MANUAL' | 'RECOVERY';
export type TickState = 'RECEIVED' | 'RUNNING' | 'COMPLETED';
export type TickOutcome =
    | 'LOCK_CONTENDED'
    | 'DUPLICATE'
    | 'FULFILLED_BY_MANUAL'
    | 'SUCCEEDED'
    | 'PARTIAL'
    | 'FAILED';

export type ExpectationState =
    | 'EXPECTED'
    | 'SCHEDULED'
    | 'SATISFIED'
    | 'SUPPRESSED'
    | 'MISSED'
    | 'CANCELLED';

export type AttemptState =
    | 'QUEUED'
    | 'LEASED'
    | 'STARTED'
    | 'COMPLETED'
    | 'FAILED'
    | 'EXPIRED'
    | 'CANCELLED';

export type SubmissionDisposition =
    | 'ACCEPTED'
    | 'DUPLICATE'
    | 'STALE'
    | 'CONFLICT'
    | 'REJECTED';

export type CadenceWindowState =
    | 'INSUFFICIENT_DATA'
    | 'HEALTHY'
    | 'DEGRADED'
    | 'BREACHED';

export type ObservationRole =
    | 'AVAILABILITY'
    | 'ENTITLEMENT'
    | 'WARMUP'
    | 'METADATA';

// ── Entity interfaces (spec 002) ─────────────────────────────────────────────

export interface SchedulerTick {
    id: string;
    tickKey: string;
    scheduledAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    trigger: TickTrigger;
    state: TickState;
    outcome: TickOutcome | null;
    runId: string | null;
    reasonCode: ReasonCode | null;
    policyVersion: number;
}

export interface ModelCheckExpectation {
    id: string;
    modelId: string;
    purpose: string;
    dueAt: string;
    deadlineAt: string;
    tier: string;
    intervalMinutes: number;
    configSnapshotJson: string | null;
    policyVersion: number;
    state: ExpectationState;
    reasonCode: ReasonCode | null;
    resolvedAt: string | null;
    cutoverAt: string | null;
    migrationOrigin: string | null;
}

export interface ProbeAttempt {
    id: string;
    runId: string;
    taskId: string;
    parentType: string;
    parentId: string;
    modelId: string;
    attemptNo: number;
    purpose: string;
    providerId: string;
    credentialAccountId: string;
    credentialKeyId: string;
    credentialBindingId: string;
    nodeId: string;
    region: string;
    queuedAt: string | null;
    leasedAt: string | null;
    startedAt: string | null;
    headersAt: string | null;
    firstByteAt: string | null;
    firstTokenAt: string | null;
    finishedAt: string | null;
    receivedAt: string | null;
    state: AttemptState;
    classification: Classification;
    publicStatus: PublicStatus;
    contributesToStatus: boolean;
    failureDomain: FailureDomain | null;
    reasonCode: ReasonCode | null;
    evidenceSource: EvidenceSource | null;
    retryability: Retryability | null;
    timeoutStage: TimeoutStage | null;
    timeoutBudgetMs: number | null;
    httpStatus: number | null;
    retryAfterSeconds: number | null;
    retryAt: string | null;
    bytesRead: number | null;
    queueWaitMs: number | null;
    ttftMs: number | null;
    totalElapsedMs: number | null;
    loadDurationMs: number | null;
    errorFingerprint: string | null;
    classifierRuleVersion: number | null;
    policyVersion: number;
    agentVersion: string | null;
    experimentId: string | null;
    assignedArm: string | null;
    warmupAttemptId: string | null;
    wasWarmed: boolean;
    warmupAgeMs: number | null;
    experimentConfigVersion: number | null;
}

export interface ResultSubmission {
    id: string;
    attemptId: string;
    taskId: string;
    receivedAt: string;
    nodeId: string;
    fencingToken: string;
    idempotencyKey: string;
    canonicalPayloadHash: string;
    disposition: SubmissionDisposition;
    reasonCode: ReasonCode | null;
}

export interface ProbeEvent {
    id: string;
    eventType: string;
    eventVersion: number;
    occurredAt: string;
    recordedAt: string;
    actorType: string;
    actorId: string;
    subjectType: string;
    subjectId: string;
    schedulerTickId: string | null;
    runId: string | null;
    expectationId: string | null;
    executionId: string | null;
    taskId: string | null;
    attemptId: string | null;
    causationEventId: string | null;
    correlationId: string | null;
    sequence: number | null;
    idempotencyKey: string | null;
    detailJson: string | null;
}

export interface HourlyExecutionRollup {
    modelId: string;
    hourAt: string;
    purpose: string;
    tier: string;
    nominalExpected: number;
    satisfied: number;
    suppressed: number;
    missed: number;
    cancelled: number;
    nominalCoverage: number;
    policyAdherence: number;
    dominantReason: ReasonCode | null;
}

export interface CadenceWindow {
    modelId: string;
    window: string;
    nominalExpected: number;
    satisfied: number;
    suppressed: number;
    missed: number;
    cancelled: number;
    nominalCoverage: number;
    policyAdherence: number;
    state: CadenceWindowState;
    dominantReason: ReasonCode | null;
    evaluatedAt: string;
}

export interface D1StatementLike {
    bind(...values: unknown[]): D1StatementLike;
    run(): Promise<{ meta: { changes: number } }>;
    all<T = unknown>(): Promise<{ results: T[] }>;
    first<T = unknown>(): Promise<T | null>;
}

export interface D1DatabaseLike {
    prepare(query: string): D1StatementLike;
    batch(statements: D1StatementLike[]): Promise<{ meta: { changes: number } }[]>;
}

export interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
}
export interface Fetcher {
    fetch(request: Request): Promise<Response>;
}
export interface Cache {
    match(request: Request | string): Promise<Response | undefined>;
    put(request: Request | string, response: Response): Promise<void>;
}
export interface CacheStorage {
    default: Cache;
}

export interface ApiEnv {
    DB: D1DatabaseLike;
    ASSETS: Fetcher;
    CONFIRMATION_HMAC_SECRET?: string;
    FREE_CHECK_INTERVAL_MINUTES?: string;
    PAID_CHECK_INTERVAL_MINUTES?: string;
}

/** Configuration shared by the scheduler and its probe workers. */
export interface MonitorEnv extends ApiEnv {
    OLLAMA_BASE_URL: string;
    OLLAMA_MAX_TOKENS?: string;
    // Independent throttle controls: Free keys remain conservative, while Paid keys can
    // use the provider's higher parallelism allowance.
    FREE_PROBE_CONCURRENCY?: string;
    PAID_PROBE_CONCURRENCY?: string;
    PROBE_DELAY_MIN_MS?: string;
    PROBE_DELAY_MAX_MS?: string;
    OLLAMA_API_KEY_FREE: string;
    OLLAMA_API_KEY_PAID: string;
    CONFIRMATION_CALLBACK_URL?: string;
    GITHUB_REPOSITORY?: string;
    GITHUB_ACTIONS_TOKEN?: string;
    EXCLUDED_MODELS?: string;
    ENVIRONMENT?: string;
}

// Cloudflare binds the complete monitor capability set to one Worker. Node splits it into a
// database-only web process and a private monitor process.
export type Env = MonitorEnv;

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
    // Timeline fields (spec 002)
    headersAt?: string | null;
    firstByteAt?: string | null;
    firstTokenAt?: string | null;
    ttftMs?: number | null;
    timeoutStage?: TimeoutStage;
    failureDomain?: FailureDomain;
    reasonCode?: ReasonCode;
    evidenceSource?: EvidenceSource;
    retryability?: Retryability;
    contributesToStatus?: boolean;
}

export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

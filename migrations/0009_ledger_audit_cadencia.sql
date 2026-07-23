-- ============================================================================
-- 0009_ledger_audit_cadencia (SQLite fixture variant)
-- Ledger, audit trail, and cadence system (spec 002).
-- This is the SQLite-compatible fixture copy used by the in-memory test DB.
-- The canonical PostgreSQL version lives in migrations/postgres/.
-- ============================================================================

CREATE TABLE IF NOT EXISTS scheduler_ticks (
    id              TEXT PRIMARY KEY,
    tick_key        TEXT NOT NULL UNIQUE,
    scheduled_at    TEXT NOT NULL,
    started_at      TEXT,
    finished_at     TEXT,
    trigger         TEXT NOT NULL CHECK (trigger IN ('CRON', 'MANUAL', 'RECOVERY')),
    state           TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (state IN ('RECEIVED', 'RUNNING', 'COMPLETED')),
    outcome         TEXT CHECK (outcome IN ('LOCK_CONTENDED', 'DUPLICATE', 'FULFILLED_BY_MANUAL', 'SUCCEEDED', 'PARTIAL', 'FAILED')),
    run_id          TEXT REFERENCES monitor_runs(id),
    reason_code     TEXT,
    policy_version  TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduler_ticks_scheduled_at ON scheduler_ticks(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduler_ticks_started_at   ON scheduler_ticks(started_at);
CREATE INDEX IF NOT EXISTS idx_scheduler_ticks_finished_at  ON scheduler_ticks(finished_at);
CREATE INDEX IF NOT EXISTS idx_scheduler_ticks_run_id       ON scheduler_ticks(run_id);
CREATE INDEX IF NOT EXISTS idx_scheduler_ticks_state        ON scheduler_ticks(state);

CREATE TABLE IF NOT EXISTS model_check_expectations (
    id                      TEXT PRIMARY KEY,
    model_id                TEXT NOT NULL REFERENCES models(id),
    purpose                 TEXT NOT NULL,
    due_at                  TEXT NOT NULL,
    deadline_at             TEXT,
    tier                    TEXT NOT NULL,
    interval_minutes        INTEGER NOT NULL,
    config_snapshot_json    TEXT,
    policy_version          TEXT,
    state                   TEXT NOT NULL DEFAULT 'EXPECTED' CHECK (state IN ('EXPECTED', 'SCHEDULED', 'SATISFIED', 'SUPPRESSED', 'MISSED', 'CANCELLED')),
    reason_code             TEXT,
    resolved_at             TEXT,
    cutover_at              TEXT,
    migration_origin        TEXT,
    UNIQUE(model_id, purpose, due_at)
);

CREATE INDEX IF NOT EXISTS idx_model_check_expectations_model_id    ON model_check_expectations(model_id);
CREATE INDEX IF NOT EXISTS idx_model_check_expectations_due_at        ON model_check_expectations(due_at);
CREATE INDEX IF NOT EXISTS idx_model_check_expectations_deadline_at   ON model_check_expectations(deadline_at);
CREATE INDEX IF NOT EXISTS idx_model_check_expectations_state         ON model_check_expectations(state);
CREATE INDEX IF NOT EXISTS idx_model_check_expectations_cutover_at    ON model_check_expectations(cutover_at);

ALTER TABLE model_check_executions ADD COLUMN expectation_id TEXT;
ALTER TABLE model_check_executions ADD COLUMN purpose TEXT;
ALTER TABLE model_check_executions ADD COLUMN due_at TEXT;
ALTER TABLE model_check_executions ADD COLUMN deadline_at TEXT;
ALTER TABLE model_check_executions ADD COLUMN policy_version TEXT;
ALTER TABLE model_check_executions ADD COLUMN terminal_reason_code TEXT;
ALTER TABLE model_check_executions ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_check_executions ADD COLUMN accepted_attempt_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_check_executions_model_purpose_due ON model_check_executions(model_id, purpose, due_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_check_executions_expectation_id ON model_check_executions(expectation_id);
CREATE INDEX IF NOT EXISTS idx_model_check_executions_due_at ON model_check_executions(due_at);
CREATE INDEX IF NOT EXISTS idx_model_check_executions_deadline_at ON model_check_executions(deadline_at);

CREATE TABLE IF NOT EXISTS probe_attempts (
    id                        TEXT PRIMARY KEY,
    run_id                    TEXT NOT NULL,
    task_id                   TEXT,
    parent_type               TEXT,
    parent_id                 TEXT,
    model_id                  TEXT NOT NULL REFERENCES models(id),
    attempt_no                INTEGER NOT NULL DEFAULT 1,
    purpose                   TEXT,
    provider_id               TEXT NOT NULL REFERENCES providers(id),
    credential_account_id     TEXT,
    credential_key_id         TEXT,
    credential_binding_id     TEXT,
    node_id                   TEXT,
    region                    TEXT,
    queued_at                 TEXT,
    leased_at                 TEXT,
    started_at                TEXT,
    headers_at                TEXT,
    first_byte_at             TEXT,
    first_token_at            TEXT,
    finished_at               TEXT,
    received_at               TEXT,
    state                     TEXT NOT NULL DEFAULT 'LEASED' CHECK (state IN ('QUEUED', 'LEASED', 'STARTED', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED')),
    classification            TEXT,
    public_status             TEXT,
    contributes_to_status     INTEGER NOT NULL DEFAULT 1,
    failure_domain            TEXT,
    reason_code               TEXT,
    evidence_source           TEXT,
    retryability              TEXT,
    timeout_stage             TEXT,
    timeout_budget_ms         INTEGER,
    http_status               INTEGER,
    retry_after_seconds       INTEGER,
    retry_at                  TEXT,
    bytes_read                INTEGER,
    queue_wait_ms             NUMERIC,
    ttft_ms                   NUMERIC,
    total_elapsed_ms          NUMERIC,
    load_duration_ms          NUMERIC,
    error_fingerprint         TEXT,
    classifier_rule_version   TEXT,
    policy_version            TEXT,
    agent_version             TEXT,
    experiment_id             TEXT,
    assigned_arm              TEXT,
    warmup_attempt_id         TEXT,
    was_warmed                INTEGER NOT NULL DEFAULT 0,
    warmup_age_ms             INTEGER,
    experiment_config_version INTEGER
);

CREATE INDEX IF NOT EXISTS idx_probe_attempts_run_id              ON probe_attempts(run_id);
CREATE INDEX IF NOT EXISTS idx_probe_attempts_model_id            ON probe_attempts(model_id);
CREATE INDEX IF NOT EXISTS idx_probe_attempts_task_id            ON probe_attempts(task_id);
CREATE INDEX IF NOT EXISTS idx_probe_attempts_state               ON probe_attempts(state);
CREATE INDEX IF NOT EXISTS idx_probe_attempts_started_at          ON probe_attempts(started_at);
CREATE INDEX IF NOT EXISTS idx_probe_attempts_finished_at         ON probe_attempts(finished_at);
CREATE INDEX IF NOT EXISTS idx_probe_attempts_received_at         ON probe_attempts(received_at);
CREATE INDEX IF NOT EXISTS idx_probe_attempts_classification      ON probe_attempts(classification);
CREATE INDEX IF NOT EXISTS idx_probe_attempts_reason_code         ON probe_attempts(reason_code);
CREATE INDEX IF NOT EXISTS idx_probe_attempts_failure_domain     ON probe_attempts(failure_domain);
CREATE INDEX IF NOT EXISTS idx_probe_attempts_timeout_stage       ON probe_attempts(timeout_stage);
CREATE INDEX IF NOT EXISTS idx_probe_attempts_provider_id        ON probe_attempts(provider_id);
CREATE INDEX IF NOT EXISTS idx_probe_attempts_node_id            ON probe_attempts(node_id);

CREATE TABLE IF NOT EXISTS result_submissions (
    id                   TEXT PRIMARY KEY,
    attempt_id           TEXT NOT NULL REFERENCES probe_attempts(id),
    task_id              TEXT,
    received_at          TEXT NOT NULL,
    node_id              TEXT,
    fencing_token        TEXT,
    idempotency_key      TEXT NOT NULL,
    canonical_payload_hash TEXT NOT NULL,
    disposition          TEXT NOT NULL CHECK (disposition IN ('ACCEPTED', 'DUPLICATE', 'STALE', 'CONFLICT', 'REJECTED')),
    reason_code          TEXT,
    UNIQUE(attempt_id, idempotency_key, canonical_payload_hash)
);

CREATE INDEX IF NOT EXISTS idx_result_submissions_attempt_id       ON result_submissions(attempt_id);
CREATE INDEX IF NOT EXISTS idx_result_submissions_received_at      ON result_submissions(received_at);
CREATE INDEX IF NOT EXISTS idx_result_submissions_disposition      ON result_submissions(disposition);

CREATE TABLE IF NOT EXISTS probe_events (
    id                  TEXT PRIMARY KEY,
    event_type          TEXT NOT NULL,
    event_version       INTEGER NOT NULL DEFAULT 1,
    occurred_at         TEXT NOT NULL,
    recorded_at         TEXT NOT NULL,
    actor_type          TEXT,
    actor_id            TEXT,
    subject_type        TEXT,
    subject_id          TEXT,
    scheduler_tick_id   TEXT,
    run_id              TEXT,
    expectation_id      TEXT REFERENCES model_check_expectations(id),
    execution_id        TEXT REFERENCES model_check_executions(id),
    task_id             TEXT,
    attempt_id          TEXT REFERENCES probe_attempts(id),
    causation_event_id  TEXT,
    correlation_id      TEXT,
    sequence            INTEGER,
    idempotency_key     TEXT,
    detail_json         TEXT
);

CREATE INDEX IF NOT EXISTS idx_probe_events_occurred_at        ON probe_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_probe_events_scheduler_tick_id ON probe_events(scheduler_tick_id);
CREATE INDEX IF NOT EXISTS idx_probe_events_run_id             ON probe_events(run_id);
CREATE INDEX IF NOT EXISTS idx_probe_events_expectation_id     ON probe_events(expectation_id);
CREATE INDEX IF NOT EXISTS idx_probe_events_execution_id       ON probe_events(execution_id);
CREATE INDEX IF NOT EXISTS idx_probe_events_attempt_id         ON probe_events(attempt_id);
CREATE INDEX IF NOT EXISTS idx_probe_events_causation_event_id ON probe_events(causation_event_id);
CREATE INDEX IF NOT EXISTS idx_probe_events_correlation_id     ON probe_events(correlation_id);
CREATE INDEX IF NOT EXISTS idx_probe_events_event_type         ON probe_events(event_type);

CREATE TABLE IF NOT EXISTS probe_outbox (
    id              TEXT PRIMARY KEY,
    event_id        TEXT NOT NULL REFERENCES probe_events(id),
    consumed_at     TEXT,
    consumer_id     TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_probe_outbox_event_id    ON probe_outbox(event_id);
CREATE INDEX IF NOT EXISTS idx_probe_outbox_consumed_at ON probe_outbox(consumed_at);

CREATE TABLE IF NOT EXISTS hourly_execution_rollups (
    model_id            TEXT NOT NULL REFERENCES models(id),
    hour_at             TEXT NOT NULL,
    purpose             TEXT NOT NULL,
    tier                TEXT NOT NULL,
    nominal_expected    INTEGER NOT NULL DEFAULT 0,
    satisfied           INTEGER NOT NULL DEFAULT 0,
    suppressed          INTEGER NOT NULL DEFAULT 0,
    missed              INTEGER NOT NULL DEFAULT 0,
    cancelled           INTEGER NOT NULL DEFAULT 0,
    nominal_coverage    NUMERIC,
    policy_adherence    NUMERIC,
    dominant_reason     TEXT,
    PRIMARY KEY (model_id, hour_at, purpose)
);

CREATE INDEX IF NOT EXISTS idx_hourly_execution_rollups_hour_at ON hourly_execution_rollups(hour_at);

CREATE TABLE IF NOT EXISTS _expectation_watermarks (
    policy_version TEXT PRIMARY KEY,
    watermark      TEXT NOT NULL
);

ALTER TABLE checks ADD COLUMN attempt_id TEXT;
ALTER TABLE checks ADD COLUMN observation_role TEXT;
ALTER TABLE checks ADD COLUMN retry_after_seconds INTEGER;
ALTER TABLE checks ADD COLUMN timeout_stage TEXT;
ALTER TABLE checks ADD COLUMN reason_code TEXT;
ALTER TABLE checks ADD COLUMN failure_domain TEXT;
ALTER TABLE checks ADD COLUMN region TEXT;
ALTER TABLE checks ADD COLUMN purpose TEXT;
ALTER TABLE checks ADD COLUMN ttft_ms REAL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_checks_attempt_observation_role ON checks(attempt_id, observation_role);
CREATE INDEX IF NOT EXISTS idx_checks_attempt_id       ON checks(attempt_id);
CREATE INDEX IF NOT EXISTS idx_checks_observation_role ON checks(observation_role);
CREATE INDEX IF NOT EXISTS idx_checks_purpose         ON checks(purpose);

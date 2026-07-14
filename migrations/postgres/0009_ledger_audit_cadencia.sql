-- ============================================================================
-- 0009_ledger_audit_cadencia
-- Ledger, audit trail, and cadence system (spec 002).
--
-- Creates 7 new tables: scheduler_ticks, model_check_expectations,
-- probe_attempts, result_submissions, probe_events, probe_outbox,
-- hourly_execution_rollups.
--
-- Alters model_check_executions and checks with new ledger columns.
-- Backfills existing execution rows with synthetic LEGACY_EXECUTION
-- expectations without inventing evidence.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. scheduler_ticks — idempotent tick registry (recorded BEFORE lock attempt)
-- ---------------------------------------------------------------------------
CREATE TABLE scheduler_ticks (
    id              TEXT PRIMARY KEY,
    tick_key        TEXT NOT NULL UNIQUE,
    scheduled_at    TEXT NOT NULL,
    started_at      TEXT,
    finished_at     TEXT,
    trigger         TEXT NOT NULL CHECK (trigger IN ('CRON', 'MANUAL', 'RECOVERY')),
    state           TEXT NOT NULL DEFAULT 'RECEIVED'
                        CHECK (state IN ('RECEIVED', 'RUNNING', 'COMPLETED')),
    outcome         TEXT CHECK (outcome IN (
                        'LOCK_CONTENDED', 'DUPLICATE', 'FULFILLED_BY_MANUAL',
                        'SUCCEEDED', 'PARTIAL', 'FAILED'
                    )),
    run_id          TEXT REFERENCES monitor_runs(id),
    reason_code     TEXT,
    policy_version  TEXT
);

CREATE INDEX idx_scheduler_ticks_scheduled_at   ON scheduler_ticks(scheduled_at);
CREATE INDEX idx_scheduler_ticks_started_at     ON scheduler_ticks(started_at);
CREATE INDEX idx_scheduler_ticks_finished_at    ON scheduler_ticks(finished_at);
CREATE INDEX idx_scheduler_ticks_run_id         ON scheduler_ticks(run_id);
CREATE INDEX idx_scheduler_ticks_state          ON scheduler_ticks(state);

-- ---------------------------------------------------------------------------
-- 2. model_check_expectations — one row per nominal opportunity
-- ---------------------------------------------------------------------------
CREATE TABLE model_check_expectations (
    id                      TEXT PRIMARY KEY,
    model_id                TEXT NOT NULL REFERENCES models(id),
    purpose                 TEXT NOT NULL,
    due_at                  TEXT NOT NULL,
    deadline_at             TEXT,
    tier                    TEXT NOT NULL,
    interval_minutes        INTEGER NOT NULL,
    config_snapshot_json    TEXT,
    policy_version          TEXT,
    state                   TEXT NOT NULL DEFAULT 'EXPECTED'
                                CHECK (state IN (
                                    'EXPECTED', 'SCHEDULED', 'SATISFIED',
                                    'SUPPRESSED', 'MISSED', 'CANCELLED'
                                )),
    reason_code             TEXT,
    resolved_at             TEXT,
    cutover_at              TEXT NOT NULL,
    migration_origin        TEXT,   -- only set for LEGACY_EXECUTION backfill rows
    UNIQUE (model_id, purpose, due_at)
);

CREATE INDEX idx_model_check_expectations_model_id   ON model_check_expectations(model_id);
CREATE INDEX idx_model_check_expectations_due_at     ON model_check_expectations(due_at);
CREATE INDEX idx_model_check_expectations_deadline_at ON model_check_expectations(deadline_at);
CREATE INDEX idx_model_check_expectations_state      ON model_check_expectations(state);
CREATE INDEX idx_model_check_expectations_resolved_at ON model_check_expectations(resolved_at);
CREATE INDEX idx_model_check_expectations_cutover_at ON model_check_expectations(cutover_at);

-- ---------------------------------------------------------------------------
-- 3. ALTER model_check_executions — add ledger columns (nullable first)
-- ---------------------------------------------------------------------------
ALTER TABLE model_check_executions
    ADD COLUMN expectation_id        TEXT,
    ADD COLUMN purpose               TEXT,
    ADD COLUMN due_at                TEXT,
    ADD COLUMN deadline_at           TEXT,
    ADD COLUMN policy_version        TEXT,
    ADD COLUMN terminal_reason_code  TEXT,
    ADD COLUMN attempt_count         INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN accepted_attempt_id   TEXT;

-- Drop old unique index on (model_id, scheduled_at) — replaced by new contract
DROP INDEX IF EXISTS idx_model_check_executions_model_scheduled;

-- ---------------------------------------------------------------------------
-- 4. Backfill existing model_check_executions rows
--    Each legacy execution gets a synthetic expectation with
--    migration_origin = 'LEGACY_EXECUTION', purpose = 'AVAILABILITY',
--    due_at = scheduled_at, state = 'SATISFIED'.
--    No evidence is invented: no attempts, no submissions, no events.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    _cutover_at  TEXT;
    _exec        RECORD;
    _expect_id   TEXT;
BEGIN
    -- Fixed cutover timestamp for this migration
    _cutover_at := to_char(clock_timestamp() AT TIME ZONE 'utc',
                           'YYYY-MM-DD"T"HH24:MI:SS.000"Z"');

    FOR _exec IN
        SELECT id, model_id, tier, interval_minutes,
               scheduled_at, completed_at, run_id
        FROM model_check_executions
        ORDER BY scheduled_at
    LOOP
        _expect_id := 'legacy-' || _exec.id;

        INSERT INTO model_check_expectations (
            id, model_id, purpose, due_at, deadline_at,
            tier, interval_minutes, config_snapshot_json,
            policy_version, state, reason_code, resolved_at,
            cutover_at, migration_origin
        ) VALUES (
            _expect_id,
            _exec.model_id,
            'AVAILABILITY',
            _exec.scheduled_at,
            _exec.scheduled_at,          -- deadline = due for legacy
            _exec.tier,
            _exec.interval_minutes,
            NULL,                        -- no historical config snapshot
            NULL,                        -- no historical policy version
            'SATISFIED',
            'LEGACY_MIGRATION',
            COALESCE(_exec.completed_at, _exec.scheduled_at),
            _cutover_at,
            'LEGACY_EXECUTION'
        );

        UPDATE model_check_executions
        SET expectation_id = _expect_id,
            purpose         = 'AVAILABILITY',
            due_at          = _exec.scheduled_at,
            deadline_at     = _exec.scheduled_at
        WHERE id = _exec.id;
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Finalize model_check_executions columns and constraints
-- ---------------------------------------------------------------------------
ALTER TABLE model_check_executions
    ALTER COLUMN expectation_id SET NOT NULL;

ALTER TABLE model_check_executions
    ADD CONSTRAINT uq_model_check_executions_expectation_id
        UNIQUE (expectation_id);

-- New canonical uniqueness: one execution per (model, purpose, due_at)
CREATE UNIQUE INDEX idx_model_check_executions_model_purpose_due
    ON model_check_executions(model_id, purpose, due_at);

-- Index new FK and date columns
CREATE INDEX idx_model_check_executions_expectation_id ON model_check_executions(expectation_id);
CREATE INDEX idx_model_check_executions_due_at         ON model_check_executions(due_at);
CREATE INDEX idx_model_check_executions_deadline_at    ON model_check_executions(deadline_at);

-- ---------------------------------------------------------------------------
-- 6. probe_attempts — physical probe attempt with full lifecycle
-- ---------------------------------------------------------------------------
CREATE TABLE probe_attempts (
    -- identity
    id                      TEXT PRIMARY KEY,
    run_id                  TEXT NOT NULL REFERENCES monitor_runs(id),
    task_id                 TEXT,
    parent_type             TEXT,
    parent_id               TEXT,
    model_id                TEXT NOT NULL REFERENCES models(id),
    attempt_no              INTEGER NOT NULL DEFAULT 1,

    -- purpose / provenance
    purpose                 TEXT,
    provider_id             TEXT NOT NULL REFERENCES providers(id),
    credential_account_id   TEXT,
    credential_key_id       TEXT,
    credential_binding_id   TEXT,
    node_id                 TEXT,
    region                  TEXT,

    -- lifecycle
    queued_at               TEXT,
    leased_at               TEXT,
    started_at              TEXT,
    headers_at              TEXT,
    first_byte_at           TEXT,
    first_token_at          TEXT,
    finished_at             TEXT,
    received_at             TEXT,

    -- outcome
    state                   TEXT NOT NULL DEFAULT 'LEASED'
                                CHECK (state IN (
                                    'LEASED', 'STARTED', 'COMPLETED',
                                    'FAILED', 'EXPIRED', 'CANCELLED'
                                )),
    classification          TEXT,
    public_status           TEXT,
    contributes_to_status   BOOLEAN NOT NULL DEFAULT TRUE,

    -- diagnosis
    failure_domain          TEXT,
    reason_code             TEXT,
    evidence_source         TEXT,
    retryability            TEXT,
    timeout_stage           TEXT,
    timeout_budget_ms       INTEGER,

    -- protocol
    http_status             INTEGER,
    retry_after_seconds     INTEGER,
    retry_at                TEXT,
    bytes_read              INTEGER,

    -- timing
    queue_wait_ms           REAL,
    ttft_ms                 REAL,
    total_elapsed_ms        REAL,
    load_duration_ms        REAL,

    -- audit
    error_fingerprint       TEXT,
    classifier_rule_version TEXT,
    policy_version          TEXT,
    agent_version           TEXT,

    -- experiment
    experiment_id           TEXT,
    assigned_arm            TEXT,
    warmup_attempt_id       TEXT,
    was_warmed              BOOLEAN NOT NULL DEFAULT FALSE,
    warmup_age_ms           REAL,
    experiment_config_version TEXT
);

-- FK and cleanup indexes
CREATE INDEX idx_probe_attempts_run_id         ON probe_attempts(run_id);
CREATE INDEX idx_probe_attempts_task_id        ON probe_attempts(task_id);
CREATE INDEX idx_probe_attempts_model_id       ON probe_attempts(model_id);
CREATE INDEX idx_probe_attempts_provider_id    ON probe_attempts(provider_id);
CREATE INDEX idx_probe_attempts_queued_at      ON probe_attempts(queued_at);
CREATE INDEX idx_probe_attempts_started_at     ON probe_attempts(started_at);
CREATE INDEX idx_probe_attempts_finished_at    ON probe_attempts(finished_at);
CREATE INDEX idx_probe_attempts_received_at    ON probe_attempts(received_at);
CREATE INDEX idx_probe_attempts_state          ON probe_attempts(state);
CREATE INDEX idx_probe_attempts_parent         ON probe_attempts(parent_type, parent_id);

-- ---------------------------------------------------------------------------
-- 7. result_submissions — idempotent result delivery log
-- ---------------------------------------------------------------------------
CREATE TABLE result_submissions (
    id                      TEXT PRIMARY KEY,
    attempt_id              TEXT NOT NULL REFERENCES probe_attempts(id),
    task_id                 TEXT,
    received_at             TEXT NOT NULL,
    node_id                 TEXT,
    fencing_token           TEXT,
    idempotency_key         TEXT NOT NULL,
    canonical_payload_hash  TEXT NOT NULL,
    disposition             TEXT NOT NULL
                                CHECK (disposition IN (
                                    'ACCEPTED', 'DUPLICATE', 'STALE',
                                    'CONFLICT', 'REJECTED'
                                )),
    reason_code             TEXT,
    UNIQUE (attempt_id, idempotency_key, canonical_payload_hash)
);

CREATE INDEX idx_result_submissions_attempt_id  ON result_submissions(attempt_id);
CREATE INDEX idx_result_submissions_received_at ON result_submissions(received_at);

-- ---------------------------------------------------------------------------
-- 8. probe_events — append-only causal event timeline
-- ---------------------------------------------------------------------------
CREATE TABLE probe_events (
    id                  TEXT PRIMARY KEY,
    event_type          TEXT NOT NULL,
    event_version       TEXT NOT NULL DEFAULT '1.0',
    occurred_at         TEXT NOT NULL,
    recorded_at         TEXT NOT NULL,
    actor_type          TEXT,
    actor_id            TEXT,
    subject_type        TEXT,
    subject_id          TEXT,
    scheduler_tick_id   TEXT REFERENCES scheduler_ticks(id),
    run_id              TEXT REFERENCES monitor_runs(id),
    expectation_id      TEXT REFERENCES model_check_expectations(id),
    execution_id        TEXT REFERENCES model_check_executions(id),
    task_id             TEXT,
    attempt_id          TEXT REFERENCES probe_attempts(id),
    causation_event_id  TEXT REFERENCES probe_events(id),
    correlation_id      TEXT,
    sequence            INTEGER,
    idempotency_key     TEXT,
    detail_json         TEXT
);

-- FK and cleanup indexes
CREATE INDEX idx_probe_events_occurred_at        ON probe_events(occurred_at);
CREATE INDEX idx_probe_events_scheduler_tick_id  ON probe_events(scheduler_tick_id);
CREATE INDEX idx_probe_events_run_id             ON probe_events(run_id);
CREATE INDEX idx_probe_events_expectation_id     ON probe_events(expectation_id);
CREATE INDEX idx_probe_events_execution_id       ON probe_events(execution_id);
CREATE INDEX idx_probe_events_attempt_id         ON probe_events(attempt_id);
CREATE INDEX idx_probe_events_causation_event_id ON probe_events(causation_event_id);
CREATE INDEX idx_probe_events_correlation_id     ON probe_events(correlation_id);
CREATE INDEX idx_probe_events_event_type         ON probe_events(event_type);

-- ---------------------------------------------------------------------------
-- 9. probe_outbox — transactional outbox for async event consumers
-- ---------------------------------------------------------------------------
CREATE TABLE probe_outbox (
    id              TEXT PRIMARY KEY,
    event_id        TEXT NOT NULL REFERENCES probe_events(id),
    consumed_at     TEXT,
    consumer_id     TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_probe_outbox_event_id    ON probe_outbox(event_id);
CREATE INDEX idx_probe_outbox_consumed_at ON probe_outbox(consumed_at);

-- ---------------------------------------------------------------------------
-- 10. hourly_execution_rollups — cadence SLO rollups (expectation-based)
-- ---------------------------------------------------------------------------
CREATE TABLE hourly_execution_rollups (
    model_id            TEXT NOT NULL REFERENCES models(id),
    hour_at             TEXT NOT NULL,
    purpose             TEXT NOT NULL,
    tier                TEXT NOT NULL,
    nominal_expected    INTEGER NOT NULL DEFAULT 0,
    satisfied           INTEGER NOT NULL DEFAULT 0,
    suppressed          INTEGER NOT NULL DEFAULT 0,
    missed              INTEGER NOT NULL DEFAULT 0,
    cancelled           INTEGER NOT NULL DEFAULT 0,
    nominal_coverage    REAL,
    policy_adherence    REAL,
    dominant_reason     TEXT,
    PRIMARY KEY (model_id, hour_at, purpose)
);

CREATE INDEX idx_hourly_execution_rollups_hour_at ON hourly_execution_rollups(hour_at);

-- ---------------------------------------------------------------------------
-- 11. ALTER checks — add ledger and observation columns
-- ---------------------------------------------------------------------------
ALTER TABLE checks
    ADD COLUMN attempt_id           TEXT,
    ADD COLUMN observation_role     TEXT,
    ADD COLUMN retry_after_seconds  INTEGER,
    ADD COLUMN timeout_stage        TEXT,
    ADD COLUMN reason_code          TEXT,
    ADD COLUMN failure_domain       TEXT,
    ADD COLUMN region               TEXT,
    ADD COLUMN purpose              TEXT,
    ADD COLUMN ttft_ms              REAL;

-- Partial unique: one observation per role per attempt (post-cutover only)
CREATE UNIQUE INDEX idx_checks_attempt_observation_role
    ON checks(attempt_id, observation_role)
    WHERE attempt_id IS NOT NULL;

-- Index new columns for queries
CREATE INDEX idx_checks_attempt_id       ON checks(attempt_id);
CREATE INDEX idx_checks_observation_role ON checks(observation_role);
CREATE INDEX idx_checks_purpose         ON checks(purpose);

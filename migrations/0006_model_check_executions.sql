ALTER TABLE monitor_runs ADD COLUMN scheduled_at TEXT;
CREATE UNIQUE INDEX idx_monitor_runs_scheduled_at
  ON monitor_runs(scheduled_at) WHERE scheduled_at IS NOT NULL;

CREATE TABLE model_check_executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES monitor_runs(id),
  model_id TEXT NOT NULL REFERENCES models(id),
  tier TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL,
  scheduled_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  state TEXT NOT NULL DEFAULT 'SCHEDULED'
    CHECK (state IN ('SCHEDULED', 'RUNNING', 'COMPLETED', 'FAILED', 'DEFERRED', 'ABANDONED')),
  detail TEXT,
  UNIQUE (run_id, model_id)
);

CREATE INDEX idx_model_check_executions_model_time
  ON model_check_executions(model_id, scheduled_at DESC);
CREATE INDEX idx_model_check_executions_run_state
  ON model_check_executions(run_id, state);
CREATE UNIQUE INDEX idx_model_check_executions_model_scheduled
  ON model_check_executions(model_id, scheduled_at);

ALTER TABLE checks ADD COLUMN execution_id TEXT REFERENCES model_check_executions(id);
CREATE INDEX idx_checks_execution ON checks(execution_id);

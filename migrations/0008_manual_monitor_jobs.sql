CREATE TABLE monitor_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('MANUAL')),
  state TEXT NOT NULL CHECK (state IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
  run_id TEXT REFERENCES monitor_runs(id),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_monitor_jobs_one_active_manual
  ON monitor_jobs(kind) WHERE state IN ('QUEUED', 'RUNNING');
CREATE INDEX idx_monitor_jobs_queue ON monitor_jobs(kind, state, created_at);

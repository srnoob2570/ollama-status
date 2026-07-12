CREATE TABLE providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'ollama',
  base_url TEXT NOT NULL, secret_ref TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  catalog_status TEXT NOT NULL DEFAULT 'UNKNOWN', catalog_checked_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE models (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id), remote_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, excluded INTEGER NOT NULL DEFAULT 0, exclusion_reason TEXT,
  digest TEXT, details_json TEXT, last_show_at TEXT, next_check_at TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, UNIQUE(provider_id, remote_name)
);
CREATE TABLE checks (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id), model_id TEXT NOT NULL REFERENCES models(id),
  checked_at TEXT NOT NULL, classification TEXT NOT NULL, public_status TEXT NOT NULL,
  http_status INTEGER, total_duration_ms REAL, rtt_ms REAL, load_duration_ms REAL, error_code TEXT, error_hash TEXT
);
CREATE INDEX idx_checks_model_time ON checks(model_id, checked_at DESC);
CREATE TABLE model_current_status (
  model_id TEXT PRIMARY KEY REFERENCES models(id), public_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  classification TEXT NOT NULL DEFAULT 'UNKNOWN', consecutive_successes INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0, consecutive_high_latency INTEGER NOT NULL DEFAULT 0,
  last_check_at TEXT, last_latency_ms REAL, incident_id TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE incidents (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id), model_id TEXT NOT NULL REFERENCES models(id),
  kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN', started_at TEXT NOT NULL, resolved_at TEXT,
  summary TEXT NOT NULL, last_classification TEXT NOT NULL, external_confirmation_requested_at TEXT, external_confirmed_at TEXT
);
CREATE INDEX idx_incidents_model_status ON incidents(model_id, status, started_at DESC);
CREATE TABLE hourly_model_rollups (
  model_id TEXT NOT NULL REFERENCES models(id), hour_at TEXT NOT NULL, sample_count INTEGER NOT NULL,
  success_count INTEGER NOT NULL, avg_latency_ms REAL, p50_latency_ms REAL, p95_latency_ms REAL, PRIMARY KEY(model_id, hour_at)
);
CREATE TABLE scheduler_locks (name TEXT PRIMARY KEY, lease_until TEXT NOT NULL, owner TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE monitor_runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT, detail TEXT);
CREATE TABLE notification_deliveries (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), destination TEXT NOT NULL, event_type TEXT NOT NULL, delivered_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);
CREATE TABLE audit_log (id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, detail TEXT);
CREATE TABLE region_confirmations (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), nonce TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'PENDING', result_classification TEXT, received_at TEXT, expires_at TEXT NOT NULL);
CREATE TABLE admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

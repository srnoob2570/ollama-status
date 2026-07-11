-- The Ollama catalog is global. Existing paid-provider model rows are retained for
-- historical foreign keys but are no longer considered catalog entries.
ALTER TABLE models ADD COLUMN tier TEXT NOT NULL DEFAULT 'UNKNOWN';

CREATE TABLE IF NOT EXISTS provider_model_status (
  provider_id TEXT NOT NULL REFERENCES providers(id),
  model_id TEXT NOT NULL REFERENCES models(id),
  public_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  classification TEXT NOT NULL DEFAULT 'UNKNOWN',
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_high_latency INTEGER NOT NULL DEFAULT 0,
  last_check_at TEXT,
  last_latency_ms REAL,
  incident_id TEXT,
  next_check_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_provider_model_status_due ON provider_model_status(provider_id, next_check_at);
CREATE INDEX IF NOT EXISTS idx_checks_provider_model_time ON checks(provider_id, model_id, checked_at DESC);

UPDATE models
SET active = 0, exclusion_reason = 'legacy per-account duplicate; replaced by global catalog'
WHERE provider_id = 'ollama-paid';

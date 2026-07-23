-- Tracks whether the provider's secret_ref env var currently resolves to a non-empty key,
-- refreshed by the monitor scheduler each run. Lets the (secret-less) public status API report
-- whether paid probing is active without needing the key itself.
ALTER TABLE providers ADD COLUMN key_configured INTEGER NOT NULL DEFAULT 0;

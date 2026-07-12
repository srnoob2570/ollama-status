CREATE INDEX idx_models_due ON models(provider_id, active, excluded, next_check_at);
CREATE INDEX idx_monitor_runs_success_finished ON monitor_runs(outcome, finished_at DESC);

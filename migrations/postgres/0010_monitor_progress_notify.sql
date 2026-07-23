CREATE OR REPLACE FUNCTION notify_monitor_progress() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('monitor_progress', json_build_object(
    'id', NEW.id,
    'started_at', NEW.started_at,
    'finished_at', NEW.finished_at,
    'outcome', NEW.outcome,
    'detail', left(NEW.detail, 500),
    'phase', NEW.phase,
    'catalog_model_count', NEW.catalog_model_count,
    'scheduled_model_count', NEW.scheduled_model_count,
    'completed_model_count', NEW.completed_model_count,
    'free_probe_count', NEW.free_probe_count,
    'paid_probe_count', NEW.paid_probe_count,
    'paid_skipped_count', NEW.paid_skipped_count,
    'failed_probe_count', NEW.failed_probe_count,
    'current_model', NEW.current_model
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER monitor_runs_notify
AFTER INSERT OR UPDATE ON monitor_runs
FOR EACH ROW EXECUTE FUNCTION notify_monitor_progress();

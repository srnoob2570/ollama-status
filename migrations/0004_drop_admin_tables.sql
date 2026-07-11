-- Drop admin-only tables; administration surface (/admin, /api/admin/*) has been removed.
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS admin_settings;
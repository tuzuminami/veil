DROP INDEX IF EXISTS audit_events_tenant_request_idx;

ALTER TABLE outbox_events
  DROP COLUMN IF EXISTS request_id;

ALTER TABLE appeals
  DROP COLUMN IF EXISTS request_id;

ALTER TABLE audit_events
  DROP COLUMN IF EXISTS request_id;

ALTER TABLE decisions
  DROP COLUMN IF EXISTS request_id;

DELETE FROM veil_schema_migrations WHERE version = '003_request_identity.sql';

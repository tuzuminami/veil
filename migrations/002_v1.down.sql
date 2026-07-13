BEGIN;

DROP INDEX IF EXISTS audit_events_tenant_created_idx;
DROP INDEX IF EXISTS decisions_tenant_created_idx;
ALTER TABLE decisions DROP COLUMN IF EXISTS receipt_json;
ALTER TABLE idempotency_records DROP COLUMN IF EXISTS fingerprint;
DROP TABLE IF EXISTS active_policy_bindings;

DO $$
BEGIN
  IF to_regclass('veil_schema_migrations') IS NOT NULL THEN
    DELETE FROM veil_schema_migrations WHERE version = '002_v1.sql';
  END IF;
END $$;

COMMIT;

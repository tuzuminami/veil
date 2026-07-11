BEGIN;

DROP INDEX IF EXISTS audit_events_tenant_created_idx;
DROP INDEX IF EXISTS decisions_tenant_created_idx;
ALTER TABLE decisions DROP COLUMN IF EXISTS receipt_json;
ALTER TABLE idempotency_records DROP COLUMN IF EXISTS fingerprint;
DROP TABLE IF EXISTS active_policy_bindings;

COMMIT;

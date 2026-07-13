CREATE TABLE IF NOT EXISTS active_policy_bindings (
  tenant_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  version TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  activated_by TEXT NOT NULL,
  PRIMARY KEY (tenant_id, policy_id),
  FOREIGN KEY (tenant_id, policy_id, version) REFERENCES policy_versions (tenant_id, policy_id, version)
);

ALTER TABLE idempotency_records
  ADD COLUMN IF NOT EXISTS fingerprint TEXT;

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS receipt_json TEXT;

CREATE INDEX IF NOT EXISTS decisions_tenant_created_idx
  ON decisions (tenant_id, created_at DESC, decision_id);

CREATE INDEX IF NOT EXISTS audit_events_tenant_created_idx
  ON audit_events (tenant_id, created_at DESC, audit_id);

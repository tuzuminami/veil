CREATE TABLE IF NOT EXISTS policy_versions (
  tenant_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  bundle_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  published_at TEXT,
  PRIMARY KEY (tenant_id, policy_id, version)
);

CREATE TABLE IF NOT EXISTS decisions (
  tenant_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  version TEXT NOT NULL,
  action TEXT NOT NULL,
  reason_codes_json TEXT NOT NULL,
  obligations_json TEXT NOT NULL,
  matched_rule_id TEXT,
  input_hash TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'system',
  row_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, decision_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  tenant_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, audit_id)
);

CREATE TABLE IF NOT EXISTS appeals (
  tenant_id TEXT NOT NULL,
  appeal_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, appeal_id),
  FOREIGN KEY (tenant_id, decision_id) REFERENCES decisions (tenant_id, decision_id)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  published_at TEXT,
  PRIMARY KEY (tenant_id, event_id)
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);

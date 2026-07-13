ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS request_id TEXT;

ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS request_id TEXT;

ALTER TABLE appeals
  ADD COLUMN IF NOT EXISTS request_id TEXT;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS request_id TEXT;

CREATE INDEX IF NOT EXISTS audit_events_tenant_request_idx
  ON audit_events (tenant_id, request_id)
  WHERE request_id IS NOT NULL;

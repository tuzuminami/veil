import { Pool } from "pg";
import { VeilError } from "../core/errors.js";

export class PostgresVeilStore {
  constructor(poolOrOptions = {}) {
    this.pool = typeof poolOrOptions.query === "function" ? poolOrOptions : new Pool(poolOrOptions);
  }

  async getPolicyVersion(tenantId, policyId, version) {
    const result = await this.pool.query(
      "SELECT * FROM policy_versions WHERE tenant_id = $1 AND policy_id = $2 AND version = $3",
      [tenantId, policyId, version]
    );
    return result.rows[0] === undefined ? undefined : policyFromRow(result.rows[0]);
  }

  async getActivePolicyVersion(tenantId, policyId) {
    const result = await this.pool.query(
      "SELECT version FROM active_policy_bindings WHERE tenant_id = $1 AND policy_id = $2",
      [tenantId, policyId]
    );
    return result.rows[0]?.version;
  }

  async setActivePolicyVersion(tenantId, policyId, version, metadata = {}) {
    await upsertActivePolicyVersion(this.pool, tenantId, policyId, version, metadata);
  }

  async savePolicyVersion(policy) {
    await upsertPolicyVersion(this.pool, policy);
  }

  async saveDecision(decision) {
    await insertDecision(this.pool, decision);
  }

  async getDecision(tenantId, decisionId) {
    const result = await this.pool.query(
      "SELECT * FROM decisions WHERE tenant_id = $1 AND decision_id = $2",
      [tenantId, decisionId]
    );
    return result.rows[0] === undefined ? undefined : decisionFromRow(result.rows[0]);
  }

  async appendAudit(event) {
    await insertAudit(this.pool, event);
  }

  async appendOutbox(event) {
    await insertOutbox(this.pool, event);
  }

  async listAuditEvents(tenantId, { limit = 100, cursor } = {}) {
    const result = await this.pool.query(
      `SELECT * FROM audit_events
       WHERE tenant_id = $1
         AND ($2::text IS NULL OR created_at < $2 OR (created_at = $2 AND audit_id < $3))
       ORDER BY created_at DESC, audit_id DESC
       LIMIT $4`,
      [tenantId, cursor?.createdAt ?? null, cursor?.id ?? null, limit]
    );
    return result.rows.map(auditFromRow);
  }

  async getIdempotency(tenantId, key) {
    const result = await this.pool.query(
      "SELECT response_json, fingerprint FROM idempotency_records WHERE tenant_id = $1 AND idempotency_key = $2",
      [tenantId, key]
    );
    if (result.rows[0] === undefined) return undefined;
    const response = jsonFromColumn(result.rows[0].response_json);
    return result.rows[0].fingerprint === null ? { legacy: true, response } : { fingerprint: result.rows[0].fingerprint, response };
  }

  async setIdempotency(tenantId, key, value) {
    await upsertIdempotency(this.pool, tenantId, key, value);
  }

  async saveAppeal(appeal) {
    await insertAppeal(this.pool, appeal);
  }

  async getAppeal(tenantId, appealId) {
    const result = await this.pool.query(
      "SELECT * FROM appeals WHERE tenant_id = $1 AND appeal_id = $2",
      [tenantId, appealId]
    );
    return result.rows[0] === undefined ? undefined : appealFromRow(result.rows[0]);
  }

  async healthCheck() {
    const result = await this.pool.query(
      `SELECT
         to_regclass('policy_versions') IS NOT NULL
         AND to_regclass('decisions') IS NOT NULL
         AND to_regclass('active_policy_bindings') IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'decisions'
             AND column_name = 'receipt_json'
         ) AS ready`
    );
    if (result.rows[0]?.ready !== true) throw new Error("VEIL PostgreSQL schema is not ready");
    return true;
  }

  async close() {
    await this.pool.end();
  }

  async commitDecision({ decision, auditEvent, outboxEvent, idempotencyKey, idempotencyRecord }) {
    const tenantId = decision.tenantId;
    assertTenant(tenantId, auditEvent, "auditEvent");
    assertTenant(tenantId, outboxEvent, "outboxEvent");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reservation = await upsertIdempotency(client, tenantId, idempotencyKey, idempotencyRecord);
      if (!reservation.inserted) {
        await client.query("COMMIT");
        return reservation.response;
      }
      await insertDecision(client, decision);
      await insertAudit(client, auditEvent);
      await insertOutbox(client, outboxEvent);
      await client.query("COMMIT");
      return decision;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original write error; the client is still released below.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async commitPolicyPublish({ policy, auditEvent, idempotencyKey, idempotencyRecord }) {
    assertTenant(policy.tenantId, auditEvent, "auditEvent");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reservation = await upsertIdempotency(client, policy.tenantId, idempotencyKey, idempotencyRecord);
      if (!reservation.inserted) {
        await client.query("COMMIT");
        return reservation.response;
      }
      await upsertPolicyVersion(client, policy);
      await insertAudit(client, auditEvent);
      await client.query("COMMIT");
      return policy;
    } catch (error) {
      await rollbackPreservingOriginal(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async commitPolicyBinding({ tenantId, policyId, version, metadata, auditEvent }) {
    assertTenant(tenantId, auditEvent, "auditEvent");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await upsertActivePolicyVersion(client, tenantId, policyId, version, metadata);
      await insertAudit(client, auditEvent);
      await client.query("COMMIT");
    } catch (error) {
      await rollbackPreservingOriginal(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async commitAppeal({ appeal, auditEvent, outboxEvent, idempotencyKey, idempotencyRecord }) {
    assertTenant(appeal.tenantId, auditEvent, "auditEvent");
    assertTenant(appeal.tenantId, outboxEvent, "outboxEvent");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reservation = await upsertIdempotency(client, appeal.tenantId, idempotencyKey, idempotencyRecord);
      if (!reservation.inserted) {
        await client.query("COMMIT");
        return reservation.response;
      }
      await insertAppeal(client, appeal);
      await insertAudit(client, auditEvent);
      await insertOutbox(client, outboxEvent);
      await client.query("COMMIT");
      return appeal;
    } catch (error) {
      await rollbackPreservingOriginal(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function upsertPolicyVersion(client, policy) {
  const result = await client.query(
    `INSERT INTO policy_versions (
      tenant_id, policy_id, version, status, content_hash, bundle_json, created_at, created_by, updated_at, published_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (tenant_id, policy_id, version) DO UPDATE SET
      status = EXCLUDED.status,
      content_hash = EXCLUDED.content_hash,
      bundle_json = EXCLUDED.bundle_json,
      updated_at = EXCLUDED.updated_at,
      published_at = EXCLUDED.published_at,
      row_version = policy_versions.row_version + 1
    WHERE policy_versions.status <> 'published'
       OR (EXCLUDED.status = 'published' AND policy_versions.content_hash = EXCLUDED.content_hash)
    RETURNING *`,
    [
      policy.tenantId,
      policy.policyId,
      policy.version,
      policy.status,
      policy.contentHash,
      JSON.stringify(policy.bundle),
      policy.createdAt,
      policy.createdBy,
      policy.updatedAt ?? policy.createdAt,
      policy.publishedAt ?? null
    ]
  );
  if (result.rows.length === 0) throw new Error("published policy is immutable");
}

async function upsertActivePolicyVersion(client, tenantId, policyId, version, metadata = {}) {
  await client.query(
    `INSERT INTO active_policy_bindings (tenant_id, policy_id, version, activated_at, activated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, policy_id) DO UPDATE SET
       version = EXCLUDED.version,
       activated_at = EXCLUDED.activated_at,
       activated_by = EXCLUDED.activated_by`,
    [tenantId, policyId, version, metadata.activatedAt ?? new Date().toISOString(), metadata.actorId ?? "system"]
  );
}

async function rollbackPreservingOriginal(client) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original transaction error is more actionable.
  }
}

async function insertDecision(client, decision) {
  await client.query(
    `INSERT INTO decisions (
      tenant_id, decision_id, policy_id, version, action, reason_codes_json, obligations_json,
      matched_rule_id, input_hash, evidence_hash, correlation_id, created_at, created_by, receipt_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      decision.tenantId,
      decision.id,
      decision.policyId,
      decision.version,
      decision.action,
      JSON.stringify(decision.reasonCodes),
      JSON.stringify(decision.obligations),
      decision.matchedRuleId ?? null,
      decision.inputHash,
      decision.evidenceHash,
      decision.correlationId,
      decision.createdAt,
      decision.createdBy ?? "system",
      decision.receipt === undefined ? null : JSON.stringify(decision.receipt)
    ]
  );
}

async function insertAppeal(client, appeal) {
  await client.query(
    `INSERT INTO appeals (
      tenant_id, appeal_id, decision_id, status, reason, correlation_id, created_at, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [appeal.tenantId, appeal.id, appeal.decisionId, appeal.status, appeal.reason, appeal.correlationId, appeal.createdAt, appeal.createdBy]
  );
}

async function insertAudit(client, event) {
  await client.query(
    `INSERT INTO audit_events (
      tenant_id, audit_id, actor_id, action, resource_type, resource_id, correlation_id, reason, evidence_hash, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      event.tenantId,
      event.id,
      event.actorId,
      event.action,
      event.resourceType,
      event.resourceId,
      event.correlationId,
      event.reason,
      event.evidenceHash,
      event.createdAt
    ]
  );
}

async function insertOutbox(client, event) {
  await client.query(
    `INSERT INTO outbox_events (
      tenant_id, event_id, event_type, resource_id, correlation_id, payload_json, occurred_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [event.tenantId, event.id, event.eventType, event.resourceId, event.correlationId, JSON.stringify(event.payload), event.occurredAt]
  );
}

async function upsertIdempotency(client, tenantId, key, value) {
  const hasEnvelope = value?.fingerprint !== undefined && value?.response !== undefined;
  const fingerprint = hasEnvelope ? value.fingerprint : null;
  const response = hasEnvelope ? value.response : value;
  const inserted = await client.query(
    `INSERT INTO idempotency_records (tenant_id, idempotency_key, response_json, fingerprint, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING idempotency_key`,
    [tenantId, key, JSON.stringify(response), fingerprint, new Date().toISOString()]
  );
  if (inserted.rows?.length > 0) return { inserted: true, response };
  const existing = await client.query(
    "SELECT fingerprint, response_json FROM idempotency_records WHERE tenant_id = $1 AND idempotency_key = $2",
    [tenantId, key]
  );
  if (existing.rows[0]?.fingerprint !== fingerprint) {
    throw new VeilError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different request.", 409);
  }
  return { inserted: false, response: jsonFromColumn(existing.rows[0].response_json) };
}

function assertTenant(tenantId, value, name) {
  if (value?.tenantId !== tenantId) throw new Error(`${name} tenant does not match decision tenant`);
}

function jsonFromColumn(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function policyFromRow(row) {
  return {
    policyId: row.policy_id,
    tenantId: row.tenant_id,
    version: row.version,
    status: row.status,
    contentHash: row.content_hash,
    bundle: jsonFromColumn(row.bundle_json),
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    publishedAt: row.published_at ?? undefined
  };
}

function decisionFromRow(row) {
  return {
    id: row.decision_id,
    tenantId: row.tenant_id,
    policyId: row.policy_id,
    version: row.version,
    action: row.action,
    reasonCodes: jsonFromColumn(row.reason_codes_json),
    obligations: jsonFromColumn(row.obligations_json),
    matchedRuleId: row.matched_rule_id ?? undefined,
    inputHash: row.input_hash,
    evidenceHash: row.evidence_hash,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    createdBy: row.created_by,
    receipt: row.receipt_json === null || row.receipt_json === undefined ? undefined : jsonFromColumn(row.receipt_json)
  };
}

function auditFromRow(row) {
  return {
    id: row.audit_id,
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    correlationId: row.correlation_id,
    reason: row.reason,
    evidenceHash: row.evidence_hash,
    createdAt: row.created_at
  };
}

function appealFromRow(row) {
  return {
    id: row.appeal_id,
    tenantId: row.tenant_id,
    decisionId: row.decision_id,
    status: row.status,
    reason: row.reason,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    createdBy: row.created_by
  };
}

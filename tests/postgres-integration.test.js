import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { PostgresVeilStore } from "../src/adapters/postgres-store.js";
import { VeilService } from "../src/application/veil-service.js";
import { verifyDecisionReceipt } from "../src/core/receipt.js";

const databaseUrl = process.env.VEIL_TEST_DATABASE_URL;

test("PostgreSQL persists one atomic receipt for concurrent idempotent decisions", { skip: databaseUrl === undefined }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await pool.query(await readFile("migrations/001_init.sql", "utf8"));
    await pool.query(await readFile("migrations/002_v1.sql", "utf8"));
    await pool.query("TRUNCATE active_policy_bindings, appeals, outbox_events, audit_events, decisions, idempotency_records, policy_versions CASCADE");

    const store = new PostgresVeilStore(pool);
    assert.equal(await store.healthCheck(), true);
    const service = new VeilService(store);
    const context = {
      tenantId: "urn:tenant:integration",
      actorId: "integration-test",
      scopes: ["policy:write", "policy:read", "decision:write", "decision:context:assert", "decision:read", "appeal:write"],
      correlationId: "integration-correlation"
    };
    const bundle = {
      name: "integration-policy",
      version: "1.0.0",
      defaultAction: "BLOCK",
      rules: [{
        id: "allow-model",
        priority: 0,
        effect: "ALLOW",
        match: { field: "type", operator: "equals", value: "model_call" },
        reasonCode: "MODEL_ALLOWED"
      }]
    };
    await service.createDraft(context, "integration-policy", bundle);
    await service.publish(context, "integration-policy", "1.0.0", "publish-key");
    await service.bindActivePolicy(context, "integration-policy", "1.0.0");

    const request = {
      policyId: "integration-policy",
      input: {},
      type: "model_call",
      agent: { id: "agent-1" },
      resource: { id: "resource-1", type: "dataset", classification: "public" },
      dataClassification: "public",
      model: { provider: "test", id: "approved" },
      estimatedCost: 0.1,
      attributes: {}
    };
    const decisions = await Promise.all([
      service.createDecision(context, request, "concurrent-key"),
      service.createDecision(context, request, "concurrent-key")
    ]);

    assert.equal(decisions[0].id, decisions[1].id);
    assert.equal(verifyDecisionReceipt(decisions[0].receipt), true);
    const persisted = await service.getDecision(context, decisions[0].id);
    assert.deepEqual(persisted.receipt, decisions[0].receipt);
    assert.equal(await count(pool, "decisions"), 1);
    assert.equal(await count(pool, "idempotency_records"), 2);
    assert.equal(await countWhere(pool, "audit_events", "action = 'decision.created'"), 1);
    assert.equal(await store.getDecision("other-tenant", decisions[0].id), undefined);

    const appeal = await service.createAppeal(context, { decisionId: decisions[0].id, reason: "review" }, "appeal-key");
    assert.equal(appeal.tenantId, "urn:tenant:integration");
    assert.equal(await count(pool, "idempotency_records"), 3);

    await pool.query(
      `INSERT INTO decisions (
        tenant_id, decision_id, policy_id, version, action, reason_codes_json, obligations_json,
        input_hash, evidence_hash, correlation_id, created_at, created_by, receipt_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL)`,
      [context.tenantId, "legacy-decision", "integration-policy", "0.2.0", "BLOCK", "[]", "[]", "legacy-input", "legacy-evidence", "legacy-correlation", "2026-07-05T00:00:00.000Z", "legacy"]
    );
    const legacy = await service.getDecision(context, "legacy-decision");
    assert.equal(legacy.legacy, true);
    assert.equal(legacy.receipt, undefined);
  } finally {
    await pool.end();
  }
});

async function count(pool, table) {
  const result = await pool.query(`SELECT COUNT(*)::integer AS count FROM ${table}`);
  return result.rows[0].count;
}

async function countWhere(pool, table, condition) {
  const result = await pool.query(`SELECT COUNT(*)::integer AS count FROM ${table} WHERE ${condition}`);
  return result.rows[0].count;
}

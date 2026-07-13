import assert from "node:assert/strict";
import test from "node:test";
import { PostgresVeilStore } from "../src/adapters/postgres-store.js";

test("PostgresVeilStore parameterizes tenant-scoped reads and writes", async () => {
  const pool = new FakePool([{ rows: [decisionRow()] }, { rows: [] }]);
  const store = new PostgresVeilStore(pool);

  const decision = await store.getDecision("tenant-a", "decision-1");
  await store.saveAppeal(appeal());

  assert.equal(decision.id, "decision-1");
  assert.deepEqual(pool.queries[0], {
    text: "SELECT * FROM decisions WHERE tenant_id = $1 AND decision_id = $2",
    values: ["tenant-a", "decision-1"]
  });
  assert.match(pool.queries[1].text, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9\)/);
  assert.deepEqual(pool.queries[1].values, ["tenant-a", "appeal-1", "decision-1", "open", "reason", "server-request-1", "corr-1", "2026-07-11T00:00:00.000Z", "actor-1"]);
});

test("PostgresVeilStore scopes audit and idempotency records to their tenant", async () => {
  const pool = new FakePool([{ rows: [] }, { rows: [{ response_json: JSON.stringify({ id: "decision-1" }), fingerprint: "fingerprint-1" }] }]);
  const store = new PostgresVeilStore(pool);

  await store.listAuditEvents("tenant-a");
  const record = await store.getIdempotency("tenant-a", "tenant-a:decision:key-1");

  assert.match(pool.queries[0].text, /WHERE tenant_id = \$1/);
  assert.deepEqual(pool.queries[0].values, ["tenant-a", null, null, 100]);
  assert.match(pool.queries[1].text, /WHERE tenant_id = \$1 AND idempotency_key = \$2/);
  assert.deepEqual(pool.queries[1].values, ["tenant-a", "tenant-a:decision:key-1"]);
  assert.deepEqual(record, { fingerprint: "fingerprint-1", response: { id: "decision-1" } });
});

test("PostgresVeilStore marks fingerprint-less v0.2 idempotency records as legacy", async () => {
  const pool = new FakePool([{ rows: [{ response_json: JSON.stringify({ id: "legacy" }), fingerprint: null }] }]);
  const store = new PostgresVeilStore(pool);

  const record = await store.getIdempotency("urn:tenant:a", "urn:tenant:a:decision:key-1");

  assert.deepEqual(record, { legacy: true, response: { id: "legacy" } });
  assert.deepEqual(pool.queries[0].values, ["urn:tenant:a", "urn:tenant:a:decision:key-1"]);
});

test("PostgresVeilStore accepts colon-containing tenant IDs without parsing composite keys", async () => {
  const pool = new FakePool();
  const client = new FakeClient();
  pool.client = client;
  const store = new PostgresVeilStore(pool);
  const value = { ...decision(), tenantId: "urn:tenant:a" };
  const audit = { ...auditEvent(), tenantId: "urn:tenant:a" };
  const outbox = { ...outboxEvent(), tenantId: "urn:tenant:a" };

  const result = await store.commitDecision({
    decision: value,
    auditEvent: audit,
    outboxEvent: outbox,
    idempotencyKey: "urn:tenant:a:decision:key-1",
    idempotencyRecord: { fingerprint: "fingerprint-1", response: value }
  });

  assert.equal(result.tenantId, "urn:tenant:a");
  assert.deepEqual(client.queries[1].values.slice(0, 2), ["urn:tenant:a", "urn:tenant:a:decision:key-1"]);
});

test("PostgresVeilStore isolates active policy bindings by tenant", async () => {
  const pool = new FakePool([{ rows: [{ version: "2.0.0" }] }, { rows: [] }]);
  const store = new PostgresVeilStore(pool);

  assert.equal(await store.getActivePolicyVersion("tenant-a", "policy-1"), "2.0.0");
  await store.setActivePolicyVersion("tenant-a", "policy-1", "2.0.0");

  assert.deepEqual(pool.queries[0].values, ["tenant-a", "policy-1"]);
  assert.match(pool.queries[0].text, /WHERE tenant_id = \$1 AND policy_id = \$2/);
  assert.match(pool.queries[1].text, /ON CONFLICT \(tenant_id, policy_id\) DO UPDATE/);
  assert.deepEqual(pool.queries[1].values.slice(0, 3), ["tenant-a", "policy-1", "2.0.0"]);
});

test("commitDecision commits all writes on one client and releases it", async () => {
  const pool = new FakePool();
  const client = new FakeClient();
  pool.client = client;
  const store = new PostgresVeilStore(pool);

  const result = await store.commitDecision({
    decision: decision(),
    auditEvent: auditEvent(),
    idempotencyReplayAuditEvent: auditEvent(),
    outboxEvent: outboxEvent(),
    idempotencyKey: "tenant-a:decision:key-1",
    idempotencyRecord: { fingerprint: "fingerprint-1", response: { id: "decision-1" } }
  });

  assert.equal(result.id, "decision-1");
  assert.equal(pool.connectCalls, 1);
  assert.deepEqual(client.queries.map((query) => query.text), ["BEGIN", client.queries[1].text, client.queries[2].text, client.queries[3].text, client.queries[4].text, "COMMIT"]);
  assert.match(client.queries[1].text, /INSERT INTO idempotency_records/);
  assert.match(client.queries[2].text, /INSERT INTO decisions/);
  assert.match(client.queries[3].text, /INSERT INTO audit_events/);
  assert.match(client.queries[4].text, /INSERT INTO outbox_events/);
  assert.deepEqual(client.queries[2].values.slice(0, 2), ["tenant-a", "decision-1"]);
  assert.equal(client.released, true);
});

test("commitDecision rolls back and releases the client when a write fails", async () => {
  const pool = new FakePool();
  const client = new FakeClient({ failAt: 3 });
  pool.client = client;
  const store = new PostgresVeilStore(pool);

  await assert.rejects(
    store.commitDecision({
      decision: decision(),
      auditEvent: auditEvent(),
      outboxEvent: outboxEvent(),
      idempotencyKey: "tenant-a:decision:key-1",
      idempotencyRecord: { fingerprint: "fingerprint-1", response: { id: "decision-1" } }
    }),
    /fake query failure/
  );

  assert.equal(client.queries.at(-1).text, "ROLLBACK");
  assert.equal(client.released, true);
});

test("commitDecision returns the reserved response without duplicate evidence writes", async () => {
  const pool = new FakePool();
  const client = new FakeClient({ existingIdempotency: { fingerprint: "fingerprint-1", response: { id: "original-decision" } } });
  pool.client = client;
  const store = new PostgresVeilStore(pool);

  const result = await store.commitDecision({
    decision: decision(),
    auditEvent: auditEvent(),
    outboxEvent: outboxEvent(),
    idempotencyKey: "tenant-a:decision:key-1",
    idempotencyRecord: { fingerprint: "fingerprint-1", response: { id: "decision-1" } }
  });

  assert.deepEqual(result, { id: "original-decision" });
  assert.equal(client.queries.some((query) => query.text.includes("INSERT INTO decisions")), false);
  assert.equal(client.queries.at(-1).text, "COMMIT");
  assert.equal(client.released, true);
});

test("healthCheck and close delegate to the pool", async () => {
  const pool = new FakePool([{ rows: [{ ready: true }] }]);
  const store = new PostgresVeilStore(pool);

  assert.equal(await store.healthCheck(), true);
  await store.close();

  assert.match(pool.queries[0].text, /active_policy_bindings/);
  assert.equal(pool.ended, true);
});

test("healthCheck fails closed when the v1 database schema is incomplete", async () => {
  const store = new PostgresVeilStore(new FakePool([{ rows: [{ ready: false }] }]));
  await assert.rejects(store.healthCheck(), /schema is not ready/);
});

test("policy publication reserves idempotency and writes policy plus audit atomically", async () => {
  const pool = new FakePool();
  const client = new FakeClient();
  pool.client = client;
  const store = new PostgresVeilStore(pool);
  const policy = policyVersion();

  const result = await store.commitPolicyPublish({
    policy,
    auditEvent: auditEvent(),
    idempotencyKey: "tenant-a:publish:key-1",
    idempotencyRecord: { fingerprint: "publish-fingerprint", response: policy }
  });

  assert.equal(result.version, "1.0.0");
  assert.match(client.queries[1].text, /INSERT INTO idempotency_records/);
  assert.match(client.queries[2].text, /INSERT INTO policy_versions/);
  assert.match(client.queries[3].text, /INSERT INTO audit_events/);
  assert.equal(client.queries.at(-1).text, "COMMIT");
});

test("active policy binding and audit commit in one transaction", async () => {
  const pool = new FakePool();
  const client = new FakeClient();
  pool.client = client;
  const store = new PostgresVeilStore(pool);

  await store.commitPolicyBinding({
    tenantId: "tenant-a",
    policyId: "policy-1",
    version: "1.0.0",
    metadata: { actorId: "actor-1", activatedAt: "2026-07-11T00:00:00.000Z" },
    auditEvent: auditEvent()
  });

  assert.match(client.queries[1].text, /INSERT INTO active_policy_bindings/);
  assert.match(client.queries[2].text, /INSERT INTO audit_events/);
  assert.equal(client.queries.at(-1).text, "COMMIT");
});

class FakePool {
  constructor(results = []) {
    this.results = results;
    this.queries = [];
    this.connectCalls = 0;
    this.ended = false;
  }

  async query(text, values) {
    this.queries.push({ text, values });
    return this.results.shift() ?? { rows: [] };
  }

  async connect() {
    this.connectCalls += 1;
    return this.client;
  }

  async end() {
    this.ended = true;
  }
}

class FakeClient {
  constructor({ failAt, existingIdempotency } = {}) {
    this.failAt = failAt;
    this.existingIdempotency = existingIdempotency;
    this.queries = [];
    this.released = false;
  }

  async query(text, values) {
    this.queries.push({ text, values });
    if (this.queries.length === this.failAt) throw new Error("fake query failure");
    if (text.includes("INSERT INTO idempotency_records")) {
      return { rows: this.existingIdempotency === undefined ? [{ idempotency_key: "key-1" }] : [] };
    }
    if (text.includes("SELECT fingerprint, response_json FROM idempotency_records")) {
      return { rows: [{ fingerprint: this.existingIdempotency.fingerprint, response_json: JSON.stringify(this.existingIdempotency.response) }] };
    }
    if (text.includes("INSERT INTO policy_versions")) return { rows: [{}] };
    return { rows: [] };
  }

  release() {
    this.released = true;
  }
}

function decision() {
  return {
    id: "decision-1",
    tenantId: "tenant-a",
    policyId: "policy-1",
    version: "1.0.0",
    action: "allow",
    reasonCodes: ["allowed"],
    obligations: [],
    inputHash: "input-hash",
    evidenceHash: "evidence-hash",
    requestId: "server-request-1",
    correlationId: "corr-1",
    createdAt: "2026-07-11T00:00:00.000Z"
  };
}

function decisionRow() {
  return {
    decision_id: "decision-1",
    tenant_id: "tenant-a",
    policy_id: "policy-1",
    version: "1.0.0",
    action: "allow",
    reason_codes_json: "[\"allowed\"]",
    obligations_json: "[]",
    matched_rule_id: null,
    input_hash: "input-hash",
    evidence_hash: "evidence-hash",
    request_id: "server-request-1",
    correlation_id: "corr-1",
    created_at: "2026-07-11T00:00:00.000Z",
    created_by: "system"
  };
}

function auditEvent() {
  return {
    id: "audit-1",
    tenantId: "tenant-a",
    actorId: "actor-1",
    action: "decision.created",
    resourceType: "decision",
    resourceId: "decision-1",
    requestId: "server-request-1",
    correlationId: "corr-1",
    reason: "allowed",
    evidenceHash: "evidence-hash",
    createdAt: "2026-07-11T00:00:00.000Z"
  };
}

function outboxEvent() {
  return {
    id: "outbox-1",
    tenantId: "tenant-a",
    eventType: "veil.decision.created.v1",
    resourceId: "decision-1",
    requestId: "server-request-1",
    correlationId: "corr-1",
    payload: { action: "allow" },
    occurredAt: "2026-07-11T00:00:00.000Z"
  };
}

function appeal() {
  return {
    id: "appeal-1",
    tenantId: "tenant-a",
    decisionId: "decision-1",
    status: "open",
    reason: "reason",
    requestId: "server-request-1",
    correlationId: "corr-1",
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "actor-1"
  };
}

function policyVersion() {
  return {
    tenantId: "tenant-a",
    policyId: "policy-1",
    version: "1.0.0",
    status: "published",
    contentHash: "policy-hash",
    bundle: { name: "policy", version: "1.0.0", defaultAction: "BLOCK", rules: [] },
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "actor-1",
    publishedAt: "2026-07-11T00:00:00.000Z"
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { FileVeilStore } from "../src/adapters/file-store.js";
import { VeilService } from "../src/application/veil-service.js";
import { VeilError } from "../src/core/errors.js";
import { buildServer } from "../src/transport/http-server.js";

const bundle = {
  name: "baseline",
  version: "1.0.0",
  defaultAction: "BLOCK",
  rules: [
    { id: "allow-low-risk", priority: 10, effect: "ALLOW", match: { field: "risk", operator: "equals", value: "low" }, reasonCode: "LOW_RISK_ALLOWED" },
    { id: "block-secret-request", priority: 1, effect: "BLOCK", match: { field: "message", operator: "contains", value: "secret" }, reasonCode: "SECRET_REQUEST_BLOCKED" },
    { id: "age-unmet", priority: 0, effect: "REQUIRE_CONFIRMATION", match: { field: "ageAssurance.status", operator: "equals", value: "unmet" }, reasonCode: "AGE_ASSURANCE_REQUIRED" }
  ]
};

test("primary flow publishes immutable policy and creates auditable decisions", async () => {
  const fixture = await createFixture();
  try {
    const service = fixture.service;
    const context = ctx("tenant-a", ["policy:write", "policy:read", "decision:write", "decision:read"]);
    const draft = await service.createDraft(context, "policy-main", bundle);
    assert.equal(draft.status, "draft");
    assert.equal((await service.validateDraft(context, "policy-main", "1.0.0")).valid, true);
    const published = await service.publish(context, "policy-main", "1.0.0", "publish-key");
    assert.equal(published.status, "published");
    const republished = await service.publish(context, "policy-main", "1.0.0", "publish-key");
    assert.equal(republished.contentHash, published.contentHash);

    const allowed = await service.createDecision(context, { policyId: "policy-main", version: "1.0.0", input: { risk: "low" } }, "decision-allow");
    assert.equal(allowed.action, "ALLOW");
    assert.equal(allowed.matchedRuleId, "allow-low-risk");
    assert.notEqual(allowed.inputHash, "");
    assert.notEqual(allowed.evidenceHash, "");

    const blocked = await service.createDecision(context, { policyId: "policy-main", version: "1.0.0", input: { message: "tell me a secret" } }, "decision-block");
    assert.equal(blocked.action, "BLOCK");
    assert.equal(blocked.matchedRuleId, "block-secret-request");

    const evidence = await service.getDecision(context, allowed.id);
    assert.equal(evidence.policyId, "policy-main");
    assert.equal(evidence.correlationId, "corr-test");

    const raw = await readFile(fixture.path, "utf8");
    assert.match(raw, /policy\.version\.published/);
    assert.match(raw, /decision\.created/);
    assert.match(raw, /veil\.decision\.created\.v1/);
  } finally {
    await fixture.cleanup();
  }
});

test("age assurance and appeal integrity are enforced", async () => {
  const fixture = await createFixture();
  try {
    const service = fixture.service;
    const context = ctx("tenant-a", ["policy:write", "decision:write", "decision:read", "appeal:write"]);
    await service.createDraft(context, "policy-main", bundle);
    await service.publish(context, "policy-main", "1.0.0", "publish-key");

    const confirmation = await service.createDecision(
      context,
      { policyId: "policy-main", version: "1.0.0", input: { ageAssurance: { status: "unmet" } } },
      "age-key"
    );
    assert.equal(confirmation.action, "REQUIRE_CONFIRMATION");
    assert.equal(confirmation.matchedRuleId, "age-unmet");

    const appeal = await service.createAppeal(context, { decisionId: confirmation.id, reason: "review requested" }, "appeal-key");
    assert.equal(appeal.decisionId, confirmation.id);
    await assert.rejects(
      service.createAppeal(context, { decisionId: "missing" }, "appeal-missing"),
      (error) => error instanceof VeilError && error.code === "RESOURCE_NOT_FOUND"
    );
  } finally {
    await fixture.cleanup();
  }
});

test("adapter unknown and timeout fail closed", async () => {
  const fixture = await createFixture();
  try {
    const service = fixture.service;
    const context = ctx("tenant-a", ["policy:write", "decision:write"]);
    await service.createDraft(context, "policy-main", bundle);
    await service.publish(context, "policy-main", "1.0.0", "publish-key");

    const unknown = await service.createDecision(
      context,
      { policyId: "policy-main", version: "1.0.0", input: { risk: "low" }, adapterResult: { status: "unknown", source: "classifier" } },
      "unknown-key"
    );
    assert.equal(unknown.action, "BLOCK");
    assert.deepEqual(unknown.reasonCodes, ["ADAPTER_UNKNOWN_FAIL_CLOSED"]);

    const timeout = await service.createDecision(
      context,
      { policyId: "policy-main", version: "1.0.0", input: { risk: "low" }, adapterResult: { status: "timeout", source: "classifier" } },
      "timeout-key"
    );
    assert.equal(timeout.action, "ESCALATE");
    assert.deepEqual(timeout.reasonCodes, ["ADAPTER_TIMEOUT_FAIL_CLOSED"]);
  } finally {
    await fixture.cleanup();
  }
});

test("ambiguous classifier output fails closed before rule allow", async () => {
  const fixture = await createFixture();
  try {
    const service = fixture.service;
    const context = ctx("tenant-a", ["policy:write", "decision:write"]);
    await service.createDraft(context, "policy-main", bundle);
    await service.publish(context, "policy-main", "1.0.0", "publish-key");

    const ambiguous = await service.createDecision(
      context,
      { policyId: "policy-main", version: "1.0.0", input: { risk: "low" }, adapterResult: { status: "ok", source: "classifier" } },
      "ambiguous-key"
    );

    assert.equal(ambiguous.action, "BLOCK");
    assert.deepEqual(ambiguous.reasonCodes, ["ADAPTER_AMBIGUOUS_FAIL_CLOSED"]);
    assert.equal(ambiguous.matchedRuleId, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("malformed policy fails validation", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      fixture.service.createDraft(ctx("tenant-a", ["policy:write"]), "bad-policy", { ...bundle, defaultAction: "ALLOW" }),
      (error) => error instanceof VeilError && error.code === "VALIDATION_FAILED" && error.details.includes("defaultAction must be BLOCK or ESCALATE")
    );
  } finally {
    await fixture.cleanup();
  }
});

test("missing and unpublished policy states do not create decisions", async () => {
  const fixture = await createFixture();
  try {
    const service = fixture.service;
    const context = ctx("tenant-a", ["policy:write", "decision:write"]);

    await assert.rejects(
      service.createDecision(context, { policyId: "missing", version: "1.0.0", input: { risk: "low" } }, "missing-key"),
      (error) => error instanceof VeilError && error.code === "RESOURCE_NOT_FOUND"
    );

    await service.createDraft(context, "draft-only", bundle);
    await assert.rejects(
      service.createDecision(context, { policyId: "draft-only", version: "1.0.0", input: { risk: "low" } }, "draft-key"),
      (error) => error instanceof VeilError && error.code === "VALIDATION_FAILED" && error.message === "Policy version is not published."
    );
  } finally {
    await fixture.cleanup();
  }
});

test("default action is BLOCK when no rule matches", async () => {
  const fixture = await createFixture();
  try {
    const service = fixture.service;
    const context = ctx("tenant-a", ["policy:write", "decision:write"]);
    await service.createDraft(context, "policy-main", bundle);
    await service.publish(context, "policy-main", "1.0.0", "publish-key");

    const decision = await service.createDecision(context, { policyId: "policy-main", version: "1.0.0", input: { risk: "medium" } }, "default-block");

    assert.equal(decision.action, "BLOCK");
    assert.deepEqual(decision.reasonCodes, ["NO_MATCH_FAIL_CLOSED"]);
    assert.equal(decision.matchedRuleId, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("tenant and scope boundaries deny access", async () => {
  const fixture = await createFixture();
  try {
    const service = fixture.service;
    await service.createDraft(ctx("tenant-a", ["policy:write"]), "policy-main", bundle);
    await service.publish(ctx("tenant-a", ["policy:write"]), "policy-main", "1.0.0", "publish-key");

    await assert.rejects(
      service.createDecision(ctx("tenant-b", ["decision:write"]), { policyId: "policy-main", version: "1.0.0", input: { risk: "low" } }, "key"),
      (error) => error instanceof VeilError && error.code === "RESOURCE_NOT_FOUND"
    );
    await assert.rejects(
      service.createDecision(ctx("tenant-a", []), { policyId: "policy-main", version: "1.0.0", input: { risk: "low" } }, "key"),
      (error) => error instanceof VeilError && error.code === "TENANT_SCOPE_DENIED"
    );
  } finally {
    await fixture.cleanup();
  }
});

test("decision idempotency returns the original result", async () => {
  const fixture = await createFixture();
  try {
    const service = fixture.service;
    const context = ctx("tenant-a", ["policy:write", "decision:write"]);
    await service.createDraft(context, "policy-main", bundle);
    await service.publish(context, "policy-main", "1.0.0", "publish-key");
    const first = await service.createDecision(context, { policyId: "policy-main", version: "1.0.0", input: { risk: "low" } }, "same-key");
    const second = await service.createDecision(context, { policyId: "policy-main", version: "1.0.0", input: { message: "secret" } }, "same-key");
    assert.equal(second.id, first.id);
    assert.equal(second.action, "ALLOW");
  } finally {
    await fixture.cleanup();
  }
});

test("audit evidence records policy version and matched rule without raw input", async () => {
  const fixture = await createFixture();
  try {
    const service = fixture.service;
    const context = ctx("tenant-a", ["policy:write", "decision:write"]);
    await service.createDraft(context, "policy-main", bundle);
    await service.publish(context, "policy-main", "1.0.0", "publish-key");
    const decision = await service.createDecision(context, { policyId: "policy-main", version: "1.0.0", input: { risk: "low" } }, "audit-key");
    const raw = JSON.parse(await readFile(fixture.path, "utf8"));
    const decisionAudit = raw.auditEvents.find((event) => event.action === "decision.created" && event.resourceId === decision.id);

    assert.equal(decision.policyId, "policy-main");
    assert.equal(decision.version, "1.0.0");
    assert.equal(decision.matchedRuleId, "allow-low-risk");
    assert.equal(decisionAudit.evidenceHash, decision.evidenceHash);
    assert.equal(raw.decisions[0].inputHash, decision.inputHash);
    assert.doesNotMatch(JSON.stringify(raw.auditEvents), /"risk":"low"/);
  } finally {
    await fixture.cleanup();
  }
});

test("HTTP boundary returns validation error for malformed JSON", async () => {
  const fixture = await createFixture();
  const server = buildServer(fixture.path);
  try {
    const response = await dispatch(server, {
      method: "POST",
      url: "/v1/policies",
      headers: {
        authorization: "Bearer dev:tenant-a:tester:policy:write",
        "x-tenant-id": "tenant-a",
        "content-type": "application/json"
      },
      body: "{"
    });

    assert.equal(response.status, 422);
    const payload = JSON.parse(response.body);
    assert.equal(payload.error.code, "VALIDATION_FAILED");
    assert.equal(payload.error.message, "JSON body is malformed.");
  } finally {
    await fixture.cleanup();
  }
});

function ctx(tenantId, scopes) {
  return { tenantId, actorId: "tester", scopes, correlationId: "corr-test" };
}

async function createFixture() {
  const dir = await mkdtemp(join(tmpdir(), "veil-test-"));
  const path = join(dir, "store.json");
  return {
    path,
    service: new VeilService(new FileVeilStore(path), { now: () => new Date("2026-01-01T00:00:00.000Z") }, deterministicId()),
    cleanup: async () => rm(dir, { recursive: true, force: true })
  };
}

function dispatch(server, { method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const request = Readable.from(body === undefined ? [] : [body]);
    request.method = method;
    request.url = url;
    request.headers = headers;
    const response = {
      status: undefined,
      headers: undefined,
      writeHead(status, responseHeaders) {
        this.status = status;
        this.headers = responseHeaders;
      },
      end(responseBody) {
        resolve({ status: this.status, headers: this.headers, body: responseBody });
      }
    };
    server.emit("request", request, response);
    request.once("error", reject);
  });
}

function deterministicId() {
  let counter = 0;
  return () => {
    counter += 1;
    return `id-${counter}`;
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { generateKeyPairSync } from "node:crypto";
import { importJWK, jwtVerify } from "jose";
import { FileVeilStore } from "../src/adapters/file-store.js";
import { VeilService, computeDecisionInputHash, ENFORCEMENT_INPUT_HASH_VERSION } from "../src/application/veil-service.js";
import { VeilError } from "../src/core/errors.js";
import { verifyDecisionReceipt } from "../src/core/receipt.js";
import { createEnforcementTokenSigner } from "../src/core/enforcement-token.js";
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

test("typed model and tool pre-execution requests produce policy decisions", async () => {
  const fixture = await createFixture();
  try {
    const context = ctx("tenant-a", ["policy:write", "decision:write"]);
    await fixture.service.createDraft(context, "policy-main", bundle);
    await fixture.service.publish(context, "policy-main", "1.0.0", "publish-key");

    const modelDecision = await fixture.service.createDecision(context, typedRequest("model_call", { risk: "low" }), "model-call");
    const toolDecision = await fixture.service.createDecision(context, typedRequest("tool_call", { message: "request secret" }), "tool-call");

    assert.equal(modelDecision.action, "ALLOW");
    assert.equal(toolDecision.action, "BLOCK");
  } finally {
    await fixture.cleanup();
  }
});

test("typed policy rules evaluate canonical AI attributes and numeric cost ceilings", async () => {
  const fixture = await createFixture();
  try {
    const context = ctx("tenant-a", ["policy:write", "decision:write"]);
    const costPolicy = {
      name: "cost-policy",
      version: "1.0.0",
      defaultAction: "BLOCK",
      rules: [{
        id: "cost-ceiling",
        priority: 0,
        effect: "BLOCK",
        match: { field: "estimatedCost", operator: "greaterThan", value: 1 },
        reasonCode: "COST_CEILING_EXCEEDED"
      }]
    };
    await fixture.service.createDraft(context, "cost-policy", costPolicy);
    await fixture.service.publish(context, "cost-policy", "1.0.0", "publish-cost");

    const decision = await fixture.service.createDecision(
      context,
      { ...typedRequest("model_call", {}), policyId: "cost-policy", estimatedCost: 2 },
      "cost-decision"
    );

    assert.equal(decision.action, "BLOCK");
    assert.deepEqual(decision.reasonCodes, ["COST_CEILING_EXCEEDED"]);
  } finally {
    await fixture.cleanup();
  }
});

test("malformed pre-execution requests fail closed at the service boundary", async () => {
  const fixture = await createFixture();
  try {
    const context = ctx("tenant-a", ["decision:write"]);
    await assert.rejects(
      fixture.service.createDecision(context, { policyId: "policy-main", input: {}, type: "model_call" }, "invalid-contract"),
      (error) => error instanceof VeilError && error.code === "VALIDATION_FAILED" && error.details.includes("agent.id is required")
    );
    await assert.rejects(
      fixture.service.createDecision(context, { policyId: "policy-main", version: "1.0.0", input: [], type: "other" }, "invalid-type"),
      (error) => error instanceof VeilError && error.code === "VALIDATION_FAILED" && error.details.includes("type must be model_call or tool_call")
    );
    await assert.rejects(
      fixture.service.createDecision(context, { ...typedRequest("tool_call", {}), dataClassification: "unclassified" }, "invalid-classification"),
      (error) => error instanceof VeilError && error.code === "VALIDATION_FAILED" && error.details.includes("dataClassification must be public, internal, confidential, or restricted")
    );
  } finally {
    await fixture.cleanup();
  }
});

test("typed decision context requires a trusted PEP assertion scope", async () => {
  const fixture = await createFixture();
  try {
    const untrusted = { tenantId: "tenant-a", actorId: "direct-agent", scopes: ["decision:write"], correlationId: "corr-untrusted" };
    await assert.rejects(
      fixture.service.createDecision(untrusted, typedRequest("model_call", {}), "untrusted-context"),
      (error) => error instanceof VeilError && error.code === "TENANT_SCOPE_DENIED" && error.status === 403
    );
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

test("policy paths reject prototype traversal segments", async () => {
  const fixture = await createFixture();
  try {
    const unsafe = {
      ...bundle,
      rules: [{ ...bundle.rules[0], match: { field: "constructor.prototype.allowed", operator: "equals", value: "yes" } }]
    };
    await assert.rejects(
      fixture.service.createDraft(ctx("tenant-a", ["policy:write"]), "unsafe-policy", unsafe),
      (error) => error instanceof VeilError && error.details.some((detail) => detail.includes("unsafe path segment"))
    );
  } finally {
    await fixture.cleanup();
  }
});

test("public JSON Schemas are enforced at the application boundary", async () => {
  const fixture = await createFixture();
  try {
    const invalid = {
      ...bundle,
      rules: [{ ...bundle.rules[0], obligations: [1] }]
    };
    await assert.rejects(
      fixture.service.createDraft(ctx("tenant-a", ["policy:write"]), "schema-invalid", invalid),
      (error) => error instanceof VeilError
        && error.code === "VALIDATION_FAILED"
        && error.message === "Policy bundle does not match the public JSON Schema."
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

test("decision idempotency returns the original result for the same request", async () => {
  const fixture = await createFixture();
  try {
    const service = fixture.service;
    const context = ctx("tenant-a", ["policy:write", "decision:write"]);
    await service.createDraft(context, "policy-main", bundle);
    await service.publish(context, "policy-main", "1.0.0", "publish-key");
    const request = { policyId: "policy-main", version: "1.0.0", input: { risk: "low" } };
    const first = await service.createDecision(context, request, "same-key");
    const second = await service.createDecision(context, request, "same-key");
    assert.equal(second.id, first.id);
    assert.equal(second.action, "ALLOW");
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent file-store decisions return the single persisted idempotent response", async () => {
  const fixture = await createFixture();
  try {
    const context = ctx("tenant-a", ["policy:write", "decision:write"]);
    await fixture.service.createDraft(context, "policy-main", bundle);
    await fixture.service.publish(context, "policy-main", "1.0.0", "publish-key");
    const request = { policyId: "policy-main", version: "1.0.0", input: { risk: "low" } };

    const decisions = await Promise.all([
      fixture.service.createDecision(context, request, "concurrent-key"),
      fixture.service.createDecision(context, request, "concurrent-key")
    ]);
    const raw = JSON.parse(await readFile(fixture.path, "utf8"));

    assert.equal(decisions[0].id, decisions[1].id);
    assert.equal(raw.decisions.length, 1);
    assert.equal(raw.auditEvents.filter((event) => event.action === "decision.created").length, 1);
    assert.equal(raw.outboxEvents.filter((event) => event.eventType === "veil.decision.created.v1").length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("file-store updates are serialized across instances sharing one path", async () => {
  const fixture = await createFixture();
  try {
    const context = ctx("tenant-a", ["policy:write", "decision:write", "decision:read"]);
    await fixture.service.createDraft(context, "policy-main", bundle);
    await fixture.service.publish(context, "policy-main", "1.0.0", "publish-key");
    const secondService = new VeilService(new FileVeilStore(fixture.path));
    const request = { policyId: "policy-main", version: "1.0.0", input: { risk: "low" } };

    const decisions = await Promise.all([
      fixture.service.createDecision(context, request, "shared-path-key"),
      secondService.createDecision(context, request, "shared-path-key")
    ]);
    const raw = JSON.parse(await readFile(fixture.path, "utf8"));

    assert.equal(decisions[0].id, decisions[1].id);
    assert.equal(raw.decisions.length, 1);
    assert.equal(raw.idempotencyRecords.filter((record) => record.tenantId === "tenant-a" && record.key === "decision:shared-path-key").length, 1);
    assert.equal((await secondService.getDecision(context, decisions[0].id)).receipt.receiptHash, decisions[0].receipt.receiptHash);
  } finally {
    await fixture.cleanup();
  }
});

test("file-store updates share one queue across direct file symlink aliases", async () => {
  const fixture = await createFixture();
  const alias = `${fixture.path}-alias`;
  try {
    const context = ctx("tenant-a", ["policy:write", "decision:write", "decision:read"]);
    await fixture.service.createDraft(context, "policy-main", bundle);
    await fixture.service.publish(context, "policy-main", "1.0.0", "publish-key");
    await symlink(fixture.path, alias, "file");
    const aliasService = new VeilService(new FileVeilStore(alias));
    const request = { policyId: "policy-main", version: "1.0.0", input: { risk: "low" } };

    const decisions = await Promise.all([
      fixture.service.createDecision(context, request, "symlink-key"),
      aliasService.createDecision(context, request, "symlink-key")
    ]);
    const raw = JSON.parse(await readFile(fixture.path, "utf8"));
    assert.equal(decisions[0].id, decisions[1].id);
    assert.equal(raw.decisions.length, 1);
    assert.equal(raw.idempotencyRecords.filter((record) => record.key === "decision:symlink-key").length, 1);
    assert.equal((await lstat(alias)).isSymbolicLink(), true);
  } finally {
    await rm(alias, { force: true });
    await fixture.cleanup();
  }
});

test("file idempotency isolates colliding tenant and client-key tuples", async () => {
  const fixture = await createFixture();
  try {
    await fixture.store.setIdempotency("a:b", "decision:c", { fingerprint: "first", response: { id: "first" } });
    await fixture.store.setIdempotency("a", "decision:b:c", { fingerprint: "second", response: { id: "second" } });

    assert.equal((await fixture.store.getIdempotency("a:b", "decision:c")).response.id, "first");
    assert.equal((await fixture.store.getIdempotency("a", "decision:b:c")).response.id, "second");
  } finally {
    await fixture.cleanup();
  }
});

test("legacy file-store idempotency records fail closed instead of replaying without a fingerprint", async () => {
  const fixture = await createFixture();
  try {
    const context = ctx("tenant-a", ["decision:write"]);
    await fixture.store.update((data) => {
      data.idempotency["tenant-a:decision:legacy-key"] = { id: "legacy-response" };
    });

    await assert.rejects(
      fixture.service.createDecision(context, { policyId: "policy-main", version: "1.0.0", input: { risk: "low" } }, "legacy-key"),
      (error) => error instanceof VeilError && error.code === "IDEMPOTENCY_CONFLICT" && error.status === 409
    );
  } finally {
    await fixture.cleanup();
  }
});

test("published file-store policies reject concurrent reuse of one key for different operations", async () => {
  const fixture = await createFixture();
  try {
    const context = ctx("tenant-a", ["policy:write"]);
    await fixture.service.createDraft(context, "policy-a", bundle);
    await fixture.service.publish(context, "policy-a", "1.0.0", "publish-a");
    const secondBundle = { ...bundle, name: "second", version: "2.0.0" };
    await fixture.service.createDraft(context, "policy-b", secondBundle);
    await fixture.service.publish(context, "policy-b", "2.0.0", "publish-b");

    const results = await Promise.allSettled([
      fixture.service.publish(context, "policy-a", "1.0.0", "shared-key"),
      fixture.service.publish(context, "policy-b", "2.0.0", "shared-key")
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "IDEMPOTENCY_CONFLICT");
  } finally {
    await fixture.cleanup();
  }
});

test("idempotency rejects key reuse with different requests", async () => {
  const fixture = await createFixture();
  try {
    const service = fixture.service;
    const context = ctx("tenant-a", ["policy:write", "decision:write", "appeal:write"]);
    await service.createDraft(context, "policy-main", bundle);
    await service.publish(context, "policy-main", "1.0.0", "publish-key");
    const decision = await service.createDecision(context, { policyId: "policy-main", version: "1.0.0", input: { risk: "low" } }, "decision-key");

    await assert.rejects(
      service.createDecision(context, { policyId: "policy-main", version: "1.0.0", input: { message: "secret" } }, "decision-key"),
      (error) => error instanceof VeilError && error.code === "IDEMPOTENCY_CONFLICT" && error.status === 409
    );
    await service.createDraft(context, "policy-secondary", { ...bundle, name: "secondary", version: "2.0.0" });
    await assert.rejects(
      service.publish(context, "policy-secondary", "2.0.0", "publish-key"),
      (error) => error instanceof VeilError && error.code === "IDEMPOTENCY_CONFLICT" && error.status === 409
    );
    await assert.rejects(
      service.createAppeal(context, { decisionId: decision.id, reason: "first" }, "appeal-key").then(() =>
        service.createAppeal(context, { decisionId: decision.id, reason: "second" }, "appeal-key")
      ),
      (error) => error instanceof VeilError && error.code === "IDEMPOTENCY_CONFLICT" && error.status === 409
    );
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

test("decision receipts are deterministic and detect tampering", async () => {
  const fixture = await createFixture();
  try {
    const context = ctx("tenant-a", ["policy:write", "decision:write"]);
    await fixture.service.createDraft(context, "policy-main", bundle);
    await fixture.service.publish(context, "policy-main", "1.0.0", "publish-key");
    const decision = await fixture.service.createDecision(context, typedRequest("model_call", { risk: "low" }), "receipt-key");

    assert.equal(verifyDecisionReceipt(decision.receipt), true);
    assert.equal(verifyDecisionReceipt({ ...decision.receipt, action: "BLOCK" }), false);
    assert.equal(verifyDecisionReceipt({ ...decision.receipt, untrusted: "injected" }), false);
  } finally {
    await fixture.cleanup();
  }
});

test("ALLOW decisions issue verifiable short-lived EdDSA enforcement tokens while blocked decisions do not", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = createEnforcementTokenSigner({
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
    keyId: "veil-test-2026-01",
    issuer: "https://veil.example.test",
    audience: "relay",
    ttlSeconds: 60
  });
  const fixture = await createFixture(signer);
  try {
    const context = ctx("tenant-a", ["policy:write", "decision:write"]);
    await fixture.service.createDraft(context, "policy-main", bundle);
    await fixture.service.publish(context, "policy-main", "1.0.0", "publish-key");
    const allowed = await fixture.service.createDecision(context, typedRequest("model_call", { risk: "low" }), "allow-key");
    const blocked = await fixture.service.createDecision(context, { policyId: "policy-main", version: "1.0.0", input: { message: "secret" } }, "block-key");
    const key = await importJWK(signer.jwks().keys[0], "EdDSA");
    const verified = await jwtVerify(allowed.enforcementToken, key, {
      issuer: "https://veil.example.test",
      audience: "relay",
      algorithms: ["EdDSA"],
      currentDate: new Date("2026-01-01T00:00:30.000Z")
    });

    assert.equal(verified.protectedHeader.kid, "veil-test-2026-01");
    assert.equal(verified.payload.tenant_id, "tenant-a");
    assert.equal(verified.payload.action, "ALLOW");
    assert.equal(verified.payload.requested_action, "model_call");
    assert.equal(verified.payload.decision_id, allowed.id);
    assert.equal(verified.payload.input_hash, allowed.inputHash);
    assert.equal(verified.payload.policy_hash, allowed.receipt.policyHash);
    assert.equal(verified.payload.receipt_hash, allowed.receipt.receiptHash);
    assert.equal(verified.payload.jti, allowed.id);
    assert.equal(ENFORCEMENT_INPUT_HASH_VERSION, "veil-input-hash/1");
    assert.equal(computeDecisionInputHash(typedRequest("model_call", { risk: "low" })), allowed.inputHash);
    assert.equal(blocked.enforcementToken, undefined);
    const persisted = await readFile(fixture.path, "utf8");
    assert.doesNotMatch(persisted, /eyJ[A-Za-z0-9_-]+\./);
  } finally {
    await fixture.cleanup();
  }
});

test("active policy bindings resolve omitted versions and support rollback", async () => {
  const fixture = await createFixture();
  try {
    const context = ctx("tenant-a", ["policy:write", "decision:write"]);
    await fixture.service.createDraft(context, "policy-main", bundle);
    await fixture.service.publish(context, "policy-main", "1.0.0", "publish-v1");
    await fixture.service.createDraft(context, "policy-main", { ...bundle, version: "2.0.0", defaultAction: "ESCALATE" });
    await fixture.service.publish(context, "policy-main", "2.0.0", "publish-v2");

    await fixture.service.bindActivePolicy(context, "policy-main", "2.0.0");
    const bypassAttempt = await fixture.service.createDecision(context, typedRequest("model_call", { risk: "medium" }, "1.0.0"), "active-bypass-attempt");
    assert.equal(bypassAttempt.version, "2.0.0");
    assert.equal(bypassAttempt.action, "ESCALATE");
    const active = await fixture.service.createDecision(context, typedRequest("model_call", { risk: "medium" }, null), "active-v2");
    assert.equal(active.version, "2.0.0");
    assert.equal(active.action, "ESCALATE");

    await fixture.service.rollbackActivePolicy(context, "policy-main", "1.0.0");
    const rolledBack = await fixture.service.createDecision(context, typedRequest("tool_call", { risk: "low" }, null), "active-v1");
    assert.equal(rolledBack.version, "1.0.0");
    assert.equal(rolledBack.action, "ALLOW");
  } finally {
    await fixture.cleanup();
  }
});

test("file policy bindings isolate tenant and policy identifiers containing colons", async () => {
  const fixture = await createFixture();
  try {
    await fixture.store.setActivePolicyVersion("tenant:a", "policy", "1.0.0");
    await fixture.store.setActivePolicyVersion("tenant", "a:policy", "2.0.0");

    assert.equal(await fixture.store.getActivePolicyVersion("tenant:a", "policy"), "1.0.0");
    assert.equal(await fixture.store.getActivePolicyVersion("tenant", "a:policy"), "2.0.0");

    const raw = JSON.parse(await readFile(fixture.path, "utf8"));
    assert.equal(raw.activePolicyBindingRecords.length, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("file policy bindings read legacy flat binding files", async () => {
  const fixture = await createFixture();
  try {
    await fixture.store.update((data) => {
      data.activePolicyBindings["tenant-a:policy-main"] = { version: "0.2.0" };
    });

    assert.equal(await fixture.store.getActivePolicyVersion("tenant-a", "policy-main"), "0.2.0");
  } finally {
    await fixture.cleanup();
  }
});

test("ambiguous legacy flat policy bindings fail closed", async () => {
  const fixture = await createFixture();
  try {
    await fixture.store.update((data) => {
      data.activePolicyBindings["tenant:a:policy"] = { version: "0.2.0" };
    });

    await assert.rejects(
      fixture.store.getActivePolicyVersion("tenant:a", "policy"),
      (error) => error instanceof VeilError && error.code === "LEGACY_BINDING_AMBIGUOUS"
    );
    await assert.rejects(
      fixture.store.getActivePolicyVersion("tenant", "a:policy"),
      (error) => error instanceof VeilError && error.code === "LEGACY_BINDING_AMBIGUOUS"
    );
  } finally {
    await fixture.cleanup();
  }
});

test("audit events are tenant-scoped and cursor paginated", async () => {
  const fixture = await createFixture();
  try {
    const context = ctx("tenant-a", ["policy:write", "audit:read"]);
    await fixture.service.createDraft(context, "policy-main", bundle);
    await fixture.service.createDraft(context, "policy-secondary", { ...bundle, name: "secondary", version: "2.0.0" });

    const first = await fixture.service.listAuditEvents(context, { limit: 1 });
    const second = await fixture.service.listAuditEvents(context, { limit: 1, cursor: first.nextCursor });

    assert.equal(first.items.length, 1);
    assert.equal(second.items.length, 1);
    assert.notEqual(first.items[0].id, second.items[0].id);
    await assert.rejects(
      fixture.service.listAuditEvents(ctx("tenant-b", []), { limit: 1 }),
      (error) => error instanceof VeilError && error.code === "TENANT_SCOPE_DENIED"
    );
    await assert.rejects(
      fixture.service.listAuditEvents(context, { limit: 101 }),
      (error) => error instanceof VeilError && error.code === "VALIDATION_FAILED"
    );
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
  const trustedScopes = scopes.includes("decision:write") && !scopes.includes("decision:context:assert")
    ? [...scopes, "decision:context:assert"]
    : scopes;
  return { tenantId, actorId: "tester", scopes: trustedScopes, correlationId: "corr-test" };
}

async function createFixture(enforcementTokenSigner) {
  const dir = await mkdtemp(join(tmpdir(), "veil-test-"));
  const path = join(dir, "store.json");
  return {
    path,
    store: new FileVeilStore(path),
    get service() {
      return this._service ??= new VeilService(this.store, { now: () => new Date("2026-01-01T00:00:00.000Z") }, deterministicId(), enforcementTokenSigner);
    },
    cleanup: async () => rm(dir, { recursive: true, force: true })
  };
}

function typedRequest(type, input, version = "1.0.0") {
  return {
    policyId: "policy-main",
    ...(version == null ? {} : { version }),
    input,
    type,
    agent: { id: "support-agent" },
    resource: { id: type === "model_call" ? "chat-completion" : "crm.lookup", type: "ai-operation", classification: "internal" },
    dataClassification: "confidential",
    model: { provider: "openai", id: "gpt-5" },
    estimatedCost: 0.002,
    attributes: { purpose: "support" }
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

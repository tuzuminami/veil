import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt } from "jose";
import test from "node:test";
import { FileVeilStore } from "../src/adapters/file-store.js";
import { VeilService } from "../src/application/veil-service.js";
import { buildServer, computeAuthZenInputHash, createDevelopmentAuthenticator } from "../src/transport/http-server.js";
import { createEnforcementTokenSigner } from "../src/core/enforcement-token.js";

const policy = {
  name: "agent-baseline",
  version: "1.0.0",
  defaultAction: "BLOCK",
  rules: [
    {
      id: "block-expensive-actions",
      priority: 0,
      effect: "BLOCK",
      match: { field: "estimatedCost", operator: "greaterThan", value: 1 },
      reasonCode: "COST_CEILING_EXCEEDED"
    },
    {
      id: "allow-public-model-calls",
      priority: 10,
      effect: "ALLOW",
      match: { field: "type", operator: "equals", value: "model_call" },
      reasonCode: "PUBLIC_MODEL_CALL_ALLOWED"
    }
  ]
};

test("development auth preserves colon-delimited scope names", async () => {
  const context = await createDevelopmentAuthenticator().authenticate({
    authorization: "Bearer dev:tenant-a:pep:decision:write,decision:context:assert",
    tenantId: "tenant-a"
  });
  assert.deepEqual(context.scopes, ["decision:write", "decision:context:assert"]);
});

test("publishes the configured EdDSA enforcement JWKS without exposing the private key", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const { publicKey: previousPublicKey } = generateKeyPairSync("ed25519");
  const signer = createEnforcementTokenSigner({
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
    keyId: "veil-jwks-test",
    issuer: "https://veil.example.test",
    previousPublicJwks: [{ ...previousPublicKey.export({ format: "jwk" }), kid: "veil-jwks-previous" }]
  });
  const server = buildServer({ store: {}, service: {}, enforcementTokenSigner: signer });
  const response = await dispatch(server, { method: "GET", url: "/.well-known/jwks.json", headers: {}, body: undefined });
  const payload = JSON.parse(response.body);

  assert.equal(response.status, 200);
  assert.equal(payload.keys[0].kid, "veil-jwks-test");
  assert.equal(payload.keys[0].alg, "EdDSA");
  assert.equal(payload.keys[0].d, undefined);
  assert.equal(payload.keys[1].kid, "veil-jwks-previous");
  assert.equal(payload.keys[1].d, undefined);
  assert.match(response.headers["cache-control"], /max-age=300/);
});

test("AuthZEN returns an enforcement token only for an ALLOW decision", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = createEnforcementTokenSigner({
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
    keyId: "veil-authzen-test",
    issuer: "https://veil.example.test"
  });
  const fixture = await createFixture(signer);
  try {
    const request = {
      subject: { type: "agent", id: "agent-1" },
      action: { name: "model_call" },
      resource: { type: "dataset", id: "public-docs", properties: { classification: "public" } },
      context: { model: { provider: "openai", id: "gpt" }, estimatedCost: 0.1 }
    };
    const response = await dispatch(fixture.server, {
      method: "POST",
      url: "/access/v1/evaluation",
      headers: headers(),
      body: JSON.stringify(request)
    });
    const payload = JSON.parse(response.body);
    assert.equal(response.status, 200);
    assert.equal(typeof payload.context.veil.enforcementToken, "string");
    assert.equal(decodeJwt(payload.context.veil.enforcementToken).input_hash, computeAuthZenInputHash(request, "policy-main"));
  } finally {
    await fixture.cleanup();
  }
});

test("AuthZEN separates a server request ID from the caller correlation ID", async () => {
  const fixture = await createFixture();
  try {
    const response = await dispatch(fixture.server, {
      method: "POST",
      url: "/access/v1/evaluation",
      headers: headers({ "x-request-id": "authzen-1" }),
      body: JSON.stringify({
        subject: { type: "agent", id: "agent-1" },
        action: { name: "model_call" },
        resource: { type: "dataset", id: "public-docs", properties: { classification: "public" } },
        context: { model: { provider: "openai", id: "gpt" }, estimatedCost: 0.1 }
      })
    });

    assert.equal(response.status, 200);
    assert.match(response.headers["x-request-id"], /^[0-9a-f-]{36}$/);
    assert.notEqual(response.headers["x-request-id"], "authzen-1");
    const payload = JSON.parse(response.body);
    assert.equal(payload.decision, true);
    assert.equal(payload.context.veil.action, "ALLOW");
    assert.equal(payload.context.veil.receipt.receiptVersion, "veil-decision-receipt/1.0");
    assert.equal(payload.context.veil.receipt.requestId, response.headers["x-request-id"]);
    assert.equal(payload.context.veil.receipt.correlationId, "authzen-1");
  } finally {
    await fixture.cleanup();
  }
});

test("AuthZEN minimal request fails closed and malformed requests return 400", async () => {
  const fixture = await createFixture();
  try {
    const denied = await dispatch(fixture.server, {
      method: "POST",
      url: "/access/v1/evaluation",
      headers: headers(),
      body: JSON.stringify({
        subject: { type: "agent", id: "agent-1" },
        action: { name: "tool_call" },
        resource: { type: "tool", id: "shell" }
      })
    });
    assert.equal(denied.status, 200);
    assert.equal(JSON.parse(denied.body).decision, false);

    const malformed = await dispatch(fixture.server, {
      method: "POST",
      url: "/access/v1/evaluation",
      headers: headers({ "x-request-id": "authzen-error-1" }),
      body: JSON.stringify({ subject: { type: "agent", id: "agent-1" } })
    });
    assert.equal(malformed.status, 400);
    assert.match(malformed.headers["x-request-id"], /^[0-9a-f-]{36}$/);
    assert.notEqual(malformed.headers["x-request-id"], "authzen-error-1");
    assert.equal(JSON.parse(malformed.body).error.code, "VALIDATION_FAILED");
  } finally {
    await fixture.cleanup();
  }
});

test("readiness reflects persistence failure and request bodies are bounded", async () => {
  const authenticator = { authenticate: async () => ({ tenantId: "tenant-a", actorId: "agent-1", scopes: ["decision:write", "decision:context:assert"] }) };
  const store = { healthCheck: async () => { throw new Error("offline"); } };
  const server = buildServer({ store, service: {}, authenticator, authZenPolicyId: "policy-main", maxBodyBytes: 8 });

  const readiness = await dispatch(server, { method: "GET", url: "/ready", headers: {}, body: undefined });
  assert.equal(readiness.status, 503);

  const oversized = await dispatch(server, {
    method: "POST",
    url: "/access/v1/evaluation",
    headers: headers(),
    body: "{\"long\":true}"
  });
  assert.equal(oversized.status, 413);
});

test("request identifiers are bounded without echoing oversized values", async () => {
  const fixture = await createFixture();
  try {
    const oversizedId = "x".repeat(201);
    const response = await dispatch(fixture.server, {
      method: "POST",
      url: "/access/v1/evaluation",
      headers: headers({ "x-request-id": oversizedId }),
      body: JSON.stringify({
        subject: { type: "agent", id: "agent-1" },
        action: { name: "model_call" },
        resource: { type: "dataset", id: "docs" }
      })
    });

    assert.equal(response.status, 400);
    assert.match(response.headers["x-request-id"], /^[0-9a-f-]{36}$/);
  } finally {
    await fixture.cleanup();
  }
});

test("caller correlation IDs use a bounded safe character set without replacing the server request ID", async () => {
  const fixture = await createFixture();
  try {
    const response = await dispatch(fixture.server, {
      method: "POST",
      url: "/access/v1/evaluation",
      headers: headers({ "x-correlation-id": "foreign id" }),
      body: JSON.stringify({
        subject: { type: "agent", id: "agent-1" },
        action: { name: "model_call" },
        resource: { type: "dataset", id: "docs" }
      })
    });

    assert.equal(response.status, 400);
    assert.match(response.headers["x-request-id"], /^[0-9a-f-]{36}$/);
    assert.notEqual(JSON.parse(response.body).error.correlationId, "foreign id");
  } finally {
    await fixture.cleanup();
  }
});

test("repeated caller correlation IDs retain distinct trusted audit request identities", async () => {
  const fixture = await createFixture();
  try {
    const request = {
      subject: { type: "agent", id: "agent-1" },
      action: { name: "model_call" },
      resource: { type: "dataset", id: "docs" }
    };
    const first = await dispatch(fixture.server, {
      method: "POST",
      url: "/access/v1/evaluation",
      headers: headers({ "x-correlation-id": "shared-correlation" }),
      body: JSON.stringify(request)
    });
    const second = await dispatch(fixture.server, {
      method: "POST",
      url: "/access/v1/evaluation",
      headers: headers({ "x-correlation-id": "shared-correlation" }),
      body: JSON.stringify(request)
    });
    const firstPayload = JSON.parse(first.body);
    const secondPayload = JSON.parse(second.body);

    assert.notEqual(first.headers["x-request-id"], second.headers["x-request-id"]);
    assert.equal(firstPayload.context.veil.receipt.requestId, first.headers["x-request-id"]);
    assert.equal(secondPayload.context.veil.receipt.requestId, second.headers["x-request-id"]);
    const audit = await fixture.server.veil.service.listAuditEvents(
      { tenantId: "tenant-a", actorId: "auditor", scopes: ["audit:read"], requestId: "audit-query", correlationId: "audit-query" }
    );
    const decisionEvents = audit.items.filter((event) => event.action === "decision.created");
    assert.equal(decisionEvents.length, 2);
    assert.deepEqual(new Set(decisionEvents.map((event) => event.correlationId)), new Set(["shared-correlation"]));
    assert.deepEqual(new Set(decisionEvents.map((event) => event.requestId)), new Set([first.headers["x-request-id"], second.headers["x-request-id"]]));
  } finally {
    await fixture.cleanup();
  }
});

test("idempotent decision replays retain the original receipt and audit the new transport request", async () => {
  const fixture = await createFixture();
  try {
    const request = { policyId: "policy-main", version: "1.0.0", input: { risk: "low" } };
    const first = await dispatch(fixture.server, {
      method: "POST",
      url: "/v1/decisions",
      headers: headers({ "idempotency-key": "replay-safe-key", "x-correlation-id": "shared-replay" }),
      body: JSON.stringify({ request })
    });
    const second = await dispatch(fixture.server, {
      method: "POST",
      url: "/v1/decisions",
      headers: headers({ "idempotency-key": "replay-safe-key", "x-correlation-id": "shared-replay" }),
      body: JSON.stringify({ request })
    });
    const firstPayload = JSON.parse(first.body);
    const secondPayload = JSON.parse(second.body);

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(firstPayload.data.id, secondPayload.data.id);
    assert.equal(firstPayload.data.receipt.requestId, first.headers["x-request-id"]);
    assert.equal(secondPayload.data.receipt.requestId, first.headers["x-request-id"]);
    assert.notEqual(second.headers["x-request-id"], first.headers["x-request-id"]);

    const audit = await fixture.server.veil.service.listAuditEvents(
      { tenantId: "tenant-a", actorId: "auditor", scopes: ["audit:read"], correlationId: "audit-query" }
    );
    const created = audit.items.find((event) => event.action === "decision.created");
    const replayed = audit.items.find((event) => event.action === "decision.idempotency.replayed");
    assert.equal(created?.requestId, first.headers["x-request-id"]);
    assert.equal(replayed?.requestId, second.headers["x-request-id"]);
    assert.equal(replayed?.resourceId, firstPayload.data.id);
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture(enforcementTokenSigner) {
  const dir = await mkdtemp(join(tmpdir(), "veil-http-test-"));
  const store = new FileVeilStore(join(dir, "store.json"));
  const service = new VeilService(store, { now: () => new Date("2026-07-11T00:00:00.000Z") }, deterministicId(), enforcementTokenSigner);
  const context = { tenantId: "tenant-a", actorId: "admin", scopes: ["policy:write", "decision:write", "decision:context:assert"], correlationId: "setup" };
  await service.createDraft(context, "policy-main", policy);
  await service.publish(context, "policy-main", "1.0.0", "publish-1");
  await service.bindActivePolicy(context, "policy-main", "1.0.0");
  const authenticator = { authenticate: async () => ({ tenantId: "tenant-a", actorId: "agent-1", scopes: ["decision:write", "decision:context:assert"] }) };
  return {
    server: buildServer({ store, service, authenticator, authZenPolicyId: "policy-main" }),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

function headers(extra = {}) {
  return { "content-type": "application/json", authorization: "Bearer signed", ...extra };
}

function dispatch(server, { method, url, headers: requestHeaders, body }) {
  return new Promise((resolve, reject) => {
    const request = Readable.from(body === undefined ? [] : [body]);
    request.method = method;
    request.url = url;
    request.headers = requestHeaders;
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
  return () => `id-${++counter}`;
}

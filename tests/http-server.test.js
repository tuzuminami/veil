import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { FileVeilStore } from "../src/adapters/file-store.js";
import { VeilService } from "../src/application/veil-service.js";
import { buildServer, createDevelopmentAuthenticator } from "../src/transport/http-server.js";

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

test("AuthZEN single evaluation returns a boolean decision, receipt, and echoed request ID", async () => {
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
    assert.equal(response.headers["x-request-id"], "authzen-1");
    const payload = JSON.parse(response.body);
    assert.equal(payload.decision, true);
    assert.equal(payload.context.veil.action, "ALLOW");
    assert.equal(payload.context.veil.receipt.receiptVersion, "veil-decision-receipt/1.0");
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
    assert.equal(malformed.headers["x-request-id"], "authzen-error-1");
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
    assert.equal(response.headers["x-request-id"], undefined);
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture() {
  const dir = await mkdtemp(join(tmpdir(), "veil-http-test-"));
  const store = new FileVeilStore(join(dir, "store.json"));
  const service = new VeilService(store, { now: () => new Date("2026-07-11T00:00:00.000Z") }, deterministicId());
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

import assert from "node:assert/strict";
import test from "node:test";
import { VeilClient } from "../src/sdk/client.js";

test("SDK supports active binding and AuthZEN single evaluation", async () => {
  const calls = [];
  const client = new VeilClient({
    baseUrl: "https://veil.example.com/",
    token: "signed-token",
    tenantId: "tenant-a",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const body = url.endsWith("/access/v1/evaluation") ? { decision: false } : { data: { version: "1.0.0" } };
      return { ok: true, json: async () => body };
    }
  });

  assert.deepEqual(await client.bindPolicy("baseline", "1.0.0"), { version: "1.0.0" });
  assert.deepEqual(await client.rollbackPolicy("baseline", "1.0.0"), { version: "1.0.0" });
  assert.deepEqual(await client.evaluateAccess({ subject: {}, action: {}, resource: {} }, "request-1"), { decision: false });
  await client.listAuditEvents({ limit: 25, cursor: "cursor-1" });
  assert.equal(calls[0].url, "https://veil.example.com/v1/policies/baseline/bind");
  assert.equal(calls[2].options.headers["X-Request-ID"], "request-1");
  assert.equal(calls[2].options.headers.Authorization, "Bearer signed-token");
  assert.equal(calls[3].url, "https://veil.example.com/v1/audit-events?limit=25&cursor=cursor-1");
});

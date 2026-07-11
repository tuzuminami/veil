import assert from "node:assert/strict";
import test from "node:test";
import { createProductionServer } from "../src/runtime/production.js";

const env = {
  DATABASE_URL: "postgresql://unused",
  VEIL_OIDC_ISSUER: "https://issuer.example",
  VEIL_OIDC_AUDIENCE: "veil-api",
  VEIL_AUTHZEN_POLICY_ID: "agent-baseline"
};

test("production runtime wires an injected pool and verifier without development auth", async () => {
  const pool = new FakePool();
  const runtime = createProductionServer({
    env,
    pool,
    verifier: async () => ({ payload: { sub: "pep", tenant_id: "tenant-a", exp: 4102444800, scope: "decision:write decision:context:assert" } })
  });

  assert.equal(typeof runtime.server.listen, "function");
  assert.equal(runtime.server.veil.store.pool, pool);
  await runtime.close();
  assert.equal(pool.ended, true);
});

test("production runtime fails closed when required configuration is missing", () => {
  assert.throws(() => createProductionServer({ env: {}, pool: new FakePool(), verifier: async () => ({}) }), /DATABASE_URL is required/);
  assert.throws(
    () => createProductionServer({ env: { ...env, VEIL_AUTHZEN_POLICY_ID: "" }, pool: new FakePool(), verifier: async () => ({}) }),
    /VEIL_AUTHZEN_POLICY_ID is required/
  );
});

class FakePool {
  constructor() {
    this.ended = false;
  }

  async query() {
    return { rows: [] };
  }

  async end() {
    this.ended = true;
  }
}

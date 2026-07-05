import test from "node:test";
import assert from "node:assert/strict";

test("package exports expose public entry points", async () => {
  const root = await import("@tuzuminami/veil");
  const sdk = await import("@tuzuminami/veil/sdk");

  assert.equal(typeof root.VeilService, "function");
  assert.equal(typeof root.FileVeilStore, "function");
  assert.equal(typeof root.buildServer, "function");
  assert.equal(typeof sdk.VeilClient, "function");
});

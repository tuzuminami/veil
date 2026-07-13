import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createEnforcementTokenSigner } from "../src/core/enforcement-token.js";
import { createProductionServer } from "../src/runtime/production.js";

const relaySourceDir = process.env.RELAY_SOURCE_DIR;
if (typeof relaySourceDir !== "string" || relaySourceDir.length === 0) {
  console.log("RELAY enforcement compatibility check skipped: RELAY_SOURCE_DIR is not configured.");
  process.exit(0);
}

const verifierPath = join(relaySourceDir, "packages/adapters/src/veil-enforcement.ts");
if (!existsSync(verifierPath)) throw new Error("RELAY_SOURCE_DIR does not contain the public VEIL enforcement verifier.");

const { createVeilDecisionVerifier, RELAY_VEIL_ENFORCEMENT_AUDIENCE } = await import(pathToFileURL(verifierPath).href);
assert.equal(RELAY_VEIL_ENFORCEMENT_AUDIENCE, "relay-api", "RELAY must retain its v1 VEIL enforcement audience contract");
const { privateKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" });
const now = new Date("2026-07-13T00:00:00.000Z");
const issuer = "https://veil.contract.example.test";
const decision = {
  tenantId: "tenant_contract",
  action: "ALLOW",
  requestedAction: "model_call",
  id: "decision_contract",
  inputHash: "a".repeat(64),
  receipt: { receiptHash: "b".repeat(64) }
};

const runtime = createProductionServer({
  env: {
    DATABASE_URL: "postgresql://unused",
    VEIL_OIDC_ISSUER: "https://issuer.contract.example.test",
    VEIL_OIDC_AUDIENCE: "veil-contract-api",
    VEIL_AUTHZEN_POLICY_ID: "contract-policy",
    VEIL_ENFORCEMENT_PRIVATE_KEY: privateKeyPem,
    VEIL_ENFORCEMENT_KEY_ID: "veil-contract-key",
    VEIL_ENFORCEMENT_ISSUER: issuer
  },
  pool: { async end() {} },
  verifier: async () => ({ payload: { sub: "contract-pep", tenant_id: decision.tenantId, exp: 4102444800, scope: "decision:write" } })
});
const signer = runtime.server.veil.service.enforcementTokenSigner;
const verifier = createVeilDecisionVerifier({
  issuer,
  audience: RELAY_VEIL_ENFORCEMENT_AUDIENCE,
  jwks: signer.jwks()
});
try {
  const token = await signer.issue(decision, "c".repeat(64), now);
  const verified = await verifier.verify({
    token,
    tenantId: decision.tenantId,
    requestedAction: decision.requestedAction,
    inputHash: decision.inputHash,
    now: new Date("2026-07-13T00:00:30.000Z")
  });
  assert.equal(verified.decisionId, decision.id);

  const wrongAudienceSigner = createEnforcementTokenSigner({
    privateKeyPem,
    keyId: "veil-contract-key",
    issuer,
    audience: "wrong-relay-audience"
  });
  const wrongAudienceToken = await wrongAudienceSigner.issue(decision, "c".repeat(64), now);
  await assert.rejects(
    () => verifier.verify({
      token: wrongAudienceToken,
      tenantId: decision.tenantId,
      requestedAction: decision.requestedAction,
      inputHash: decision.inputHash,
      now: new Date("2026-07-13T00:00:30.000Z")
    }),
    (error) => error?.code === "VEIL_DECISION_INVALID" && error?.status === 403
  );
} finally {
  await runtime.close();
}

console.log("VEIL to RELAY enforcement compatibility passed.");

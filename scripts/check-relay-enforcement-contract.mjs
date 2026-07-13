import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createEnforcementTokenSigner, RELAY_ENFORCEMENT_AUDIENCE } from "../src/core/enforcement-token.js";

const relaySourceDir = process.env.RELAY_SOURCE_DIR;
if (typeof relaySourceDir !== "string" || relaySourceDir.length === 0) {
  console.log("RELAY enforcement compatibility check skipped: RELAY_SOURCE_DIR is not configured.");
  process.exit(0);
}

const verifierPath = join(relaySourceDir, "packages/adapters/src/veil-enforcement.ts");
if (!existsSync(verifierPath)) throw new Error("RELAY_SOURCE_DIR does not contain the public VEIL enforcement verifier.");

const { createVeilDecisionVerifier } = await import(pathToFileURL(verifierPath).href);
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

const signer = createEnforcementTokenSigner({
  privateKeyPem,
  keyId: "veil-contract-key",
  issuer
});
const verifier = createVeilDecisionVerifier({
  issuer,
  audience: RELAY_ENFORCEMENT_AUDIENCE,
  jwks: signer.jwks()
});
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

console.log("VEIL to RELAY enforcement compatibility passed.");

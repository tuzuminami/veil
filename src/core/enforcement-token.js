import { createPrivateKey, createPublicKey } from "node:crypto";
import { SignJWT } from "jose";

const DEFAULT_TTL_SECONDS = 60;
export const RELAY_ENFORCEMENT_AUDIENCE = "relay-api";

export function createEnforcementTokenSigner({ privateKeyPem, keyId, issuer, audience = RELAY_ENFORCEMENT_AUDIENCE, ttlSeconds = DEFAULT_TTL_SECONDS, previousPublicJwks = [] }) {
  if (typeof privateKeyPem !== "string" || privateKeyPem.trim().length === 0) throw new Error("Enforcement token private key is required.");
  keyId = requiredIdentifier(keyId, "Enforcement token key ID");
  issuer = requiredIdentifier(issuer, "Enforcement token issuer");
  audience = requiredIdentifier(audience, "Enforcement token audience");
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300) throw new Error("Enforcement token TTL must be between 1 and 300 seconds.");

  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Enforcement token signing key must be Ed25519.");
  const publicJwk = createPublicKey(privateKey).export({ format: "jwk" });
  const jwk = { ...publicJwk, kid: keyId, use: "sig", alg: "EdDSA" };
  const previousKeys = validatePreviousPublicJwks(previousPublicJwks, keyId);

  return {
    jwks: () => ({ keys: [jwk, ...previousKeys] }),
    async issue(decision, policyHash, now) {
      const issuedAt = Math.floor(now.getTime() / 1000);
      return new SignJWT({
        tenant_id: decision.tenantId,
        action: decision.action,
        requested_action: decision.requestedAction,
        decision_id: decision.id,
        input_hash: decision.inputHash,
        policy_hash: policyHash,
        receipt_hash: decision.receipt.receiptHash
      })
        .setProtectedHeader({ alg: "EdDSA", kid: keyId, typ: "JWT" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ttlSeconds)
        .setJti(decision.id)
        .sign(privateKey);
    }
  };
}

function requiredIdentifier(value, name) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) throw new Error(`${name} is required.`);
  return value.trim();
}

function validatePreviousPublicJwks(value, currentKeyId) {
  if (!Array.isArray(value)) throw new Error("Previous enforcement public JWKs must be an array.");
  const keyIds = new Set([currentKeyId]);
  return value.map((jwk) => {
    if (!jwk || typeof jwk !== "object" || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || typeof jwk.kid !== "string" || jwk.kid.length === 0 || "d" in jwk || keyIds.has(jwk.kid)) {
      throw new Error("Previous enforcement public JWK is invalid.");
    }
    keyIds.add(jwk.kid);
    return { kty: "OKP", crv: "Ed25519", x: jwk.x, kid: jwk.kid, use: "sig", alg: "EdDSA" };
  });
}

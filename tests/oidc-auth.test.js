import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { createOidcAuthenticator } from "../src/auth/oidc-auth.js";
import { VeilError } from "../src/core/errors.js";

const options = { issuer: "https://issuer.example", audience: "veil-api", algorithms: ["RS256"] };
const future = 4102444800;
const verificationOptions = { ...options, requiredClaims: ["exp", "sub", "tenant_id"], clockTolerance: 5 };

test("verifies a real RS256 JWT against JWKS, issuer, audience, and expiry", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = "RS256";
  publicJwk.kid = "test-key";
  const token = await new SignJWT({ tenant_id: "tenant-a", scope: "decision:write" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject("agent-1")
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
  const authenticator = createOidcAuthenticator({ ...options, jwks: createLocalJWKSet({ keys: [publicJwk] }) });

  const context = await authenticator.authenticate({ authorization: `Bearer ${token}` });

  assert.deepEqual(context, { tenantId: "tenant-a", actorId: "agent-1", scopes: ["decision:write"] });
});

test("authenticates verified claims and normalizes string scopes", async () => {
  let received;
  const authenticator = createOidcAuthenticator({
    ...options,
    verifier: async (token, verificationOptions) => {
      received = { token, verificationOptions };
      return { payload: { sub: "alice", tenant_id: "tenant-a", exp: future, scope: "policy:read  decision:write" } };
    }
  });

  const context = await authenticator.authenticate({ authorization: "Bearer signed-token", tenantId: "tenant-a" });

  assert.deepEqual(context, { actorId: "alice", tenantId: "tenant-a", scopes: ["policy:read", "decision:write"] });
  assert.deepEqual(received, { token: "signed-token", verificationOptions });
});

test("normalizes array scopes and supports a configured tenant claim", async () => {
  const authenticator = createOidcAuthenticator({
    ...options,
    tenantClaim: "tid",
    verifier: async () => ({ payload: { sub: "alice", tid: "tenant-a", exp: future, scope: ["policy:read decision:write", "appeal:write"] } })
  });

  const context = await authenticator.authenticate({ authorization: "Bearer signed-token", tenantId: "tenant-a" });

  assert.deepEqual(context.scopes, ["policy:read", "decision:write", "appeal:write"]);
});

test("uses injected JWKS verification with issuer, audience, and algorithms", async () => {
  const jwks = () => {};
  let received;
  const authenticator = createOidcAuthenticator({
    ...options,
    jwks,
    jwtVerifyImpl: async (token, key, verificationOptions) => {
      received = { token, key, verificationOptions };
      return { payload: { sub: "alice", tenant_id: "tenant-a", exp: future } };
    }
  });

  await authenticator.authenticate({ authorization: "Bearer signed-token", tenantId: "tenant-a" });

  assert.deepEqual(received, { token: "signed-token", key: jwks, verificationOptions });
});

test("rejects missing or malformed bearer tokens without leaking them", async () => {
  const authenticator = createOidcAuthenticator({ ...options, verifier: async () => ({}) });

  for (const authorization of [undefined, "Basic secret", "Bearer two tokens"]) {
    await assert.rejects(
      authenticator.authenticate({ authorization, tenantId: "tenant-a" }),
      (error) => error instanceof VeilError && error.code === "AUTHENTICATION_REQUIRED" && error.status === 401 && !error.message.includes("secret")
    );
  }
});

test("rejects verifier failures and missing required claims as typed authentication errors", async () => {
  const rejected = createOidcAuthenticator({ ...options, verifier: async () => { throw new Error("signed-token") } });
  const missingClaims = createOidcAuthenticator({ ...options, verifier: async () => ({ payload: { sub: "alice" } }) });

  for (const authenticator of [rejected, missingClaims]) {
    await assert.rejects(
      authenticator.authenticate({ authorization: "Bearer signed-token", tenantId: "tenant-a" }),
      (error) => error instanceof VeilError && error.code === "AUTHENTICATION_REQUIRED" && !error.message.includes("signed-token")
    );
  }
});

test("rejects expired verified claims even with an injected verifier", async () => {
  const authenticator = createOidcAuthenticator({
    ...options,
    clock: () => 2_000_000,
    clockTolerance: 0,
    verifier: async () => ({ payload: { sub: "alice", tenant_id: "tenant-a", exp: 1 } })
  });

  await assert.rejects(
    authenticator.authenticate({ authorization: "Bearer signed-token" }),
    (error) => error instanceof VeilError && error.code === "AUTHENTICATION_REQUIRED"
  );
});

test("rejects X-Tenant-Id mismatch using the verified tenant claim", async () => {
  const authenticator = createOidcAuthenticator({
    ...options,
    verifier: async () => ({ payload: { sub: "alice", tenant_id: "tenant-a", exp: future } })
  });

  await assert.rejects(
    authenticator.authenticate({ authorization: "Bearer signed-token", tenantId: "tenant-b" }),
    (error) => error instanceof VeilError && error.code === "TENANT_SCOPE_DENIED" && error.status === 403
  );
});

test("derives tenant from verified claims when X-Tenant-Id is omitted", async () => {
  const authenticator = createOidcAuthenticator({
    ...options,
    verifier: async () => ({ payload: { sub: "alice", tenant_id: "tenant-a", exp: future, scope: "decision:write" } })
  });

  const context = await authenticator.authenticate({ authorization: "Bearer signed-token" });

  assert.equal(context.tenantId, "tenant-a");
  assert.deepEqual(context.scopes, ["decision:write"]);
});

test("fails closed for invalid scope claims and unavailable verification configuration", async () => {
  const invalidScope = createOidcAuthenticator({
    ...options,
    verifier: async () => ({ payload: { sub: "alice", tenant_id: "tenant-a", exp: future, scope: ["policy:read", 1] } })
  });

  await assert.rejects(
    invalidScope.authenticate({ authorization: "Bearer signed-token", tenantId: "tenant-a" }),
    (error) => error instanceof VeilError && error.code === "AUTHENTICATION_REQUIRED"
  );
  assert.throws(
    () => createOidcAuthenticator({ issuer: options.issuer, audience: options.audience }),
    (error) => error instanceof VeilError && error.code === "AUTHENTICATION_UNAVAILABLE" && error.status === 503
  );
  assert.throws(
    () => createOidcAuthenticator({ ...options, verifier: "not-a-function" }),
    (error) => error instanceof VeilError && error.code === "AUTHENTICATION_UNAVAILABLE" && error.status === 503
  );
  assert.throws(
    () => createOidcAuthenticator({ ...options, jwksUri: "http://issuer.example/jwks" }),
    (error) => error instanceof VeilError && error.code === "AUTHENTICATION_UNAVAILABLE"
  );
});

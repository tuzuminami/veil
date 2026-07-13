import { PostgresVeilStore } from "../adapters/postgres-store.js";
import { createOidcAuthenticator } from "../auth/oidc-auth.js";
import { createEnforcementTokenSigner, RELAY_ENFORCEMENT_AUDIENCE } from "../core/enforcement-token.js";
import { buildServer } from "../transport/http-server.js";

export function createProductionServer({ env = process.env, pool, verifier } = {}) {
  const connectionString = required(env.DATABASE_URL, "DATABASE_URL");
  const issuer = required(env.VEIL_OIDC_ISSUER, "VEIL_OIDC_ISSUER");
  const audience = required(env.VEIL_OIDC_AUDIENCE, "VEIL_OIDC_AUDIENCE");
  const jwksUri = verifier === undefined ? required(env.VEIL_OIDC_JWKS_URL, "VEIL_OIDC_JWKS_URL") : undefined;
  const authZenPolicyId = required(env.VEIL_AUTHZEN_POLICY_ID, "VEIL_AUTHZEN_POLICY_ID");
  const enforcementTokenSigner = createEnforcementTokenSigner({
    privateKeyPem: required(env.VEIL_ENFORCEMENT_PRIVATE_KEY, "VEIL_ENFORCEMENT_PRIVATE_KEY").replace(/\\n/g, "\n"),
    keyId: required(env.VEIL_ENFORCEMENT_KEY_ID, "VEIL_ENFORCEMENT_KEY_ID"),
    issuer: required(env.VEIL_ENFORCEMENT_ISSUER, "VEIL_ENFORCEMENT_ISSUER"),
    audience: env.VEIL_ENFORCEMENT_AUDIENCE ?? RELAY_ENFORCEMENT_AUDIENCE,
    ttlSeconds: positiveInteger(env.VEIL_ENFORCEMENT_TTL_SECONDS, 60),
    previousPublicJwks: jsonArray(env.VEIL_ENFORCEMENT_PREVIOUS_PUBLIC_JWKS)
  });
  const store = new PostgresVeilStore(pool ?? postgresOptions(connectionString, env));
  const authenticator = createOidcAuthenticator({
    issuer,
    audience,
    jwksUri,
    verifier,
    tenantClaim: env.VEIL_OIDC_TENANT_CLAIM ?? "tenant_id",
    scopeClaim: env.VEIL_OIDC_SCOPE_CLAIM ?? "scope",
    algorithms: csv(env.VEIL_OIDC_ALGORITHMS ?? "RS256")
  });
  const server = buildServer({
    store,
    authenticator,
    authZenPolicyId,
    enforcementTokenSigner,
    maxBodyBytes: positiveInteger(env.VEIL_MAX_BODY_BYTES, 1024 * 1024),
    requestTimeoutMs: positiveInteger(env.VEIL_REQUEST_TIMEOUT_MS, 10000),
    headersTimeoutMs: positiveInteger(env.VEIL_HEADERS_TIMEOUT_MS, 5000),
    keepAliveTimeoutMs: positiveInteger(env.VEIL_KEEP_ALIVE_TIMEOUT_MS, 5000)
  });
  return { server, store, close: () => store.close() };
}

function postgresOptions(connectionString, env) {
  return {
    connectionString,
    max: positiveInteger(env.VEIL_PG_POOL_MAX, 10),
    connectionTimeoutMillis: positiveInteger(env.VEIL_PG_CONNECT_TIMEOUT_MS, 5000),
    idleTimeoutMillis: positiveInteger(env.VEIL_PG_IDLE_TIMEOUT_MS, 30000),
    ssl: env.VEIL_PG_SSL === "require" ? { rejectUnauthorized: true } : undefined
  };
}

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required in production.`);
  return value;
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("Production numeric configuration must be a positive integer.");
  return parsed;
}

function csv(value) {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error("VEIL_OIDC_ALGORITHMS must contain at least one algorithm.");
  return entries;
}

function jsonArray(value) {
  if (value === undefined || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed;
  } catch {
    throw new Error("VEIL_ENFORCEMENT_PREVIOUS_PUBLIC_JWKS must be a JSON array.");
  }
}

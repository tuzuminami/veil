import { createRemoteJWKSet, jwtVerify } from "jose";
import { VeilError } from "../core/errors.js";

const DEFAULT_ALGORITHMS = ["RS256"];

export function createOidcAuthenticator({
  issuer,
  audience,
  algorithms = DEFAULT_ALGORITHMS,
  tenantClaim = "tenant_id",
  scopeClaim = "scope",
  clock = () => Date.now(),
  clockTolerance = 5,
  verifier,
  jwks,
  jwksUri,
  allowInsecureJwks = false,
  jwtVerifyImpl = jwtVerify,
  createRemoteJWKSetImpl = createRemoteJWKSet
} = {}) {
  if ((verifier !== undefined && typeof verifier !== "function") || typeof tenantClaim !== "string" || tenantClaim.length === 0 || typeof scopeClaim !== "string" || scopeClaim.length === 0) {
    throw authenticationUnavailable();
  }
  const verificationOptions = verificationOptionsFor({ issuer, audience, algorithms, tenantClaim, clockTolerance });
  const verify = verifier ?? verifierFor({ jwks, jwksUri, allowInsecureJwks, jwtVerifyImpl, createRemoteJWKSetImpl, verificationOptions });

  return {
    async authenticate({ authorization, tenantId } = {}) {
      const token = bearerToken(authorization);
      const claims = await verifiedClaims(verify, token, verificationOptions);
      const actorId = requiredClaim(claims, "sub");
      const tokenTenantId = requiredClaim(claims, tenantClaim);
      const expiration = requiredNumericClaim(claims, "exp");
      if (expiration <= Math.floor(clock() / 1000) - clockTolerance) throw authenticationRequired();

      if (tenantId !== undefined && tenantId !== tokenTenantId) {
        throw new VeilError("TENANT_SCOPE_DENIED", "Request cannot access this tenant.", 403);
      }

      return { tenantId: tokenTenantId, actorId, scopes: normalizeScopes(claims[scopeClaim]) };
    }
  };
}

function verificationOptionsFor({ issuer, audience, algorithms, tenantClaim, clockTolerance }) {
  if (typeof issuer !== "string" || issuer.length === 0 || audience === undefined || !Array.isArray(algorithms) || algorithms.length === 0 || !algorithms.every((algorithm) => typeof algorithm === "string" && algorithm.length > 0) || typeof clockTolerance !== "number" || clockTolerance < 0) {
    throw authenticationUnavailable();
  }
  return { issuer, audience, algorithms, requiredClaims: ["exp", "sub", tenantClaim], clockTolerance };
}

function verifierFor({ jwks, jwksUri, allowInsecureJwks, jwtVerifyImpl, createRemoteJWKSetImpl, verificationOptions }) {
  let key = jwks;
  if (key === undefined && typeof jwksUri === "string" && jwksUri.length > 0) {
    try {
      const url = new URL(jwksUri);
      if (!allowInsecureJwks && url.protocol !== "https:") throw new Error("JWKS must use HTTPS");
      key = createRemoteJWKSetImpl(url);
    } catch {
      throw authenticationUnavailable();
    }
  }
  if (key === undefined || typeof jwtVerifyImpl !== "function") throw authenticationUnavailable();
  return (token) => jwtVerifyImpl(token, key, verificationOptions);
}

function bearerToken(authorization) {
  if (typeof authorization !== "string") throw authenticationRequired();
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) throw authenticationRequired();
  return match[1];
}

async function verifiedClaims(verify, token, verificationOptions) {
  try {
    const result = await verify(token, verificationOptions);
    const claims = result?.payload ?? result;
    if (claims === null || typeof claims !== "object" || Array.isArray(claims)) throw authenticationRequired();
    return claims;
  } catch (error) {
    if (error instanceof VeilError) throw error;
    throw authenticationRequired();
  }
}

function requiredClaim(claims, claim) {
  const value = claims[claim];
  if (typeof value !== "string" || value.length === 0) throw authenticationRequired();
  return value;
}

function requiredNumericClaim(claims, claim) {
  const value = claims[claim];
  if (typeof value !== "number" || !Number.isFinite(value)) throw authenticationRequired();
  return value;
}

function normalizeScopes(value) {
  if (value === undefined) return [];
  const parts = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (parts === null || !parts.every((scope) => typeof scope === "string")) throw authenticationRequired();
  return parts.flatMap((scope) => scope.trim().split(/\s+/).filter(Boolean));
}

function authenticationRequired() {
  return new VeilError("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
}

function authenticationUnavailable() {
  return new VeilError("AUTHENTICATION_UNAVAILABLE", "Authentication is unavailable.", 503);
}

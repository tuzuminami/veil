import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { FileVeilStore } from "../adapters/file-store.js";
import { VeilService, computeDecisionInputHash } from "../application/veil-service.js";
import { VeilError } from "../core/errors.js";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEVELOPMENT_AUTHENTICATOR = Symbol("veil.development-authenticator");

export function buildServer(options = {}) {
  const resolved = typeof options === "string" ? { storePath: options } : options;
  if (process.env.NODE_ENV === "production") {
    if (resolved.service !== undefined) {
      throw new Error("VEIL production runtime constructs its service from the validated persistence adapter; custom service injection is disabled.");
    }
    if (resolved.store === undefined || resolved.store instanceof FileVeilStore) {
      throw new Error("VEIL production runtime requires an explicit production persistence adapter; file persistence is disabled.");
    }
    if (resolved.authenticator === undefined || resolved.authenticator[DEVELOPMENT_AUTHENTICATOR] === true) {
      throw new Error("VEIL production runtime requires a production auth adapter; development auth is disabled.");
    }
    if (resolved.enforcementTokenSigner === undefined) {
      throw new Error("VEIL production runtime requires an enforcement token signer.");
    }
  }
  const store = resolved.store ?? new FileVeilStore(resolved.storePath ?? ".local-data/veil-store.json");
  const service = resolved.service ?? new VeilService(store, resolved.clock, resolved.newId, resolved.enforcementTokenSigner);
  const authenticator = resolved.authenticator ?? createDevelopmentAuthenticator();

  const server = createServer(async (request, response) => {
    try {
      await route({ service, store, authenticator, options: resolved }, request, response);
    } catch (error) {
      writeError(response, error, request);
    }
  });
  server.requestTimeout = resolved.requestTimeoutMs ?? 10000;
  server.headersTimeout = resolved.headersTimeoutMs ?? 5000;
  server.keepAliveTimeout = resolved.keepAliveTimeoutMs ?? 5000;
  server.veil = { service, store };
  return server;
}

export function createDevelopmentAuthenticator() {
  return {
    [DEVELOPMENT_AUTHENTICATOR]: true,
    async authenticate({ authorization, tenantId }) {
      if (!authorization?.startsWith("Bearer dev:") || !tenantId) throw new VeilError("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
      const [, encoded] = authorization.split("Bearer dev:");
      const [tokenTenant, actorId, ...scopeParts] = (encoded ?? "").split(":");
      const scopesRaw = scopeParts.join(":");
      if (!tokenTenant || !actorId || tokenTenant !== tenantId) throw new VeilError("TENANT_SCOPE_DENIED", "Request cannot access this tenant.", 403);
      return { tenantId, actorId, scopes: scopesRaw?.split(",").filter(Boolean) ?? [] };
    }
  };
}

async function route(runtime, request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
    if (runtime.options.enforcementTokenSigner === undefined) throw new VeilError("RESOURCE_NOT_FOUND", "Signing keys are not configured.", 404);
    return writeJson(response, 200, runtime.options.enforcementTokenSigner.jwks(), { "cache-control": "public, max-age=300" });
  }
  if (request.method === "GET" && url.pathname === "/health") {
    return writeJson(response, 200, { data: { status: "ok" }, meta: meta(request) });
  }
  if (request.method === "GET" && url.pathname === "/ready") {
    try {
      if (typeof runtime.store.healthCheck === "function") await runtime.store.healthCheck();
      return writeJson(response, 200, { data: { status: "ready" }, meta: meta(request) });
    } catch {
      return writeJson(response, 503, { error: { code: "DEPENDENCY_UNAVAILABLE", message: "Persistence is unavailable.", details: [], correlationId: correlationId(request) } });
    }
  }

  requireJsonContentType(request);
  const context = await authenticate(runtime.authenticator, request);
  const body = await readJson(request, runtime.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);

  if (request.method === "GET" && url.pathname === "/v1/audit-events") {
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
    const result = await runtime.service.listAuditEvents(context, {
      limit,
      cursor: url.searchParams.get("cursor") ?? undefined
    });
    return writeJson(response, 200, { data: result, meta: meta(request) });
  }

  if (request.method === "POST" && url.pathname === "/access/v1/evaluation") {
    const decisionRequest = authZenDecisionRequest(body, runtime.options.authZenPolicyId);
    let decision;
    try {
      decision = await runtime.service.createDecision(context, decisionRequest, requestId(request));
    } catch (error) {
      if (error instanceof VeilError && error.status === 422) {
        throw new VeilError(error.code, error.message, 400, error.details);
      }
      throw error;
    }
    return writeJson(
      response,
      200,
      {
        decision: decision.action === "ALLOW",
        context: {
          veil: {
            action: decision.action,
            reasonCodes: decision.reasonCodes,
            obligations: decision.obligations,
            receipt: decision.receipt,
            ...(decision.enforcementToken === undefined ? {} : { enforcementToken: decision.enforcementToken })
          }
        }
      },
      request.headers["x-request-id"] === undefined ? {} : { "x-request-id": requestId(request) }
    );
  }

  if (request.method === "POST" && (url.pathname === "/v1/policy-bundles" || url.pathname === "/v1/policies")) {
    const created = await runtime.service.createDraft(context, stringBody(body, "policyId"), objectBody(body, "bundle"));
    return writeJson(response, 201, { data: created, meta: meta(request) });
  }

  const validateMatch = url.pathname.match(/^\/v1\/policy-bundles\/([^/]+)\/versions\/([^/]+)\/validate$/);
  if (request.method === "POST" && validateMatch?.[1] && validateMatch[2]) {
    const result = await runtime.service.validateDraft(context, decode(validateMatch[1]), decode(validateMatch[2]));
    return writeJson(response, 200, { data: result, meta: meta(request) });
  }

  const publishMatch = url.pathname.match(/^\/v1\/policy-bundles\/([^/]+)\/versions\/([^/]+)\/publish$/);
  if (request.method === "POST" && publishMatch?.[1] && publishMatch[2]) {
    const published = await runtime.service.publish(context, decode(publishMatch[1]), decode(publishMatch[2]), idempotencyKey(request));
    return writeJson(response, 200, { data: published, meta: meta(request) });
  }

  const simplePublishMatch = url.pathname.match(/^\/v1\/policies\/([^/]+)\/publish$/);
  if (request.method === "POST" && simplePublishMatch?.[1]) {
    const published = await runtime.service.publish(context, decode(simplePublishMatch[1]), stringBody(body, "version"), idempotencyKey(request));
    return writeJson(response, 200, { data: published, meta: meta(request) });
  }

  const bindingMatch = url.pathname.match(/^\/v1\/policies\/([^/]+)\/(bind|rollback)$/);
  if (request.method === "POST" && bindingMatch?.[1]) {
    const policyId = decode(bindingMatch[1]);
    const version = stringBody(body, "version");
    const result = bindingMatch[2] === "bind"
      ? await runtime.service.bindActivePolicy(context, policyId, version)
      : await runtime.service.rollbackActivePolicy(context, policyId, version);
    return writeJson(response, 200, { data: result, meta: meta(request) });
  }

  if (request.method === "POST" && url.pathname === "/v1/decisions") {
    const decision = await runtime.service.createDecision(context, objectBody(body, "request"), idempotencyKey(request));
    return writeJson(response, 201, { data: decision, meta: meta(request) });
  }

  if (request.method === "POST" && url.pathname === "/v1/appeals") {
    const appeal = await runtime.service.createAppeal(context, objectBody(body, "request"), idempotencyKey(request));
    return writeJson(response, 201, { data: appeal, meta: meta(request) });
  }

  const decisionMatch = url.pathname.match(/^\/v1\/decisions\/([^/]+)$/);
  if (request.method === "GET" && decisionMatch?.[1]) {
    const decision = await runtime.service.getDecision(context, decode(decisionMatch[1]));
    return writeJson(response, 200, { data: decision, meta: meta(request) });
  }

  throw new VeilError("RESOURCE_NOT_FOUND", "Route was not found.", 404);
}

async function authenticate(authenticator, request) {
  const authenticated = await authenticator.authenticate({
    authorization: request.headers.authorization,
    tenantId: optionalBoundedHeader(request.headers["x-tenant-id"], "X-Tenant-Id")
  });
  return { ...authenticated, correlationId: correlationId(request) };
}

export function authZenDecisionRequest(body, configuredPolicyId) {
  const subject = authZenEntity(body.subject, "subject");
  const action = authZenAction(body.action);
  const resource = authZenEntity(body.resource, "resource");
  const authZenContext = optionalObject(body.context, "context");
  const policyId = authZenContext.policyId ?? configuredPolicyId;
  if (typeof policyId !== "string" || policyId.length === 0) throw authZenValidation("context.policyId is required when no default policy is configured.");
  if (!["model_call", "tool_call"].includes(action.name)) throw authZenValidation("action.name must be model_call or tool_call.");

  const classification = resource.properties?.classification ?? authZenContext.dataClassification ?? "restricted";
  const model = optionalObject(authZenContext.model, "context.model");
  const estimatedCost = typeof authZenContext.estimatedCost === "number" ? authZenContext.estimatedCost : Number.MAX_SAFE_INTEGER;
  return {
    policyId,
    version: typeof authZenContext.policyVersion === "string" ? authZenContext.policyVersion : undefined,
    type: action.name,
    agent: { id: subject.id },
    resource: { id: resource.id, type: resource.type, classification },
    dataClassification: classification,
    model: {
      provider: typeof model.provider === "string" ? model.provider : "unknown",
      id: typeof model.id === "string" ? model.id : "unknown"
    },
    estimatedCost,
    attributes: {
      ...optionalObject(authZenContext.attributes, "context.attributes"),
      authzen: {
        subjectType: subject.type,
        subjectProperties: subject.properties,
        actionProperties: action.properties,
        resourceProperties: resource.properties
      }
    },
    input: { subject, action, resource, context: authZenContext }
  };
}

export function computeAuthZenInputHash(body, configuredPolicyId) {
  return computeDecisionInputHash(authZenDecisionRequest(body, configuredPolicyId));
}

function authZenEntity(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string" || typeof value.id !== "string") {
    throw authZenValidation(`${name}.type and ${name}.id are required.`);
  }
  return { type: value.type, id: value.id, properties: optionalObject(value.properties, `${name}.properties`) };
}

function authZenAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.name !== "string") {
    throw authZenValidation("action.name is required.");
  }
  return { name: value.name, properties: optionalObject(value.properties, "action.properties") };
}

function authZenValidation(message) {
  return new VeilError("VALIDATION_FAILED", message, 400);
}

function requireJsonContentType(request) {
  if (!["POST", "PUT", "PATCH"].includes(request.method ?? "")) return;
  const contentType = request.headers["content-type"]?.toString().split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new VeilError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.", 415);
}

function idempotencyKey(request) {
  return requiredBoundedHeader(request.headers["idempotency-key"], "Idempotency-Key");
}

function requestId(request) {
  request.veilRequestId ??= optionalBoundedHeader(request.headers["x-request-id"], "X-Request-ID") ?? randomUUID();
  return request.veilRequestId;
}

function correlationId(request) {
  request.veilCorrelationId ??= optionalBoundedHeader(request.headers["x-correlation-id"], "X-Correlation-Id")
    ?? optionalBoundedHeader(request.headers["x-request-id"], "X-Request-ID")
    ?? randomUUID();
  return request.veilCorrelationId;
}

async function readJson(request, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new VeilError("PAYLOAD_TOO_LARGE", "JSON body exceeds the configured limit.", 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new VeilError("VALIDATION_FAILED", "JSON body is malformed.", 422);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new VeilError("VALIDATION_FAILED", "JSON body must be an object.", 422);
  return parsed;
}

function stringBody(body, key) {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw new VeilError("VALIDATION_FAILED", `${key} must be a non-empty string.`, 422);
  return value;
}

function objectBody(body, key) {
  const value = body[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new VeilError("VALIDATION_FAILED", `${key} must be an object.`, 422);
  return value;
}

function optionalObject(value, name) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw authZenValidation(`${name} must be an object.`);
  return value;
}

function requiredBoundedHeader(value, name) {
  const normalized = optionalBoundedHeader(value, name);
  if (normalized === undefined) throw new VeilError("VALIDATION_FAILED", `${name} header is required.`, 422);
  return normalized;
}

function optionalBoundedHeader(value, name) {
  if (value === undefined) return undefined;
  const normalized = value.toString();
  if (normalized.length < 1 || normalized.length > 200) {
    throw new VeilError("VALIDATION_FAILED", `${name} header must contain between 1 and 200 characters.`, 400);
  }
  return normalized;
}

function writeError(response, error, request) {
  const rawRequestId = request.headers["x-request-id"]?.toString();
  const headers = rawRequestId && rawRequestId.length <= 200 ? { "x-request-id": rawRequestId } : {};
  let errorCorrelationId;
  try {
    errorCorrelationId = correlationId(request);
  } catch {
    errorCorrelationId = randomUUID();
  }
  if (error instanceof VeilError) {
    return writeJson(response, error.status, { error: { code: error.code, message: error.message, details: error.details, correlationId: errorCorrelationId } }, headers);
  }
  return writeJson(response, 500, { error: { code: "DEPENDENCY_UNAVAILABLE", message: "Request failed safely.", details: [], correlationId: errorCorrelationId } }, headers);
}

function writeJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  response.end(JSON.stringify(body));
}

function meta(request) {
  return { requestId: requestId(request), correlationId: correlationId(request), apiVersion: "v1" };
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new VeilError("VALIDATION_FAILED", "Path parameter is malformed.", 422);
  }
}

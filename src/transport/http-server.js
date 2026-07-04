import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { FileVeilStore } from "../adapters/file-store.js";
import { VeilService } from "../application/veil-service.js";
import { VeilError } from "../core/errors.js";

export function buildServer(storePath = ".local-data/veil-store.json") {
  const service = new VeilService(new FileVeilStore(storePath));
  return createServer(async (request, response) => {
    try {
      await route(service, request, response);
    } catch (error) {
      writeError(response, error, request.headers["x-correlation-id"]?.toString());
    }
  });
}

async function route(service, request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/health") return writeJson(response, 200, { data: { status: "ok" }, meta: meta(request) });
  if (request.method === "GET" && url.pathname === "/ready") return writeJson(response, 200, { data: { status: "ready" }, meta: meta(request) });

  const context = contextFromHeaders(request);
  const body = await readJson(request);

  if (request.method === "POST" && (url.pathname === "/v1/policy-bundles" || url.pathname === "/v1/policies")) {
    const created = await service.createDraft(context, stringBody(body, "policyId"), objectBody(body, "bundle"));
    return writeJson(response, 201, { data: created, meta: meta(request) });
  }

  const validateMatch = url.pathname.match(/^\/v1\/policy-bundles\/([^/]+)\/versions\/([^/]+)\/validate$/);
  if (request.method === "POST" && validateMatch?.[1] && validateMatch[2]) {
    const result = await service.validateDraft(context, validateMatch[1], validateMatch[2]);
    return writeJson(response, 200, { data: result, meta: meta(request) });
  }

  const publishMatch = url.pathname.match(/^\/v1\/policy-bundles\/([^/]+)\/versions\/([^/]+)\/publish$/);
  if (request.method === "POST" && publishMatch?.[1] && publishMatch[2]) {
    const published = await service.publish(context, publishMatch[1], publishMatch[2], idempotencyKey(request));
    return writeJson(response, 200, { data: published, meta: meta(request) });
  }

  const simplePublishMatch = url.pathname.match(/^\/v1\/policies\/([^/]+)\/publish$/);
  if (request.method === "POST" && simplePublishMatch?.[1]) {
    const published = await service.publish(context, simplePublishMatch[1], stringBody(body, "version"), idempotencyKey(request));
    return writeJson(response, 200, { data: published, meta: meta(request) });
  }

  if (request.method === "POST" && url.pathname === "/v1/decisions") {
    const decision = await service.createDecision(context, objectBody(body, "request"), idempotencyKey(request));
    return writeJson(response, 201, { data: decision, meta: meta(request) });
  }

  if (request.method === "POST" && url.pathname === "/v1/appeals") {
    const appeal = await service.createAppeal(context, objectBody(body, "request"), idempotencyKey(request));
    return writeJson(response, 201, { data: appeal, meta: meta(request) });
  }

  const decisionMatch = url.pathname.match(/^\/v1\/decisions\/([^/]+)$/);
  if (request.method === "GET" && decisionMatch?.[1]) {
    const decision = await service.getDecision(context, decisionMatch[1]);
    return writeJson(response, 200, { data: decision, meta: meta(request) });
  }

  throw new VeilError("RESOURCE_NOT_FOUND", "Route was not found.", 404);
}

function contextFromHeaders(request) {
  const authorization = request.headers.authorization;
  const tenantId = request.headers["x-tenant-id"]?.toString();
  if (!authorization?.startsWith("Bearer dev:") || !tenantId) throw new VeilError("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
  const [, encoded] = authorization.split("Bearer dev:");
  const [tokenTenant, actorId, scopesRaw] = (encoded ?? "").split(":");
  if (!tokenTenant || !actorId || tokenTenant !== tenantId) throw new VeilError("TENANT_SCOPE_DENIED", "Request cannot access this tenant.", 403);
  return {
    tenantId,
    actorId,
    scopes: scopesRaw?.split(",").filter(Boolean) ?? [],
    correlationId: request.headers["x-correlation-id"]?.toString() ?? randomUUID()
  };
}

function idempotencyKey(request) {
  const key = request.headers["idempotency-key"]?.toString();
  if (!key) throw new VeilError("VALIDATION_FAILED", "Idempotency-Key header is required.", 422);
  return key;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new VeilError("VALIDATION_FAILED", "JSON body must be an object.", 422);
  return parsed;
}

function stringBody(body, key) {
  const value = body[key];
  if (typeof value !== "string") throw new VeilError("VALIDATION_FAILED", `${key} must be a string.`, 422);
  return value;
}

function objectBody(body, key) {
  const value = body[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new VeilError("VALIDATION_FAILED", `${key} must be an object.`, 422);
  return value;
}

function writeError(response, error, correlationId = randomUUID()) {
  if (error instanceof VeilError) {
    return writeJson(response, error.status, { error: { code: error.code, message: error.message, details: error.details, correlationId } });
  }
  return writeJson(response, 500, { error: { code: "DEPENDENCY_UNAVAILABLE", message: "Request failed safely.", details: [], correlationId } });
}

function writeJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function meta(request) {
  return {
    requestId: randomUUID(),
    correlationId: request.headers["x-correlation-id"]?.toString() ?? randomUUID(),
    apiVersion: "v1"
  };
}

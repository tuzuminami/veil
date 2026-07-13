import { randomUUID } from "node:crypto";
import { sha256 } from "../core/canonical.js";
import { VeilError } from "../core/errors.js";
import { decide, validateDecisionRequest, validatePolicyBundle } from "../core/policy.js";
import { createDecisionReceipt } from "../core/receipt.js";
import { readTrustedRequestId } from "../core/request-identity.js";
import { assertDecisionRequestSchema, assertPolicyBundleSchema } from "../validation/schemas.js";

export class VeilService {
  constructor(store, clock = { now: () => new Date() }, newId = randomUUID, enforcementTokenSigner) {
    this.store = store;
    this.clock = clock;
    this.newId = newId;
    this.enforcementTokenSigner = enforcementTokenSigner;
  }

  async createDraft(context, policyId, bundle) {
    context = withTrustedRequestId(context, this.newId);
    requireScope(context, "policy:write");
    validatePolicyBundle(bundle);
    assertPolicyBundleSchema(bundle);
    const policy = {
      policyId,
      tenantId: context.tenantId,
      version: bundle.version,
      status: "draft",
      bundle,
      contentHash: sha256({ bundle, compilerVersion: "veil-policy-compiler/1.0.0" }),
      createdAt: this.clock.now().toISOString(),
      createdBy: context.actorId
    };
    await this.store.savePolicyVersion(policy);
    await this.audit(context, "policy.draft.created", "policy-version", `${policyId}@${bundle.version}`, "draft created", policy.contentHash);
    return policy;
  }

  async validateDraft(context, policyId, version) {
    requireScope(context, "policy:read");
    const policy = await this.getPolicyOrThrow(context.tenantId, policyId, version);
    validatePolicyBundle(policy.bundle);
    return { valid: true, contentHash: policy.contentHash };
  }

  async publish(context, policyId, version, idempotencyKey) {
    context = withTrustedRequestId(context, this.newId);
    requireScope(context, "policy:write");
    const idemKey = `publish:${idempotencyKey}`;
    const fingerprint = sha256({ operation: "publish", tenantId: context.tenantId, policyId, version });
    const cached = readIdempotency(await this.store.getIdempotency(context.tenantId, idemKey), fingerprint);
    if (cached !== undefined) {
      await this.store.appendAudit(this.createIdempotencyReplayAuditEvent(context, "policy.version.idempotency.replayed", "policy-version", `${policyId}@${version}`, idemKey));
      return cached;
    }

    const policy = await this.getPolicyOrThrow(context.tenantId, policyId, version);
    if (policy.status === "published") {
      await this.store.setIdempotency(context.tenantId, idemKey, writeIdempotency(fingerprint, policy));
      return policy;
    }
    const published = { ...policy, status: "published", publishedAt: this.clock.now().toISOString() };
    const idempotencyRecord = writeIdempotency(fingerprint, published);
    const auditEvent = this.createAuditEvent(context, "policy.version.published", "policy-version", `${policyId}@${version}`, "published", published.contentHash);
    const idempotencyReplayAuditEvent = this.createIdempotencyReplayAuditEvent(context, "policy.version.idempotency.replayed", "policy-version", `${policyId}@${version}`, idemKey);
    if (typeof this.store.commitPolicyPublish === "function") {
      return this.store.commitPolicyPublish({ policy: published, auditEvent, idempotencyReplayAuditEvent, idempotencyKey: idemKey, idempotencyRecord });
    }
    await this.store.savePolicyVersion(published);
    await this.store.setIdempotency(context.tenantId, idemKey, idempotencyRecord);
    await this.store.appendAudit(auditEvent);
    return published;
  }

  async createDecision(context, request, idempotencyKey) {
    context = withTrustedRequestId(context, this.newId);
    requireScope(context, "decision:write");
    validateDecisionRequest(request);
    assertDecisionRequestSchema(request);
    if (request.type !== undefined) requireScope(context, "decision:context:assert");
    const idemKey = `decision:${idempotencyKey}`;
    const fingerprint = sha256({ operation: "decision", tenantId: context.tenantId, request });
    const cached = readIdempotency(await this.store.getIdempotency(context.tenantId, idemKey), fingerprint);
    if (cached !== undefined) {
      await this.store.appendAudit(this.createIdempotencyReplayAuditEvent(context, "decision.idempotency.replayed", "decision", cached.id, idemKey));
      return this.withEnforcementToken(cached);
    }

    const policy = await this.getDecisionPolicyOrThrow(context.tenantId, request.policyId, request.version);
    const decisionInput = {
      ...request,
      tenantId: context.tenantId,
      correlationId: context.correlationId,
      input: policyInput(request)
    };
    const result = decide(policy, decisionInput);
    const inputHash = computeDecisionInputHash(request);
    const decision = {
      id: this.newId(),
      tenantId: context.tenantId,
      policyId: request.policyId,
      version: policy.version,
      requestedAction: request.type,
      action: result.action,
      reasonCodes: result.reasonCodes,
      obligations: result.obligations,
      matchedRuleId: result.matchedRule?.id,
      inputHash,
      evidenceHash: sha256({ policyHash: policy.contentHash, inputHash, result }),
      requestId: context.requestId,
      correlationId: context.correlationId,
      createdAt: this.clock.now().toISOString()
    };
    decision.receipt = createDecisionReceipt(decision, policy.contentHash);
    const idempotencyRecord = writeIdempotency(fingerprint, decision);
    const auditEvent = this.createAuditEvent(context, "decision.created", "decision", decision.id, decision.reasonCodes.join(","), decision.evidenceHash);
    const idempotencyReplayAuditEvent = this.createIdempotencyReplayAuditEvent(context, "decision.idempotency.replayed", "decision", decision.id, idemKey);
    const outboxEvent = this.createOutboxEvent(context, "veil.decision.created.v1", decision.id, {
      action: decision.action,
      policyId: decision.policyId,
      version: decision.version
    });
    if (typeof this.store.commitDecision === "function") {
      const persisted = await this.store.commitDecision({ decision, auditEvent, idempotencyReplayAuditEvent, outboxEvent, idempotencyKey: idemKey, idempotencyRecord });
      return this.withEnforcementToken(persisted);
    } else {
      await this.store.saveDecision(decision);
      await this.store.setIdempotency(context.tenantId, idemKey, idempotencyRecord);
      await this.store.appendAudit(auditEvent);
      if (typeof this.store.appendOutbox === "function") await this.store.appendOutbox(outboxEvent);
    }
    return this.withEnforcementToken(decision);
  }

  async bindActivePolicy(context, policyId, version) {
    return this.setActivePolicyBinding(context, policyId, version, "policy.active.bound", "active version");
  }

  async rollbackActivePolicy(context, policyId, version) {
    return this.setActivePolicyBinding(context, policyId, version, "policy.active.rolled_back", "rolled back to version");
  }

  async createAppeal(context, request, idempotencyKey) {
    context = withTrustedRequestId(context, this.newId);
    requireScope(context, "appeal:write");
    const idemKey = `appeal:${idempotencyKey}`;
    const fingerprint = sha256({ operation: "appeal", tenantId: context.tenantId, request });
    const cached = readIdempotency(await this.store.getIdempotency(context.tenantId, idemKey), fingerprint);
    if (cached !== undefined) {
      await this.store.appendAudit(this.createIdempotencyReplayAuditEvent(context, "appeal.idempotency.replayed", "appeal", cached.id, idemKey));
      return cached;
    }
    if (typeof request.decisionId !== "string" || request.decisionId.length === 0) {
      throw new VeilError("VALIDATION_FAILED", "decisionId is required.", 422);
    }
    const decision = await this.store.getDecision(context.tenantId, request.decisionId);
    if (decision === undefined) throw new VeilError("RESOURCE_NOT_FOUND", "Decision was not found.", 404);
    const appeal = {
      id: this.newId(),
      tenantId: context.tenantId,
      decisionId: request.decisionId,
      status: "open",
      reason: typeof request.reason === "string" ? request.reason : "unspecified",
      requestId: context.requestId,
      correlationId: context.correlationId,
      createdAt: this.clock.now().toISOString(),
      createdBy: context.actorId
    };
    const idempotencyRecord = writeIdempotency(fingerprint, appeal);
    const auditEvent = this.createAuditEvent(context, "appeal.created", "appeal", appeal.id, "appeal opened", sha256(appeal));
    const idempotencyReplayAuditEvent = this.createIdempotencyReplayAuditEvent(context, "appeal.idempotency.replayed", "appeal", appeal.id, idemKey);
    const outboxEvent = this.createOutboxEvent(context, "veil.appeal.created.v1", appeal.id, {
      decisionId: appeal.decisionId,
      status: appeal.status
    });
    if (typeof this.store.commitAppeal === "function") {
      return this.store.commitAppeal({ appeal, auditEvent, idempotencyReplayAuditEvent, outboxEvent, idempotencyKey: idemKey, idempotencyRecord });
    }
    await this.store.saveAppeal(appeal);
    await this.store.setIdempotency(context.tenantId, idemKey, idempotencyRecord);
    await this.store.appendAudit(auditEvent);
    if (typeof this.store.appendOutbox === "function") await this.store.appendOutbox(outboxEvent);
    return appeal;
  }

  async getDecision(context, decisionId) {
    requireScope(context, "decision:read");
    const decision = await this.store.getDecision(context.tenantId, decisionId);
    if (decision === undefined) throw new VeilError("RESOURCE_NOT_FOUND", "Decision was not found.", 404);
    return decision.receipt === undefined ? { ...decision, legacy: true } : this.withEnforcementToken(decision);
  }

  async listAuditEvents(context, { limit = 50, cursor } = {}) {
    requireScope(context, "audit:read");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new VeilError("VALIDATION_FAILED", "limit must be an integer between 1 and 100.", 422);
    }
    const decodedCursor = cursor === undefined ? undefined : decodeAuditCursor(cursor);
    const events = await this.store.listAuditEvents(context.tenantId, { limit: limit + 1, cursor: decodedCursor });
    const hasMore = events.length > limit;
    const items = events.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeAuditCursor(last) : undefined
    };
  }

  async getPolicyOrThrow(tenantId, policyId, version) {
    if (version === undefined) {
      const getActivePolicyVersion = this.store.getActivePolicyVersion;
      if (typeof getActivePolicyVersion !== "function") {
        throw new VeilError("STORE_CAPABILITY_UNAVAILABLE", "Store does not support active policy bindings.", 501);
      }
      const active = await getActivePolicyVersion.call(this.store, tenantId, policyId);
      version = typeof active === "string" ? active : active?.version;
      if (!version) throw new VeilError("RESOURCE_NOT_FOUND", "Active policy version was not found.", 404);
    }
    const policy = await this.store.getPolicyVersion(tenantId, policyId, version);
    if (policy === undefined) throw new VeilError("RESOURCE_NOT_FOUND", "Policy version was not found.", 404);
    return policy;
  }

  async getDecisionPolicyOrThrow(tenantId, policyId, requestedVersion) {
    const getActivePolicyVersion = this.store.getActivePolicyVersion;
    if (typeof getActivePolicyVersion === "function") {
      const active = await getActivePolicyVersion.call(this.store, tenantId, policyId);
      const activeVersion = typeof active === "string" ? active : active?.version;
      if (activeVersion) return this.getPolicyOrThrow(tenantId, policyId, activeVersion);
    }
    return this.getPolicyOrThrow(tenantId, policyId, requestedVersion);
  }

  async setActivePolicyBinding(context, policyId, version, auditAction, auditReason) {
    context = withTrustedRequestId(context, this.newId);
    requireScope(context, "policy:write");
    const policy = await this.getPolicyOrThrow(context.tenantId, policyId, version);
    if (policy.status !== "published") {
      throw new VeilError("VALIDATION_FAILED", "Only published policy versions can be active.", 422);
    }
    const setActivePolicyVersion = this.store.setActivePolicyVersion;
    if (typeof setActivePolicyVersion !== "function") {
      throw new VeilError("STORE_CAPABILITY_UNAVAILABLE", "Store does not support active policy bindings.", 501);
    }
    const metadata = {
      actorId: context.actorId,
      activatedAt: this.clock.now().toISOString()
    };
    const auditEvent = this.createAuditEvent(context, auditAction, "policy", policyId, `${auditReason} ${policy.version}`, policy.contentHash);
    if (typeof this.store.commitPolicyBinding === "function") {
      await this.store.commitPolicyBinding({ tenantId: context.tenantId, policyId, version: policy.version, metadata, auditEvent });
    } else {
      await setActivePolicyVersion.call(this.store, context.tenantId, policyId, policy.version, metadata);
      await this.store.appendAudit(auditEvent);
    }
    return policy;
  }

  async audit(context, action, resourceType, resourceId, reason, evidenceHash) {
    await this.store.appendAudit(this.createAuditEvent(context, action, resourceType, resourceId, reason, evidenceHash));
  }

  createAuditEvent(context, action, resourceType, resourceId, reason, evidenceHash) {
    return {
      id: this.newId(),
      tenantId: context.tenantId,
      actorId: context.actorId,
      action,
      resourceType,
      resourceId,
      requestId: context.requestId,
      correlationId: context.correlationId,
      reason,
      evidenceHash,
      createdAt: this.clock.now().toISOString()
    };
  }

  createIdempotencyReplayAuditEvent(context, action, resourceType, resourceId, idempotencyKey) {
    return this.createAuditEvent(
      context,
      action,
      resourceType,
      resourceId,
      "idempotency response replayed",
      sha256({ operation: "idempotency-replay", tenantId: context.tenantId, idempotencyKey })
    );
  }

  async outbox(context, eventType, resourceId, payload) {
    if (typeof this.store.appendOutbox !== "function") return;
    await this.store.appendOutbox(this.createOutboxEvent(context, eventType, resourceId, payload));
  }

  createOutboxEvent(context, eventType, resourceId, payload) {
    return {
      id: this.newId(),
      eventType,
      tenantId: context.tenantId,
      resourceId,
      requestId: context.requestId,
      correlationId: context.correlationId,
      payload,
      occurredAt: this.clock.now().toISOString()
    };
  }

  async withEnforcementToken(decision) {
    if (decision.action !== "ALLOW" || !["model_call", "tool_call"].includes(decision.requestedAction) || this.enforcementTokenSigner === undefined || decision.receipt === undefined) return decision;
    return {
      ...decision,
      enforcementToken: await this.enforcementTokenSigner.issue(decision, decision.receipt.policyHash, new Date(decision.createdAt))
    };
  }
}

export const ENFORCEMENT_INPUT_HASH_VERSION = "veil-input-hash/1";

export function computeDecisionInputHash(request) {
  return sha256(policyInput(request));
}

function policyInput(request) {
  if (request.type === undefined) return request.input;
  return {
    ...request.input,
    type: request.type,
    agent: request.agent,
    resource: request.resource,
    dataClassification: request.dataClassification,
    model: request.model,
    estimatedCost: request.estimatedCost,
    attributes: request.attributes
  };
}

function encodeAuditCursor(event) {
  return Buffer.from(JSON.stringify({ createdAt: event.createdAt, id: event.id }), "utf8").toString("base64url");
}

function decodeAuditCursor(cursor) {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value.createdAt !== "string" || typeof value.id !== "string") throw new Error("invalid cursor");
    return value;
  } catch {
    throw new VeilError("VALIDATION_FAILED", "cursor is invalid.", 422);
  }
}

function requireScope(context, scope) {
  if (!context.scopes.includes(scope)) {
    throw new VeilError("TENANT_SCOPE_DENIED", "Request cannot access this operation.", 403);
  }
}

function withTrustedRequestId(context, newId) {
  return { ...context, requestId: readTrustedRequestId(context) ?? newId() };
}

function readIdempotency(record, fingerprint) {
  if (record === undefined) return undefined;
  if (record?.legacy === true || record?.fingerprint === undefined || record?.response === undefined) {
    throw new VeilError("IDEMPOTENCY_CONFLICT", "Legacy idempotency records cannot be safely replayed.", 409);
  }
  if (record.fingerprint !== fingerprint) {
    throw new VeilError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different request.", 409);
  }
  return record.response;
}

function writeIdempotency(fingerprint, response) {
  return { fingerprint, response };
}

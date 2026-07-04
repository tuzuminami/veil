import { randomUUID } from "node:crypto";
import { sha256 } from "../core/canonical.js";
import { VeilError } from "../core/errors.js";
import { decide, validatePolicyBundle } from "../core/policy.js";

export class VeilService {
  constructor(store, clock = { now: () => new Date() }, newId = randomUUID) {
    this.store = store;
    this.clock = clock;
    this.newId = newId;
  }

  async createDraft(context, policyId, bundle) {
    requireScope(context, "policy:write");
    validatePolicyBundle(bundle);
    const policy = {
      policyId,
      tenantId: context.tenantId,
      version: bundle.version,
      status: "draft",
      bundle,
      contentHash: sha256({ bundle, compilerVersion: "veil-policy-compiler/0.1.0" }),
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
    requireScope(context, "policy:write");
    const idemKey = `${context.tenantId}:publish:${policyId}:${version}:${idempotencyKey}`;
    const cached = await this.store.getIdempotency(idemKey);
    if (cached !== undefined) return cached;

    const policy = await this.getPolicyOrThrow(context.tenantId, policyId, version);
    if (policy.status === "published") {
      await this.store.setIdempotency(idemKey, policy);
      return policy;
    }
    const published = { ...policy, status: "published", publishedAt: this.clock.now().toISOString() };
    await this.store.savePolicyVersion(published);
    await this.store.setIdempotency(idemKey, published);
    await this.audit(context, "policy.version.published", "policy-version", `${policyId}@${version}`, "published", published.contentHash);
    return published;
  }

  async createDecision(context, request, idempotencyKey) {
    requireScope(context, "decision:write");
    const idemKey = `${context.tenantId}:decision:${idempotencyKey}`;
    const cached = await this.store.getIdempotency(idemKey);
    if (cached !== undefined) return cached;

    const policy = await this.getPolicyOrThrow(context.tenantId, request.policyId, request.version);
    const decisionInput = { ...request, tenantId: context.tenantId, correlationId: context.correlationId };
    const result = decide(policy, decisionInput);
    const inputHash = sha256(request.input);
    const decision = {
      id: this.newId(),
      tenantId: context.tenantId,
      policyId: request.policyId,
      version: request.version,
      action: result.action,
      reasonCodes: result.reasonCodes,
      obligations: result.obligations,
      matchedRuleId: result.matchedRule?.id,
      inputHash,
      evidenceHash: sha256({ policyHash: policy.contentHash, inputHash, result }),
      correlationId: context.correlationId,
      createdAt: this.clock.now().toISOString()
    };
    await this.store.saveDecision(decision);
    await this.store.setIdempotency(idemKey, decision);
    await this.audit(context, "decision.created", "decision", decision.id, decision.reasonCodes.join(","), decision.evidenceHash);
    await this.outbox(context, "veil.decision.created.v1", decision.id, { action: decision.action, policyId: decision.policyId, version: decision.version });
    return decision;
  }

  async createAppeal(context, request, idempotencyKey) {
    requireScope(context, "appeal:write");
    const idemKey = `${context.tenantId}:appeal:${idempotencyKey}`;
    const cached = await this.store.getIdempotency(idemKey);
    if (cached !== undefined) return cached;
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
      correlationId: context.correlationId,
      createdAt: this.clock.now().toISOString(),
      createdBy: context.actorId
    };
    await this.store.saveAppeal(appeal);
    await this.store.setIdempotency(idemKey, appeal);
    await this.audit(context, "appeal.created", "appeal", appeal.id, "appeal opened", sha256(appeal));
    await this.outbox(context, "veil.appeal.created.v1", appeal.id, { decisionId: appeal.decisionId, status: appeal.status });
    return appeal;
  }

  async getDecision(context, decisionId) {
    requireScope(context, "decision:read");
    const decision = await this.store.getDecision(context.tenantId, decisionId);
    if (decision === undefined) throw new VeilError("RESOURCE_NOT_FOUND", "Decision was not found.", 404);
    return decision;
  }

  async getPolicyOrThrow(tenantId, policyId, version) {
    const policy = await this.store.getPolicyVersion(tenantId, policyId, version);
    if (policy === undefined) throw new VeilError("RESOURCE_NOT_FOUND", "Policy version was not found.", 404);
    return policy;
  }

  async audit(context, action, resourceType, resourceId, reason, evidenceHash) {
    await this.store.appendAudit({
      id: this.newId(),
      tenantId: context.tenantId,
      actorId: context.actorId,
      action,
      resourceType,
      resourceId,
      correlationId: context.correlationId,
      reason,
      evidenceHash,
      createdAt: this.clock.now().toISOString()
    });
  }

  async outbox(context, eventType, resourceId, payload) {
    if (typeof this.store.appendOutbox !== "function") return;
    await this.store.appendOutbox({
      id: this.newId(),
      eventType,
      tenantId: context.tenantId,
      resourceId,
      correlationId: context.correlationId,
      payload,
      occurredAt: this.clock.now().toISOString()
    });
  }
}

function requireScope(context, scope) {
  if (!context.scopes.includes(scope)) {
    throw new VeilError("TENANT_SCOPE_DENIED", "Request cannot access this operation.", 403);
  }
}

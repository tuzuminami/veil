import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { VeilError } from "../core/errors.js";

const UPDATE_QUEUES = new Map();

const EMPTY = {
  policies: [],
  decisions: [],
  auditEvents: [],
  appeals: [],
  outboxEvents: [],
  idempotency: {},
  idempotencyRecords: [],
  activePolicyBindings: {},
  activePolicyBindingRecords: []
};

export class FileVeilStore {
  constructor(path) {
    this.path = resolve(path);
  }

  async getPolicyVersion(tenantId, policyId, version) {
    const data = await this.load();
    return data.policies.find((policy) => policy.tenantId === tenantId && policy.policyId === policyId && policy.version === version);
  }

  async savePolicyVersion(policy) {
    await this.update((data) => {
      const existingIndex = data.policies.findIndex(
        (item) => item.tenantId === policy.tenantId && item.policyId === policy.policyId && item.version === policy.version
      );
      if (existingIndex >= 0) {
        const existing = data.policies[existingIndex];
        if (existing?.status === "published" && existing.contentHash !== policy.contentHash) {
          throw new Error("published policy is immutable");
        }
        data.policies[existingIndex] = policy;
      } else {
        data.policies.push(policy);
      }
    });
  }

  async saveDecision(decision) {
    await this.update((data) => {
      data.decisions.push(decision);
    });
  }

  async getActivePolicyVersion(tenantId, policyId) {
    const data = await this.load();
    const binding = data.activePolicyBindingRecords?.find(
      (item) => item.tenantId === tenantId && item.policyId === policyId
    );
    if (binding !== undefined) return binding.version;
    return data.activePolicyBindings?.[`${tenantId}:${policyId}`]?.version;
  }

  async setActivePolicyVersion(tenantId, policyId, version, metadata = {}) {
    await this.update((data) => {
      data.activePolicyBindingRecords ??= [];
      const binding = {
        tenantId,
        policyId,
        version,
        activatedAt: metadata.activatedAt ?? new Date().toISOString(),
        activatedBy: metadata.actorId ?? "system"
      };
      const existingIndex = data.activePolicyBindingRecords.findIndex(
        (item) => item.tenantId === tenantId && item.policyId === policyId
      );
      if (existingIndex >= 0) data.activePolicyBindingRecords[existingIndex] = binding;
      else data.activePolicyBindingRecords.push(binding);
    });
  }

  async getDecision(tenantId, decisionId) {
    const data = await this.load();
    return data.decisions.find((decision) => decision.tenantId === tenantId && decision.id === decisionId);
  }

  async appendAudit(event) {
    await this.update((data) => {
      data.auditEvents.push(event);
    });
  }

  async appendOutbox(event) {
    await this.update((data) => {
      data.outboxEvents.push(event);
    });
  }

  async listAuditEvents(tenantId, { limit = Number.MAX_SAFE_INTEGER, cursor } = {}) {
    const data = await this.load();
    return data.auditEvents
      .filter((event) => event.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .filter((event) => cursor === undefined || event.createdAt < cursor.createdAt || (event.createdAt === cursor.createdAt && event.id < cursor.id))
      .slice(0, limit);
  }

  async getIdempotency(tenantId, key) {
    const data = await this.load();
    return findIdempotency(data, tenantId, key);
  }

  async setIdempotency(tenantId, key, value) {
    await this.update((data) => {
      const existing = findIdempotency(data, tenantId, key);
      if (existing !== undefined) {
        if (existing.fingerprint !== value?.fingerprint) throw idempotencyConflict();
        return;
      }
      saveIdempotency(data, tenantId, key, value);
    });
  }

  async saveAppeal(appeal) {
    await this.update((data) => {
      data.appeals.push(appeal);
    });
  }

  async getAppeal(tenantId, appealId) {
    const data = await this.load();
    return data.appeals.find((appeal) => appeal.tenantId === tenantId && appeal.id === appealId);
  }

  async healthCheck() {
    await this.load();
    return true;
  }

  async commitDecision({ decision, auditEvent, outboxEvent, idempotencyKey, idempotencyRecord }) {
    let response = decision;
    await this.update((data) => {
      const existing = findIdempotency(data, decision.tenantId, idempotencyKey);
      if (existing !== undefined && existing.fingerprint !== idempotencyRecord.fingerprint) {
        throw idempotencyConflict();
      }
      if (existing !== undefined) {
        response = existing.response;
        return;
      }
      data.decisions.push(decision);
      data.auditEvents.push(auditEvent);
      data.outboxEvents.push(outboxEvent);
      saveIdempotency(data, decision.tenantId, idempotencyKey, idempotencyRecord);
    });
    return response;
  }

  async commitPolicyPublish({ policy, auditEvent, idempotencyKey, idempotencyRecord }) {
    let response = policy;
    await this.update((data) => {
      const existingIdempotency = findIdempotency(data, policy.tenantId, idempotencyKey);
      if (existingIdempotency !== undefined) {
        if (existingIdempotency.fingerprint !== idempotencyRecord.fingerprint) throw idempotencyConflict();
        response = existingIdempotency.response;
        return;
      }
      const existingIndex = data.policies.findIndex(
        (item) => item.tenantId === policy.tenantId && item.policyId === policy.policyId && item.version === policy.version
      );
      if (existingIndex < 0) throw new Error("policy version does not exist");
      const existing = data.policies[existingIndex];
      if (existing.status === "published" && existing.contentHash !== policy.contentHash) throw new Error("published policy is immutable");
      data.policies[existingIndex] = policy;
      data.auditEvents.push(auditEvent);
      saveIdempotency(data, policy.tenantId, idempotencyKey, idempotencyRecord);
    });
    return response;
  }

  async commitPolicyBinding({ tenantId, policyId, version, metadata, auditEvent }) {
    await this.update((data) => {
      data.activePolicyBindingRecords ??= [];
      const binding = {
        tenantId,
        policyId,
        version,
        activatedAt: metadata.activatedAt,
        activatedBy: metadata.actorId
      };
      const existingIndex = data.activePolicyBindingRecords.findIndex(
        (item) => item.tenantId === tenantId && item.policyId === policyId
      );
      if (existingIndex >= 0) data.activePolicyBindingRecords[existingIndex] = binding;
      else data.activePolicyBindingRecords.push(binding);
      data.auditEvents.push(auditEvent);
    });
  }

  async commitAppeal({ appeal, auditEvent, outboxEvent, idempotencyKey, idempotencyRecord }) {
    let response = appeal;
    await this.update((data) => {
      const existing = findIdempotency(data, appeal.tenantId, idempotencyKey);
      if (existing !== undefined) {
        if (existing.fingerprint !== idempotencyRecord.fingerprint) throw idempotencyConflict();
        response = existing.response;
        return;
      }
      data.appeals.push(appeal);
      data.auditEvents.push(auditEvent);
      data.outboxEvents.push(outboxEvent);
      saveIdempotency(data, appeal.tenantId, idempotencyKey, idempotencyRecord);
    });
    return response;
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(EMPTY);
      throw error;
    }
  }

  async update(mutator) {
    const previous = UPDATE_QUEUES.get(this.path) ?? Promise.resolve();
    const run = previous.then(async () => {
      const data = await this.load();
      mutator(data);
      await mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.path);
    });
    UPDATE_QUEUES.set(this.path, run.catch(() => undefined));
    return run;
  }
}

function findIdempotency(data, tenantId, key) {
  const record = data.idempotencyRecords?.find((item) => item.tenantId === tenantId && item.key === key);
  if (record !== undefined) return { fingerprint: record.fingerprint, response: record.response };
  return data.idempotency?.[`${tenantId}:${key}`] ?? data.idempotency?.[key];
}

function saveIdempotency(data, tenantId, key, value) {
  data.idempotencyRecords ??= [];
  data.idempotencyRecords.push({ tenantId, key, fingerprint: value?.fingerprint, response: value?.response });
}

function idempotencyConflict() {
  return new VeilError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different request.", 409);
}

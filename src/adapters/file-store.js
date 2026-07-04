import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const EMPTY = {
  policies: [],
  decisions: [],
  auditEvents: [],
  appeals: [],
  outboxEvents: [],
  idempotency: {}
};

export class FileVeilStore {
  constructor(path) {
    this.path = path;
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

  async listAuditEvents(tenantId) {
    const data = await this.load();
    return data.auditEvents.filter((event) => event.tenantId === tenantId);
  }

  async getIdempotency(key) {
    const data = await this.load();
    return data.idempotency[key];
  }

  async setIdempotency(key, value) {
    await this.update((data) => {
      data.idempotency[key] = value;
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

  async load() {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(EMPTY);
      throw error;
    }
  }

  async update(mutator) {
    const data = await this.load();
    mutator(data);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

export class VeilClient {
  constructor({ baseUrl, token, tenantId, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.tenantId = tenantId;
    this.fetchImpl = fetchImpl;
  }

  createPolicy(policyId, bundle, headers = {}) {
    return this.request("POST", "/v1/policies", { policyId, bundle }, headers);
  }

  publishPolicy(policyId, version, idempotencyKey) {
    return this.request("POST", `/v1/policies/${encodeURIComponent(policyId)}/publish`, { version }, { "Idempotency-Key": idempotencyKey });
  }

  bindPolicy(policyId, version) {
    return this.request("POST", `/v1/policies/${encodeURIComponent(policyId)}/bind`, { version });
  }

  rollbackPolicy(policyId, version) {
    return this.request("POST", `/v1/policies/${encodeURIComponent(policyId)}/rollback`, { version });
  }

  async evaluateAccess(request, requestId) {
    return this.requestJson("POST", "/access/v1/evaluation", request, requestId === undefined ? {} : { "X-Request-ID": requestId });
  }

  createDecision(request, idempotencyKey) {
    return this.request("POST", "/v1/decisions", { request }, { "Idempotency-Key": idempotencyKey });
  }

  createAppeal(request, idempotencyKey) {
    return this.request("POST", "/v1/appeals", { request }, { "Idempotency-Key": idempotencyKey });
  }

  getDecision(decisionId) {
    return this.request("GET", `/v1/decisions/${encodeURIComponent(decisionId)}`);
  }

  listAuditEvents({ limit, cursor } = {}) {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set("limit", String(limit));
    if (cursor !== undefined) query.set("cursor", cursor);
    const suffix = query.size === 0 ? "" : `?${query}`;
    return this.request("GET", `/v1/audit-events${suffix}`);
  }

  async request(method, path, body, extraHeaders = {}) {
    const json = await this.requestJson(method, path, body, extraHeaders);
    return json.data;
  }

  async requestJson(method, path, body, extraHeaders = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "X-Tenant-Id": this.tenantId,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...extraHeaders
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json = await response.json();
    if (!response.ok) {
      const error = new Error(json.error?.message ?? "VEIL request failed");
      error.response = json;
      throw error;
    }
    return json;
  }
}

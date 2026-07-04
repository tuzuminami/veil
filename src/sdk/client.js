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

  createDecision(request, idempotencyKey) {
    return this.request("POST", "/v1/decisions", { request }, { "Idempotency-Key": idempotencyKey });
  }

  createAppeal(request, idempotencyKey) {
    return this.request("POST", "/v1/appeals", { request }, { "Idempotency-Key": idempotencyKey });
  }

  getDecision(decisionId) {
    return this.request("GET", `/v1/decisions/${encodeURIComponent(decisionId)}`);
  }

  async request(method, path, body, extraHeaders = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "X-Tenant-Id": this.tenantId,
        "Content-Type": "application/json",
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
    return json.data;
  }
}

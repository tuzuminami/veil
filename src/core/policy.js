import { VeilError } from "./errors.js";

const ACTIONS = new Set(["ALLOW", "TRANSFORM", "REQUIRE_CONFIRMATION", "BLOCK", "ESCALATE"]);
const SAFE_DEFAULTS = new Set(["BLOCK", "ESCALATE"]);
const OPERATORS = new Set(["equals", "contains", "absent", "greaterThan", "lessThanOrEqual"]);
const CLASSIFICATIONS = new Set(["public", "internal", "confidential", "restricted"]);

export function validatePolicyBundle(bundle) {
  const errors = [];
  if (!bundle || typeof bundle !== "object") errors.push("bundle must be an object");
  if (!bundle?.name?.trim?.()) errors.push("name is required");
  if (!bundle?.version?.trim?.()) errors.push("version is required");
  if (!SAFE_DEFAULTS.has(bundle?.defaultAction)) errors.push("defaultAction must be BLOCK or ESCALATE");
  if (!Array.isArray(bundle?.rules) || bundle.rules.length === 0) errors.push("at least one rule is required");

  const ids = new Set();
  for (const rule of bundle?.rules ?? []) {
    validateRule(rule, ids, errors);
  }

  if (errors.length > 0) {
    throw new VeilError("VALIDATION_FAILED", "Policy bundle is invalid.", 422, errors);
  }
}

export function decide(policy, request) {
  if (policy.status !== "published") {
    throw new VeilError("VALIDATION_FAILED", "Policy version is not published.", 422);
  }
  if (policy.tenantId !== request.tenantId) {
    throw new VeilError("TENANT_SCOPE_DENIED", "Request cannot access this policy.", 403);
  }
  if (request.adapterResult?.status === "timeout") {
    return { action: "ESCALATE", reasonCodes: ["ADAPTER_TIMEOUT_FAIL_CLOSED"], obligations: [] };
  }
  if (request.adapterResult?.status === "unknown") {
    return { action: "BLOCK", reasonCodes: ["ADAPTER_UNKNOWN_FAIL_CLOSED"], obligations: [] };
  }
  if (request.adapterResult !== undefined && request.adapterResult.status !== "ok") {
    return { action: "BLOCK", reasonCodes: ["ADAPTER_AMBIGUOUS_FAIL_CLOSED"], obligations: [] };
  }
  if (request.adapterResult?.status === "ok" && !ACTIONS.has(request.adapterResult.result)) {
    return { action: "BLOCK", reasonCodes: ["ADAPTER_AMBIGUOUS_FAIL_CLOSED"], obligations: [] };
  }

  const ordered = [...policy.bundle.rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const rule of ordered) {
    if (matches(rule, request.input)) {
      return {
        action: rule.effect,
        matchedRule: rule,
        reasonCodes: [rule.reasonCode],
        obligations: rule.obligations ?? []
      };
    }
  }

  return { action: policy.bundle.defaultAction, reasonCodes: ["NO_MATCH_FAIL_CLOSED"], obligations: [] };
}

export function validateDecisionRequest(request) {
  const errors = [];
  if (!request || typeof request !== "object" || Array.isArray(request)) errors.push("request must be an object");
  if (!request?.policyId?.trim?.()) errors.push("policyId is required");
  if (request?.version !== undefined && !request.version?.trim?.()) errors.push("version must be a non-empty string when provided");
  if (!request?.input || typeof request.input !== "object" || Array.isArray(request.input)) errors.push("input must be an object");

  const typedFields = ["type", "agent", "resource", "dataClassification", "model", "estimatedCost", "attributes"];
  if (typedFields.some((field) => request?.[field] !== undefined)) validatePreExecutionRequest(request, errors);

  if (errors.length > 0) {
    throw new VeilError("VALIDATION_FAILED", "Decision request is invalid.", 422, errors);
  }
}

function validateRule(rule, ids, errors) {
  if (!rule?.id?.trim?.()) errors.push("rule.id is required");
  if (ids.has(rule?.id)) errors.push(`duplicate rule id: ${rule.id}`);
  ids.add(rule?.id);
  if (!Number.isInteger(rule?.priority) || rule.priority < 0) errors.push(`rule ${rule?.id ?? "<unknown>"} priority must be a non-negative integer`);
  if (!ACTIONS.has(rule?.effect)) errors.push(`rule ${rule?.id ?? "<unknown>"} has unknown effect`);
  if (!rule?.match?.field?.trim?.()) errors.push(`rule ${rule?.id ?? "<unknown>"} match.field is required`);
  if (rule?.match?.field?.split?.(".").some((segment) => ["__proto__", "prototype", "constructor"].includes(segment))) {
    errors.push(`rule ${rule?.id ?? "<unknown>"} match.field contains an unsafe path segment`);
  }
  if (!OPERATORS.has(rule?.match?.operator)) errors.push(`rule ${rule?.id ?? "<unknown>"} has unknown operator`);
  const valueType = typeof rule?.match?.value;
  if (rule?.match?.operator !== "absent" && !["string", "number", "boolean"].includes(valueType)) {
    errors.push(`rule ${rule?.id ?? "<unknown>"} match.value is required`);
  }
  if (["greaterThan", "lessThanOrEqual"].includes(rule?.match?.operator) && valueType !== "number") {
    errors.push(`rule ${rule?.id ?? "<unknown>"} numeric operator requires a numeric value`);
  }
  if (!rule?.reasonCode?.trim?.()) errors.push(`rule ${rule?.id ?? "<unknown>"} reasonCode is required`);
}

function validatePreExecutionRequest(request, errors) {
  if (!["model_call", "tool_call"].includes(request.type)) errors.push("type must be model_call or tool_call");
  if (!request.agent || typeof request.agent !== "object" || !request.agent.id?.trim?.()) errors.push("agent.id is required");
  if (!request.resource || typeof request.resource !== "object" || !request.resource.id?.trim?.() || !request.resource.type?.trim?.()) {
    errors.push("resource.id and resource.type are required");
  }
  if (!CLASSIFICATIONS.has(request.resource?.classification)) errors.push("resource.classification must be public, internal, confidential, or restricted");
  if (!CLASSIFICATIONS.has(request.dataClassification)) errors.push("dataClassification must be public, internal, confidential, or restricted");
  if (!request.model || typeof request.model !== "object" || !request.model.provider?.trim?.() || !request.model.id?.trim?.()) {
    errors.push("model.provider and model.id are required");
  }
  if (typeof request.estimatedCost !== "number" || !Number.isFinite(request.estimatedCost) || request.estimatedCost < 0) {
    errors.push("estimatedCost must be a non-negative finite number");
  }
  if (!request.attributes || typeof request.attributes !== "object" || Array.isArray(request.attributes)) errors.push("attributes must be an object");
}

function matches(rule, input) {
  const value = valueAtPath(input, rule.match.field);
  if (rule.match.operator === "absent") return value === undefined || value === null || value === "";
  if (rule.match.operator === "equals") return value === rule.match.value;
  if (rule.match.operator === "contains") return typeof value === "string" && value.includes(rule.match.value ?? "");
  if (typeof value !== "number" || typeof rule.match.value !== "number") return false;
  if (rule.match.operator === "greaterThan") return value > rule.match.value;
  return value <= rule.match.value;
}

function valueAtPath(input, path) {
  return path.split(".").reduce((current, key) => {
    if (current === null || typeof current !== "object") return undefined;
    return current[key];
  }, input);
}

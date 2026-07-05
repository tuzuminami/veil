import { VeilError } from "./errors.js";

const ACTIONS = new Set(["ALLOW", "TRANSFORM", "REQUIRE_CONFIRMATION", "BLOCK", "ESCALATE"]);
const SAFE_DEFAULTS = new Set(["BLOCK", "ESCALATE"]);
const OPERATORS = new Set(["equals", "contains", "absent"]);

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

function validateRule(rule, ids, errors) {
  if (!rule?.id?.trim?.()) errors.push("rule.id is required");
  if (ids.has(rule?.id)) errors.push(`duplicate rule id: ${rule.id}`);
  ids.add(rule?.id);
  if (!Number.isInteger(rule?.priority) || rule.priority < 0) errors.push(`rule ${rule?.id ?? "<unknown>"} priority must be a non-negative integer`);
  if (!ACTIONS.has(rule?.effect)) errors.push(`rule ${rule?.id ?? "<unknown>"} has unknown effect`);
  if (!rule?.match?.field?.trim?.()) errors.push(`rule ${rule?.id ?? "<unknown>"} match.field is required`);
  if (!OPERATORS.has(rule?.match?.operator)) errors.push(`rule ${rule?.id ?? "<unknown>"} has unknown operator`);
  if (rule?.match?.operator !== "absent" && typeof rule?.match?.value !== "string") {
    errors.push(`rule ${rule?.id ?? "<unknown>"} match.value is required`);
  }
  if (!rule?.reasonCode?.trim?.()) errors.push(`rule ${rule?.id ?? "<unknown>"} reasonCode is required`);
}

function matches(rule, input) {
  const value = valueAtPath(input, rule.match.field);
  if (rule.match.operator === "absent") return value === undefined || value === null || value === "";
  if (typeof value !== "string") return false;
  if (rule.match.operator === "equals") return value === rule.match.value;
  return value.includes(rule.match.value ?? "");
}

function valueAtPath(input, path) {
  return path.split(".").reduce((current, key) => {
    if (current === null || typeof current !== "object") return undefined;
    return current[key];
  }, input);
}

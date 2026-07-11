import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { VeilError } from "../core/errors.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const decisionRequest = compile("../../schemas/decision-request.schema.json");
const policyBundle = compile("../../schemas/policy-bundle.schema.json");

export function assertDecisionRequestSchema(value) {
  assertValid(decisionRequest, value, "Decision request does not match the public JSON Schema.");
}

export function assertPolicyBundleSchema(value) {
  assertValid(policyBundle, value, "Policy bundle does not match the public JSON Schema.");
}

function compile(relativePath) {
  const schema = JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
  return ajv.compile(schema);
}

function assertValid(validate, value, message) {
  if (validate(value)) return;
  const details = (validate.errors ?? []).map((error) => {
    const path = error.instancePath || "/";
    return `${path} ${error.message ?? "is invalid"}`;
  });
  throw new VeilError("VALIDATION_FAILED", message, 422, details);
}

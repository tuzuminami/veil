import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";
import { validateDecisionRequest, validatePolicyBundle } from "../src/core/policy.js";

const decisionRequestSchema = JSON.parse(readFileSync("schemas/decision-request.schema.json", "utf8"));
const openapi = YAML.parse(readFileSync("openapi/openapi.yaml", "utf8"));

const typedFields = [
  "type",
  "agent",
  "resource",
  "dataClassification",
  "model",
  "estimatedCost",
  "attributes"
];

const legacyRequest = {
  policyId: "policy-main",
  version: "1.0.0",
  input: { risk: "low" }
};

const typedRequest = {
  ...legacyRequest,
  type: "model_call",
  agent: { id: "support-agent" },
  resource: { id: "chat-completion", type: "ai-operation", classification: "internal" },
  dataClassification: "confidential",
  model: { provider: "openai", id: "gpt-5" },
  estimatedCost: 0.002,
  attributes: { purpose: "support" }
};

const policyBundle = {
  name: "support-policy",
  version: "1.0.0",
  defaultAction: "BLOCK",
  rules: [{
    id: "allow-low-risk",
    priority: 10,
    effect: "ALLOW",
    match: { field: "risk", operator: "equals", value: "low" },
    reasonCode: "LOW_RISK_ALLOWED"
  }]
};

const invalidWhitespacePolicyBundles = [
  ["name"],
  ["version"],
  ["rules", 0, "id"],
  ["rules", 0, "match", "field"],
  ["rules", 0, "reasonCode"]
].map((path) => {
  const value = structuredClone(policyBundle);
  let target = value;
  for (const key of path.slice(0, -1)) target = target[key];
  target[path.at(-1)] = "   ";
  return value;
});

function dereferenceOpenApi(schema, schemas) {
  if (schema?.$ref) return dereferenceOpenApi(schemas[schema.$ref.split("/").at(-1)], schemas);
  if (Array.isArray(schema)) return schema.map((entry) => dereferenceOpenApi(entry, schemas));
  if (schema && typeof schema === "object") {
    return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, dereferenceOpenApi(value, schemas)]));
  }
  return schema;
}

test("DecisionRequest accepts legacy and fully typed contracts only", () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(decisionRequestSchema);

  assert.equal(validate(legacyRequest), true);
  assert.equal(validate(typedRequest), true);

  for (const field of typedFields) {
    const partial = { ...typedRequest };
    delete partial[field];
    assert.equal(validate(partial), false, `missing typed field ${field} must fail validation`);
  }

  const openapiTyped = structuredClone(openapi.components.schemas.DecisionRequest.oneOf[1]);
  openapiTyped.properties.agent = openapi.components.schemas.Agent;
  openapiTyped.properties.resource = structuredClone(openapi.components.schemas.AiResource);
  openapiTyped.properties.resource.properties.classification = openapi.components.schemas.DataClassification;
  openapiTyped.properties.dataClassification = openapi.components.schemas.DataClassification;
  openapiTyped.properties.model = openapi.components.schemas.Model;
  delete openapiTyped.properties.adapterResult;
  const validateOpenApi = new Ajv2020({ allErrors: true, strict: true }).compile(openapiTyped);

  for (const invalidValue of ["", "   "]) {
    const invalid = { ...typedRequest, agent: { id: invalidValue } };
    assert.equal(validate(invalid), false, "JSON Schema must reject blank agent.id");
    assert.equal(validateOpenApi(invalid), false, "OpenAPI must reject blank agent.id");
    assert.throws(() => validateDecisionRequest(invalid), /Decision request is invalid/);
  }
});

test("AuthZEN request contract remains unchanged", () => {
  const authzen = openapi.components.schemas.AuthZenEvaluationRequest;
  assert.deepEqual(authzen.required, ["subject", "action", "resource"]);
  assert.deepEqual(authzen.properties, {
    subject: { $ref: "#/components/schemas/AuthZenEntity" },
    action: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" }, properties: { type: "object" } }
    },
    resource: { $ref: "#/components/schemas/AuthZenEntity" },
    context: { type: "object" }
  });
});

test("Decision distinguishes legacy responses from receipt-bearing current responses", () => {
  const schemas = structuredClone(openapi.components.schemas);
  const resolveRef = (schema) => {
    if (schema?.$ref) return resolveRef(schemas[schema.$ref.split("/").at(-1)]);
    if (Array.isArray(schema)) return schema.map(resolveRef);
    if (schema && typeof schema === "object") {
      return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, resolveRef(value)]));
    }
    return schema;
  };
  const decision = {
    oneOf: schemas.Decision.oneOf.map(resolveRef)
  };
  const validate = new Ajv2020({ strict: true, validateFormats: false }).compile({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...decision
  });
  const legacyDecision = {
    id: "decision-1",
    tenantId: "tenant-a",
    policyId: "policy-main",
    version: "0.2.0",
    action: "ALLOW",
    reasonCodes: ["LOW_RISK_ALLOWED"],
    obligations: [],
    inputHash: "input-hash",
    evidenceHash: "evidence-hash",
    correlationId: "corr-1",
    createdAt: "2026-07-12T00:00:00.000Z",
    legacy: true
  };

  assert.equal(validate(legacyDecision), true);
  assert.equal(validate({ ...legacyDecision, legacy: undefined }), false);
  assert.equal(validate({ ...legacyDecision, legacy: false }), false);

  const currentDecision = {
    ...legacyDecision,
    version: "1.0.0",
    legacy: false,
    receipt: {
      receiptVersion: "veil-decision-receipt/1.0",
      decisionId: legacyDecision.id,
      tenantId: legacyDecision.tenantId,
      policyId: legacyDecision.policyId,
      policyVersion: "1.0.0",
      policyHash: "policy-hash",
      action: legacyDecision.action,
      reasonCodes: legacyDecision.reasonCodes,
      obligations: legacyDecision.obligations,
      inputHash: legacyDecision.inputHash,
      evidenceHash: legacyDecision.evidenceHash,
      correlationId: legacyDecision.correlationId,
      createdAt: legacyDecision.createdAt,
      receiptHash: "receipt-hash"
    }
  };
  assert.equal(validate(currentDecision), true);
  assert.equal(validate({ ...currentDecision, legacy: true }), false);
  const { receipt, ...receiptlessCurrent } = currentDecision;
  assert.equal(validate(receiptlessCurrent), false);
});

test("PolicyBundle rejects whitespace-only required strings across contracts", () => {
  const validateJsonSchema = new Ajv2020({ allErrors: true, strict: true }).compile(
    JSON.parse(readFileSync("schemas/policy-bundle.schema.json", "utf8"))
  );
  const validateOpenApi = new Ajv2020({ allErrors: true, strict: true }).compile({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...dereferenceOpenApi(openapi.components.schemas.PolicyBundleDraft, openapi.components.schemas)
  });

  for (const invalid of invalidWhitespacePolicyBundles) {
    assert.throws(() => validatePolicyBundle(invalid), /Policy bundle is invalid/);
    assert.equal(validateJsonSchema(invalid), false);
    assert.equal(validateOpenApi(invalid), false);
  }
});

import { sha256 } from "./canonical.js";

const RECEIPT_VERSION = "veil-decision-receipt/1.0";

export function createDecisionReceipt(decision, policyHash) {
  const receipt = {
    receiptVersion: RECEIPT_VERSION,
    decisionId: decision.id,
    tenantId: decision.tenantId,
    policyId: decision.policyId,
    policyVersion: decision.version,
    policyHash,
    action: decision.action,
    reasonCodes: decision.reasonCodes,
    obligations: decision.obligations,
    matchedRuleId: decision.matchedRuleId,
    inputHash: decision.inputHash,
    evidenceHash: decision.evidenceHash,
    requestId: decision.requestId,
    correlationId: decision.correlationId,
    createdAt: decision.createdAt
  };
  return { ...receipt, receiptHash: sha256(receipt) };
}

export function verifyDecisionReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || typeof receipt.receiptHash !== "string") return false;
  const { receiptHash, ...contents } = receipt;
  return receiptHash === sha256(contents);
}

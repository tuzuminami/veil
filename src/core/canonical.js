import { createHash } from "node:crypto";

export function canonicalJson(value) {
  return JSON.stringify(toCanonical(value));
}

export function sha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function toCanonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toCanonical(item));
  }
  if (typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child !== undefined) sorted[key] = toCanonical(child);
    }
    return sorted;
  }
  return String(value);
}

export const CORE_API_VERSION = "0.1.0";

export function validatePluginManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object") errors.push("manifest must be an object");
  if (!manifest?.name?.trim?.()) errors.push("name is required");
  if (!manifest?.version?.trim?.()) errors.push("version is required");
  if (!manifest?.coreApiVersion?.startsWith("0.1.")) errors.push("coreApiVersion is incompatible");
  if (!Array.isArray(manifest?.capabilities) || manifest.capabilities.length === 0) errors.push("capabilities are required");
  return { valid: errors.length === 0, errors };
}

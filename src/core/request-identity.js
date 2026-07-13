const TRUSTED_REQUEST_ID = Symbol("veil.trusted-request-id");

// This helper is intentionally not exported from the package public surface.
// Only trusted transports can attach an ingress-generated identity.
export function attachTrustedRequestId(context, requestId) {
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 200) {
    throw new TypeError("Trusted request ID must be a bounded string.");
  }
  return { ...context, [TRUSTED_REQUEST_ID]: requestId };
}

export function readTrustedRequestId(context) {
  return context?.[TRUSTED_REQUEST_ID];
}

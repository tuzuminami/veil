# ADR-003: Separate trusted request identity from caller correlation

## Status

Accepted for VEIL v1 public API.

## Decision

VEIL creates a UUID request identity at HTTP ingress for every request. It is
returned in the `X-Request-ID` response header and is the primary identity for
service logs, traces, and security evidence. A caller cannot choose or replace
this value.

`X-Correlation-ID` is optional caller-supplied context. For compatibility,
`X-Request-ID` on an inbound request is treated only as an external correlation
identifier when `X-Correlation-ID` is absent. External identifiers are bounded
to 200 ASCII identifier characters (`A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, `/`,
`=`, `+`, and `-`) and are stored separately from the server request identity.

Tenant ownership remains authoritative in authenticated credentials. A caller
correlation identifier does not grant tenant access and must not be used as a
tenant key, idempotency key, or authorization decision identity.

An idempotent replay keeps the original decision receipt and its request ID
immutable. VEIL records the replay as a separate audit event with the current
trusted transport request ID; it does not emit a duplicate outbox event.

## Consequences

Operators can correlate a composed request across VEIL, RELAY, PULSE, and
other services without allowing an external party to impersonate the server's
forensic identity. Consumers should propagate the response `X-Request-ID` as
an external correlation value to downstream systems and retain both values in
their own audit records.

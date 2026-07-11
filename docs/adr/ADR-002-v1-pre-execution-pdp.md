# ADR-002: VEIL v1 Is an AI Pre-Execution PDP

## Status

Accepted for v1.0.0.

## Context

AI agents need an authorization decision before model and tool execution. A generic policy language or moderation product would broaden the surface without proving a distinct adoption path.

## Decision

VEIL v1 focuses on synchronous `model_call` and `tool_call` decisions. The request contract carries the agent, resource and data classification, model identity, estimated cost, and extension attributes. Policies are immutable after publication and a tenant-scoped active binding selects the version used when callers omit one.

Each decision returns an enforcement action, stable reason codes, obligations, policy evidence, and a canonical tamper-evident receipt. `BLOCK` is the default. PostgreSQL production writes for the decision, receipt, audit event, outbox event, and idempotency record are atomic.

Production authentication verifies JWT issuer, audience, algorithm, signature, expiry, subject, tenant, and scopes. The tenant comes from the verified claim; a tenant header can only narrow or confirm requested context.

VEIL also exposes the AuthZEN Authorization API 1.0 single access-evaluation JSON contract. The compatibility claim is limited to that endpoint and does not imply full AuthZEN conformance.

## Consequences

- Model and tool consumers get one stable pre-execution contract.
- PULSE owns replay and shadow evaluation rather than VEIL.
- RELAY can enforce VEIL decisions as a separate PEP.
- Dynamic plugins, a policy GUI, transformation execution, and multi-region operation remain out of scope for v1.

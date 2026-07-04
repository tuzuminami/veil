# ADR-001: Hexagonal Core With Fail-Closed Policy Decisions

## Status

Accepted.

## Context

VEIL needs to run as an embeddable policy decision component without coupling its core behavior to a specific HTTP framework, database driver, classifier, or model provider.

## Decision

The repository separates:

- domain policy validation and decision logic;
- application use cases for idempotency, audit, and outbox events;
- adapters for persistence and external boundaries;
- HTTP transport and SDK convenience layers.

Published policy versions are immutable. Unknown or timed-out adapter results return safe decisions rather than `ALLOW`.

## Consequences

- Core logic can be tested deterministically without network services.
- Production persistence can evolve behind an adapter while preserving the public API.
- Dynamic plugin loading remains outside the first slice until manifest compatibility and timeout behavior are fully specified.

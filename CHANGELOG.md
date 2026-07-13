# Changelog

## 1.0.1 - 2026-07-13

- Aligned the default VEIL enforcement-token audience with RELAY's canonical `relay-api` contract and added a pinned production-signer-to-RELAY-verifier compatibility gate. Documented coordinated audience cutover and rollback because a mixed fleet fails closed.
- Published the installable package as a versioned GitHub Release asset instead of claiming npm registry availability.
- Added release-event verification that downloads, installs, and executes the packaged migration CLI after publication; the existing package smoke test remains the pre-publication gate.

## 1.0.0 - 2026-07-12

- Focused VEIL on fail-closed AI agent model and tool pre-execution decisions.
- Added typed agent, resource, classification, model, attribute, and numeric cost policy inputs.
- Added immutable active policy bindings with audited rollback.
- Added canonical tamper-evident decision receipts and verification helper.
- Added an AuthZEN Authorization API 1.0-compatible single evaluation endpoint.
- Added production OIDC/JWT authentication and PostgreSQL persistence with atomic evidence and idempotency writes.
- Added runtime JSON Schema validation, bounded JSON requests, dependency-backed readiness, pinned CI actions, dependency audit, package install smoke tests, and SBOM generation.
- Added production migration, backup, restore, rollback, and security documentation.

## 0.2.0 - 2026-07-05

- Hardened OpenAPI response contracts with explicit success envelopes, stable error envelopes, and common failure responses.
- Added release checks that verify version alignment, Apache-2.0 metadata, standard `LICENSE` packaging, and OpenAPI contract guardrails.
- Added GitHub Actions CI for verification and package dry-run.
- Added a public release runbook with GitHub license detection, verification, and rollback steps.

## 0.1.0 - 2026-07-05

- Added fail-closed policy bundle validation, publication, and decision flow.
- Added audit evidence, idempotency records, outbox events, appeal creation, and tenant/scope checks.
- Added OpenAPI 3.1, JSON Schemas, JavaScript SDK, PostgreSQL migration, public boundary guard, and public project documentation.
- Added package exports and repository metadata for the public JavaScript package.
- Standardized the root license file so GitHub can display Apache-2.0 in repository metadata.
- Returned stable validation errors for malformed JSON request bodies.
- Removed private operator and requirements material from the public tree and added release-artifact exclusions.

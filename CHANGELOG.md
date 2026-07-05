# Changelog

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

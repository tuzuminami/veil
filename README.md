# VEIL

VEIL is a local-first policy decision point for conversational AI systems. It evaluates versioned policy bundles before a product accepts input, returns model output, or starts a tool action.

The default posture is fail-closed: unknown policy state, missing authorization, malformed rules, adapter timeout, or ambiguous classifier output cannot silently become `ALLOW`.

## What It Does

- Creates and validates declarative policy bundles.
- Publishes immutable policy versions.
- Returns `ALLOW`, `TRANSFORM`, `REQUIRE_CONFIRMATION`, `BLOCK`, or `ESCALATE`.
- Stores audit evidence with policy version, matched rule, input hash, evidence hash, actor, tenant, and correlation ID.
- Enforces development auth scopes, tenant isolation, idempotency, and stable error envelopes.
- Provides OpenAPI 3.1, JSON Schemas, a small JavaScript SDK, and a public private-boundary guard.

## Non-Goals

- VEIL is not a chat UI, identity provider, billing system, legal certification, or general moderation dashboard.
- VEIL does not prove a user's age or identity by itself.
- VEIL does not call external LLMs in the core path.

## Quick Start

```bash
pnpm run verify
node src/server.js
```

The development auth adapter accepts bearer tokens in this format:

```text
Authorization: Bearer dev:<tenant-id>:<actor-id>:<comma-separated-scopes>
X-Tenant-Id: <tenant-id>
```

Example scopes:

```text
policy:write,policy:read,decision:write,decision:read,appeal:write
```

## Example Flow

Create a policy:

```bash
curl -s http://127.0.0.1:8080/v1/policies \
  -H 'Authorization: Bearer dev:tenant-a:alice:policy:write,policy:read,decision:write,decision:read,appeal:write' \
  -H 'X-Tenant-Id: tenant-a' \
  -H 'X-Correlation-Id: corr-demo' \
  -H 'Content-Type: application/json' \
  -d '{
    "policyId": "baseline",
    "bundle": {
      "name": "baseline",
      "version": "1.0.0",
      "defaultAction": "BLOCK",
      "rules": [
        {
          "id": "allow-low-risk",
          "priority": 10,
          "effect": "ALLOW",
          "match": { "field": "risk", "operator": "equals", "value": "low" },
          "reasonCode": "LOW_RISK_ALLOWED"
        },
        {
          "id": "age-unmet",
          "priority": 0,
          "effect": "REQUIRE_CONFIRMATION",
          "match": { "field": "ageAssurance.status", "operator": "equals", "value": "unmet" },
          "reasonCode": "AGE_ASSURANCE_REQUIRED"
        }
      ]
    }
  }'
```

Publish it:

```bash
curl -s http://127.0.0.1:8080/v1/policies/baseline/publish \
  -H 'Authorization: Bearer dev:tenant-a:alice:policy:write,decision:write,decision:read' \
  -H 'X-Tenant-Id: tenant-a' \
  -H 'Idempotency-Key: publish-baseline-1' \
  -H 'Content-Type: application/json' \
  -d '{ "version": "1.0.0" }'
```

Create a decision:

```bash
curl -s http://127.0.0.1:8080/v1/decisions \
  -H 'Authorization: Bearer dev:tenant-a:alice:decision:write,decision:read' \
  -H 'X-Tenant-Id: tenant-a' \
  -H 'Idempotency-Key: decision-1' \
  -H 'Content-Type: application/json' \
  -d '{
    "request": {
      "policyId": "baseline",
      "version": "1.0.0",
      "input": { "risk": "low" }
    }
  }'
```

An adapter timeout or unknown result returns a safe result, not `ALLOW`:

```json
{
  "request": {
    "policyId": "baseline",
    "version": "1.0.0",
    "input": { "risk": "low" },
    "adapterResult": { "status": "timeout", "source": "classifier" }
  }
}
```

## Repository Layout

```text
src/core/           domain validation, canonicalization, and decision logic
src/application/    use cases, idempotency, audit, and outbox orchestration
src/adapters/       local persistence adapter
src/transport/      HTTP transport and error envelope
src/plugins/        public plugin manifest compatibility helpers
src/sdk/            small JavaScript client
openapi/            OpenAPI 3.1 contract
schemas/            JSON Schema contracts
migrations/         PostgreSQL schema for production adapters
tests/              public synthetic tests
scripts/            quality and private-boundary checks
```

## Commands

```bash
pnpm run build
pnpm run test
pnpm run check:private-boundary
pnpm run check:release
pnpm run verify
```

`docker compose up` starts PostgreSQL for production-adapter work. The current local development adapter is file-backed so the core flow remains dependency-light and deterministic while production persistence is implemented behind the same store contract.

## Security Notes

- Do not use the development bearer token adapter in production.
- Store secrets through a separate secret manager or adapter. Do not place raw secrets in policy bundles, fixtures, logs, or exports.
- Tenant ID in a header is requested context, not proof of authorization.
- Audit records store hashes and metadata instead of raw conversational content.

## Known Limitations

- PostgreSQL persistence is defined by migration and ready for adapter implementation, while the current runnable local adapter is file-backed.
- The plugin host is represented by a public manifest compatibility helper; dynamic plugin loading is intentionally out of scope for this first slice.
- OpenAPI is authored directly and should be generated from a single source of truth in a later release.

## Release Readiness

Public releases follow [docs/runbooks/release.md](./docs/runbooks/release.md). The release gate verifies local tests, private-boundary checks, package contents, version alignment, and GitHub's Apache-2.0 license detection.

## License

Apache-2.0. The repository uses the standard root [LICENSE](./LICENSE) file so GitHub can display the license in its repository metadata.

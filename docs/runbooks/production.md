# Production Runbook

## Supported Baseline

- Node.js 22 or newer.
- PostgreSQL 16 or newer.
- OIDC issuer with an HTTPS JWKS endpoint.
- HTTPS between the policy enforcement point and VEIL, terminated by VEIL or a trusted reverse proxy.

## Required Configuration

- `NODE_ENV=production`
- `DATABASE_URL`
- `VEIL_OIDC_ISSUER`
- `VEIL_OIDC_AUDIENCE`
- `VEIL_OIDC_JWKS_URL`
- `VEIL_AUTHZEN_POLICY_ID`
- `VEIL_ENFORCEMENT_PRIVATE_KEY` (an Ed25519 PKCS#8 PEM supplied by the secret manager)
- `VEIL_ENFORCEMENT_KEY_ID`
- `VEIL_ENFORCEMENT_ISSUER`

Optional configuration:

- `VEIL_OIDC_TENANT_CLAIM` defaults to `tenant_id`.
- `VEIL_OIDC_SCOPE_CLAIM` defaults to `scope`.
- `VEIL_OIDC_ALGORITHMS` defaults to `RS256` and accepts a comma-separated allowlist.
- `VEIL_MAX_BODY_BYTES` defaults to `1048576`.
- `VEIL_REQUEST_TIMEOUT_MS` defaults to `10000`.
- `VEIL_HEADERS_TIMEOUT_MS` and `VEIL_KEEP_ALIVE_TIMEOUT_MS` default to `5000`.
- `VEIL_PG_POOL_MAX` defaults to `10`.
- `VEIL_PG_CONNECT_TIMEOUT_MS` defaults to `5000`.
- `VEIL_PG_IDLE_TIMEOUT_MS` defaults to `30000`.
- `VEIL_PG_SSL=require` enables certificate-verifying PostgreSQL TLS.
- `VEIL_ENFORCEMENT_AUDIENCE` defaults to `relay-api`, the v1 RELAY audience. If it is overridden, configure the identical value as `RELAY_VEIL_AUDIENCE` before deploying either side; a mismatch is a fail-closed 403 at RELAY.
- `VEIL_ENFORCEMENT_TTL_SECONDS` defaults to `60` and must not exceed `300`.
- `VEIL_ENFORCEMENT_PREVIOUS_PUBLIC_JWKS` is an optional JSON array of previous Ed25519 public JWKs retained during key rotation.

Do not put secrets in policy bundles, command history, or repository files. Supply `DATABASE_URL` through the deployment secret manager.

The enforcement private key must also come from the deployment secret manager. Publish the previous public JWK alongside the new key before switching signers, retain it for at least the token TTL plus the five-minute JWKS cache window, then retire it. Consumers fetch `/.well-known/jwks.json` without bearer authentication and must retry a single JWKS refresh after an unknown `kid`.

Only trusted policy-enforcement points may receive both `decision:write` and `decision:context:assert`. The latter authorizes the caller to assert agent, resource classification, model, attributes, and estimated cost on behalf of the workload. Do not grant it directly to untrusted agents or end users.

## Migration

Back up the database, then run the migration command once per deployment:

```bash
pg_dump --format=custom --file=veil-before-v1.dump "$DATABASE_URL"
DATABASE_URL="$DATABASE_URL" pnpm run migrate
```

For a published-package deployment, install `@tuzuminami/veil` and run `DATABASE_URL="$DATABASE_URL" pnpm exec veil-migrate`. `002_v1.sql` adds active policy bindings, idempotency fingerprints, receipt persistence, and tenant/time indexes. The runner checks out a dedicated PostgreSQL client, uses a transaction-scoped advisory lock for each migration, records each applied filename and SHA-256 checksum in `veil_schema_migrations`, and owns one transaction per forward migration. Before baselining a pre-existing v0.2 schema as `001_init.sql`, it validates the required tables, columns, primary keys, and `appeals` foreign key from PostgreSQL catalogs. Re-running it is safe; it stops before executing a forward migration if an applied filename is unknown or its checksum changed. Do not edit an applied migration: restore it and add a new numbered migration instead.

Decisions created before v1 remain readable with `legacy: true` and no `receipt`; v1 cannot reconstruct a trustworthy receipt from an older row. Existing v0.2 idempotency rows have no request fingerprint and therefore fail closed with `IDEMPOTENCY_CONFLICT` if reused after upgrade.

## Startup and Readiness

```bash
NODE_ENV=production node src/server.js
curl --fail http://127.0.0.1:8080/health
curl --fail http://127.0.0.1:8080/ready
```

Expose the application only through HTTPS. `/health` reports process liveness. `/ready` returns 503 when PostgreSQL cannot answer a health query. Remove the instance from traffic while readiness fails.

## Backup and Restore

Take regular encrypted PostgreSQL backups and test restoration:

```bash
createdb veil_restore_test
pg_restore --exit-on-error --dbname=veil_restore_test veil-before-v1.dump
DATABASE_URL='postgresql:///veil_restore_test' pnpm run migrate
```

Verify tenant-scoped policy, decision, receipt, audit, and active-binding rows before declaring restore success.

## Rollback

Prefer application rollback while retaining the v1 schema. To return the schema to v0.2, stop all v1 writers, back up the database, and run:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/002_v1.down.sql
```

The down migration removes active bindings, receipt JSON, and idempotency fingerprints. It also removes the v1 ledger entry so a later `pnpm run migrate` can reapply v1. This is destructive to v1-only evidence; restore the backup if the rollback itself fails.

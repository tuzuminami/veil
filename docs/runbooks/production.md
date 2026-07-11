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

Do not put secrets in policy bundles, command history, or repository files. Supply `DATABASE_URL` through the deployment secret manager.

Only trusted policy-enforcement points may receive both `decision:write` and `decision:context:assert`. The latter authorizes the caller to assert agent, resource classification, model, attributes, and estimated cost on behalf of the workload. Do not grant it directly to untrusted agents or end users.

## Migration

Back up the database, then apply migrations in order:

```bash
pg_dump --format=custom --file=veil-before-v1.dump "$DATABASE_URL"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_init.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/002_v1.sql
```

`002_v1.sql` adds active policy bindings, idempotency fingerprints, receipt persistence, and tenant/time indexes.
Both v1 migration files run their DDL inside an explicit PostgreSQL transaction. With `ON_ERROR_STOP=1`, a failed upgrade or rollback is rolled back as one unit; do not split the migration statements across separate `psql` invocations.

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
psql veil_restore_test -v ON_ERROR_STOP=1 -f migrations/002_v1.sql
```

Verify tenant-scoped policy, decision, receipt, audit, and active-binding rows before declaring restore success.

## Rollback

Prefer application rollback while retaining the v1 schema. To return the schema to v0.2, stop all v1 writers, back up the database, and run:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/002_v1.down.sql
```

The down migration removes active bindings, receipt JSON, and idempotency fingerprints. This is destructive to v1-only evidence; restore the backup if the rollback itself fails.

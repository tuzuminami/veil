# Local Development Runbook

## Verify

```bash
pnpm run verify
```

## Run The API

```bash
node src/server.js
```

The server writes local development state to `.local-data/veil-store.json` by default. This path is ignored and must not be committed.

The default file-backed server and development bearer token are local-only. File-store writes are coordinated across instances in one Node.js process, but the file adapter is not a multi-process or distributed store. With `NODE_ENV=production`, the same entrypoint requires the PostgreSQL and OIDC configuration documented in [production.md](./production.md) and fails closed when any required setting is missing.

## Start PostgreSQL

```bash
export VEIL_POSTGRES_PASSWORD='local-only-password'
docker compose up
```

Run `DATABASE_URL="$DATABASE_URL" pnpm run migrate` from a repository checkout. For a release deployment, first install the verified [v1.0.1 GitHub Release artifact](https://github.com/tuzuminami/veil/releases/download/v1.0.1/tuzuminami-veil-1.0.1.tgz), then run `DATABASE_URL="$DATABASE_URL" pnpm exec veil-migrate`. VEIL is not published to the npm registry. The runner serializes each migration with a transaction-scoped PostgreSQL advisory lock, records SHA-256 checksums in `veil_schema_migrations`, and rejects changed or unknown applied migrations. The default local server remains file-backed; the production runtime uses PostgreSQL when its required environment is configured.

## Common Failure Checks

- Missing `Authorization` or `X-Tenant-Id` returns an authentication error.
- Tenant mismatch between token and header returns a tenant-scope error.
- Missing `Idempotency-Key` on side-effecting endpoints returns validation failure.
- Adapter timeout or unknown results return `ESCALATE` or `BLOCK`, never `ALLOW`.

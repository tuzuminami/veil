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

## Start PostgreSQL

```bash
docker compose up
```

The first migration is in `migrations/001_init.sql`. The runnable MVP uses the file-backed adapter; PostgreSQL is provided for production adapter work and migration review.

## Common Failure Checks

- Missing `Authorization` or `X-Tenant-Id` returns an authentication error.
- Tenant mismatch between token and header returns a tenant-scope error.
- Missing `Idempotency-Key` on side-effecting endpoints returns validation failure.
- Adapter timeout or unknown results return `ESCALATE` or `BLOCK`, never `ALLOW`.

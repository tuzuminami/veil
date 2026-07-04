# Contributing

Thanks for helping improve VEIL.

## Development

```bash
pnpm run verify
```

Before opening a change:

- keep test data synthetic;
- do not commit secrets, private prompts, raw conversation exports, or local evidence;
- update OpenAPI and JSON Schemas when public API behavior changes;
- add tests for success, authorization failure, tenant isolation, idempotency, and fail-closed behavior when relevant.

## Architecture Rules

- Keep domain logic independent of HTTP, database, provider SDKs, and environment variables.
- Validate external input at the boundary.
- Prefer immutable published versions and deterministic hashes.
- Treat adapter timeouts and unknown results as safe failures.
- Keep public documentation operational and concise.

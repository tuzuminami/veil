# Release Runbook

## Required Evidence

```bash
pnpm install --frozen-lockfile
pnpm run audit
pnpm run verify
pnpm pack --dry-run
gh api repos/tuzuminami/veil/license --jq '.license.spdx_id'
```

The license result must be `Apache-2.0`. The CI workflow must pass on the exact release commit and produce a CycloneDX SBOM artifact.

## Release Review

1. Confirm `package.json`, OpenAPI, and CHANGELOG use the same stable version.
2. Confirm migrations have upgrade, backup, restore, and rollback guidance.
3. Confirm the package tarball contains only the intended public files.
4. Confirm OIDC negative tests, tenant isolation, idempotency conflict, atomic persistence, AuthZEN contract, receipt integrity, and fail-closed tests pass.
5. Run independent correctness and security reviews.
6. Create issues for confirmed findings, fix them through the release branch, and close them with evidence.
7. Open a release PR, wait for required CI, and merge without bypassing checks.
8. Create annotated tag `v<version>` on the merged commit and publish the GitHub Release with verification notes and SBOM.

Only the Commander performs GitHub write operations.

## Rollback

Do not rewrite a public tag. If the release artifact is incorrect, mark it clearly and publish a corrected patch release. For runtime rollback, keep the v1 schema when possible. Follow [production.md](./production.md) before using the destructive schema down migration.

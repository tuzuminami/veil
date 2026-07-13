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
8. Create the package from the merged commit and attach that exact tarball plus the CI-generated SBOM to the GitHub Release. The release tag must equal `v<package.json version>`:

```bash
version="$(node -p "require('./package.json').version")"
mkdir -p .release
pnpm pack --pack-destination .release
gh run download <merged-commit-ci-run-id> --name veil-sbom.cdx.json --dir .release
gh release create "v$version" \
  ".release/tuzuminami-veil-$version.tgz" \
  .release/veil-sbom.cdx.json \
  --target "$(git rev-parse HEAD)" \
  --title "VEIL v$version"
```

The `Release Artifact Verification` workflow runs after publication. It checks
that the tagged source package and uploaded tarball have identical files and
SHA-256 content digests, then installs that downloaded tarball and executes the
migration CLI guard. A failure means publish a corrected patch release; never
replace a released tag or asset.

Only the Commander performs GitHub write operations.

## Rollback

Do not rewrite a public tag. If the release artifact is incorrect, mark it clearly and publish a corrected patch release. For runtime rollback, keep the v1 schema when possible. Follow [production.md](./production.md) before using the destructive schema down migration.

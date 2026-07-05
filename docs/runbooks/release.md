# Release Runbook

## Scope

Use this checklist for public VEIL releases. Releases must preserve the fail-closed posture, tenant isolation guarantees, audit metadata, and Apache-2.0 licensing posture.

## Required Checks

```bash
pnpm run verify
pnpm pack --dry-run
gh api repos/tuzuminami/veil/license --jq '.license.spdx_id'
```

The license command must return:

```text
Apache-2.0
```

## Release Steps

1. Confirm `package.json`, `openapi/openapi.yaml`, and `CHANGELOG.md` all reference the target version.
2. Confirm the root `LICENSE` file contains Apache License 2.0 text and `package.json` uses `license: "Apache-2.0"`.
3. Confirm OpenAPI response envelopes model success and stable error responses.
4. Run the required checks.
5. Commit with issue-closing references.
6. Create an annotated tag such as `v0.2.0`.
7. Push `main` and tags.
8. Create the GitHub Release with verification notes and the Apache-2.0 license statement.

## Rollback

If a release artifact is incorrect, publish a follow-up patch release. Do not rewrite public tags after consumers may have fetched them.

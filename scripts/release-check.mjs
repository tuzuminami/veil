import { existsSync, readFileSync, statSync } from "node:fs";
import { parseDocument } from "yaml";

const packageJson = json("package.json");
const openapiSource = text("openapi/openapi.yaml");
const openapiDocument = parseDocument(openapiSource, { uniqueKeys: true, strict: true });
check(openapiDocument.errors.length === 0, `OpenAPI YAML is invalid: ${openapiDocument.errors[0]?.message ?? "unknown error"}`);
const openapi = openapiDocument.toJS();
const changelog = text("CHANGELOG.md");
const readme = text("README.md");
const license = text("LICENSE");
const workflow = text(".github/workflows/ci.yml");
const releaseArtifactWorkflow = text(".github/workflows/release-artifact.yml");
const releaseRunbook = text("docs/runbooks/release.md");
const version = packageJson.version;
const releaseArtifactUrl = `https://github.com/tuzuminami/veil/releases/download/v${version}/${packageJson.name.slice(1).replace("/", "-")}-${version}.tgz`;
const forwardMigrations = ["migrations/001_init.sql", "migrations/002_v1.sql", "migrations/003_request_identity.sql"];

check(/^\d+\.\d+\.\d+$/.test(version), `package version must be stable semver, got ${version}`);
check(packageJson.license === "Apache-2.0", "package license must be Apache-2.0");
check(packageJson.files.includes("LICENSE"), "package files must include LICENSE");
check(packageJson.files.includes("schemas") && packageJson.files.includes("migrations"), "package must include contracts and migrations");
check(!packageJson.files.includes("LICENSE.md"), "package files must not include LICENSE.md");
check(statSync("LICENSE").isFile(), "root LICENSE file is required");
check(license.includes("Apache License") && license.includes("Version 2.0"), "LICENSE must contain Apache License 2.0 text");
check(existsSync("pnpm-lock.yaml"), "pnpm-lock.yaml is required for reproducible CI");
check(Object.values(packageJson.dependencies ?? {}).every(isExactVersion), "production dependencies must use exact versions");

check(openapi.info?.version === version, `OpenAPI version must equal package version ${version}`);
check(openapi.info?.license?.name === "Apache-2.0", "OpenAPI license name must be Apache-2.0");
check(openapi.paths?.["/access/v1/evaluation"]?.post, "OpenAPI must define the AuthZEN single evaluation endpoint");
check(openapi.components?.schemas?.DecisionReceipt, "OpenAPI must define DecisionReceipt");
check(openapi.components?.schemas?.ErrorEnvelope, "OpenAPI must define a stable ErrorEnvelope");
check(changelog.includes(`## ${version} - `), `CHANGELOG must contain release ${version}`);
check(readme.includes("AuthZEN Authorization API 1.0"), "README must describe the bounded AuthZEN compatibility claim");
check(readme.includes("[LICENSE](./LICENSE)"), "README must point to the standard root LICENSE file");

for (const path of [
  "migrations/001_init.sql",
  "migrations/002_v1.sql",
  "migrations/002_v1.down.sql",
  "migrations/003_request_identity.sql",
  "migrations/003_request_identity.down.sql",
  "docs/runbooks/production.md",
  "docs/adr/ADR-003-request-identities.md",
  "schemas/decision-request.schema.json",
  "schemas/decision-receipt.schema.json"
]) {
  check(existsSync(path), `${path} is required for release`);
}

check(existsSync("src/migrations/postgres-runner.js"), "checksummed PostgreSQL migration runner is required for release");
check(packageJson.scripts.migrate === "node bin/veil-migrate.mjs", "package must provide the PostgreSQL migration command");
check(packageJson.bin?.["veil-migrate"] === "./bin/veil-migrate.mjs", "package must expose the PostgreSQL migration CLI");
for (const path of forwardMigrations) {
  check(!/^\s*(BEGIN|COMMIT);\s*$/mi.test(text(path)), `${path} must leave transaction ownership to the migration runner`);
}

check(!/^\s*uses:\s*[^#\n]+@(v\d+|main|master)\s*(?:#.*)?$/m.test(workflow), "GitHub Actions must be pinned to immutable commit SHAs");
check(workflow.includes("pnpm install --frozen-lockfile"), "CI must use the frozen lockfile");
check(workflow.includes("pnpm run audit"), "CI must audit production dependencies");
check(workflow.includes("Checkout RELAY compatibility consumer"), "CI must check out the RELAY enforcement consumer");
check(workflow.includes("89b417a653ff468a7ce5ae0d3965370a998ed3a0"), "CI must pin the RELAY VEIL audience contract by commit SHA");
check(workflow.includes("pnpm run check:relay-enforcement"), "CI must run the VEIL to RELAY enforcement compatibility check");
check(packageJson.scripts["check:release-artifact"] === "node scripts/check-release-artifact.mjs", "package must provide the public release artifact check");
check(packageJson.scripts["check:published-release-artifact"] === "node scripts/check-release-artifact.mjs --published", "package must provide the published release artifact check");
check(workflow.includes("pnpm run check:release-artifact"), "CI must verify the release artifact declaration");
check(releaseArtifactWorkflow.includes("types: [published]"), "release artifact workflow must run when a release is published");
check(releaseArtifactWorkflow.includes("pnpm run check:published-release-artifact"), "release artifact workflow must download and install the published package");
check(releaseArtifactWorkflow.includes("VEIL_RELEASE_TAG") && releaseArtifactWorkflow.includes("VEIL_RELEASE_ASSETS_JSON"), "release artifact workflow must bind the event tag and assets");
check(releaseRunbook.includes("pnpm pack --pack-destination .release"), "release runbook must generate the upload tarball from the release commit");
check(releaseRunbook.includes("gh release create") && releaseRunbook.includes(".release/tuzuminami-veil-$version.tgz"), "release runbook must attach the generated package tarball");
check(readme.includes(releaseArtifactUrl), `README must document the verified release artifact ${releaseArtifactUrl}`);
check(!readme.includes("install `@tuzuminami/veil`"), "README must not claim that VEIL is published to the npm registry");
check(workflow.includes("anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610"), "CI must use the pinned SBOM action");
check(workflow.includes("format: cyclonedx-json") && workflow.includes("syft-version: v1.46.0"), "CI must generate a pinned CycloneDX SBOM");

console.log(`Release check passed for ${packageJson.name}@${version}.`);

function text(path) {
  return readFileSync(path, "utf8");
}

function json(path) {
  return JSON.parse(text(path));
}

function isExactVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function check(condition, message) {
  if (!condition) {
    console.error(`RELEASE CHECK FAIL: ${message}`);
    process.exit(1);
  }
}

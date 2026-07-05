import { readFileSync, statSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const openapi = readFileSync("openapi/openapi.yaml", "utf8");
const changelog = readFileSync("CHANGELOG.md", "utf8");
const readme = readFileSync("README.md", "utf8");
const license = readFileSync("LICENSE", "utf8");

const version = packageJson.version;

check(version === "0.2.0", `package version must be 0.2.0, got ${version}`);
check(packageJson.license === "Apache-2.0", "package license must be Apache-2.0");
check(packageJson.files.includes("LICENSE"), "package files must include LICENSE");
check(!packageJson.files.includes("LICENSE.md"), "package files must not include LICENSE.md");
check(statSync("LICENSE").isFile(), "root LICENSE file is required");
check(license.includes("Apache License") && license.includes("Version 2.0"), "LICENSE must contain Apache License 2.0 text");
check(openapi.includes("version: 0.2.0"), "OpenAPI version must be 0.2.0");
check(openapi.includes("name: Apache-2.0"), "OpenAPI license name must be Apache-2.0");
check(openapi.includes("ErrorEnvelope"), "OpenAPI must define a stable ErrorEnvelope schema");
check(openapi.includes("PolicyVersionEnvelope"), "OpenAPI must define policy version response envelopes");
check(changelog.includes("## 0.2.0 - 2026-07-05"), "CHANGELOG must contain the 0.2.0 release entry");
check(readme.includes("[LICENSE](./LICENSE)"), "README must point to the standard root LICENSE file");

console.log(`Release check passed for ${packageJson.name}@${version}.`);

function check(condition, message) {
  if (!condition) {
    console.error(`RELEASE CHECK FAIL: ${message}`);
    process.exit(1);
  }
}

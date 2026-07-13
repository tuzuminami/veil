import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = packageJson.version;
const filename = `${packageJson.name.slice(1).replace("/", "-")}-${version}.tgz`;
const url = `https://github.com/tuzuminami/veil/releases/download/v${version}/${filename}`;
const verifyPublished = process.argv.includes("--published");
const documentation = ["README.md", "docs/runbooks/local-development.md", "docs/runbooks/production.md"]
  .map((path) => readFileSync(join(root, path), "utf8"));
const temp = mkdtempSync(join(tmpdir(), "veil-release-artifact-"));
const tarball = join(temp, filename);

try {
  for (const source of documentation) {
    check(source.includes(url), `documentation must use the verified release URL: ${url}`);
    check(!source.includes("install `@tuzuminami/veil`"), "documentation must not claim npm registry availability");
  }

  if (!verifyPublished) {
    console.log(`Release artifact declaration check passed for ${packageJson.name}@${version}.`);
  } else {
  const response = await fetch(url, { redirect: "follow" });
  check(response.ok, `release artifact download failed with HTTP ${response.status}`);
  writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));

  const packed = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
  check(packed.name === packageJson.name, `release package name must be ${packageJson.name}`);
  check(packed.version === version, `release package version must be ${version}`);
  check(packed.license === "Apache-2.0", "release package license must be Apache-2.0");
  const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  check(entries.includes("package/bin/veil-migrate.mjs\n"), "release package must contain veil-migrate");

  writeFileSync(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("pnpm", ["add", "--ignore-scripts", url], { cwd: temp, encoding: "utf8", stdio: "pipe" });
  const migrationCli = spawnSync("pnpm", ["exec", "veil-migrate"], {
    cwd: temp,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "" }
  });
  const cliOutput = `${migrationCli.stdout}\n${migrationCli.stderr}`;
  check(migrationCli.status !== 0 && cliOutput.includes("DATABASE_URL is required"), "installed migration CLI must execute its DATABASE_URL guard");

  console.log(`Published release artifact check passed for ${packageJson.name}@${version}.`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function check(condition, message) {
  if (!condition) {
    console.error(`RELEASE ARTIFACT CHECK FAIL: ${message}`);
    process.exit(1);
  }
}

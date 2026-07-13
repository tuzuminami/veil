import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = packageJson.version;
const filename = `${packageJson.name.slice(1).replace("/", "-")}-${version}.tgz`;
const url = `https://github.com/tuzuminami/veil/releases/download/v${version}/${filename}`;
const verifyPublished = process.argv.includes("--published");
const documentation = ["README.md", "docs/runbooks/local-development.md", "docs/runbooks/production.md"]
  .map((path) => readFileSync(join(root, path), "utf8"));
const temp = mkdtempSync(join(tmpdir(), "veil-release-artifact-"));

try {
  for (const source of documentation) {
    check(source.includes(url), `documentation must use the verified release URL: ${url}`);
    check(!source.includes("install `@tuzuminami/veil`"), "documentation must not claim npm registry availability");
  }

  if (!verifyPublished) {
    console.log(`Release artifact declaration check passed for ${packageJson.name}@${version}.`);
  } else {
    const releaseTag = process.env.VEIL_RELEASE_TAG;
    check(releaseTag === `v${version}`, `published release tag must be v${version}, got ${releaseTag ?? "missing"}`);
    const assets = JSON.parse(process.env.VEIL_RELEASE_ASSETS_JSON ?? "[]");
    const asset = assets.find((candidate) => candidate?.name === filename);
    check(asset?.browser_download_url === url, `published release must attach ${filename} at its canonical URL`);

    const response = await fetch(asset.browser_download_url, { redirect: "follow" });
    check(response.ok, `release artifact download failed with HTTP ${response.status}`);
    const releasedTarball = join(temp, `released-${filename}`);
    writeFileSync(releasedTarball, Buffer.from(await response.arrayBuffer()));

    const expectedTarball = packSourceArtifact();
    const expectedPackage = extractPackage(expectedTarball, join(temp, "expected"));
    const releasedPackage = extractPackage(releasedTarball, join(temp, "released"));
    comparePackageContents(expectedPackage, releasedPackage);

    const packed = JSON.parse(readFileSync(join(releasedPackage, "package.json"), "utf8"));
    check(packed.name === packageJson.name, `release package name must be ${packageJson.name}`);
    check(packed.version === version, `release package version must be ${version}`);
    check(packed.license === "Apache-2.0", "release package license must be Apache-2.0");
    check(statSync(join(releasedPackage, "bin", "veil-migrate.mjs")).isFile(), "release package must contain veil-migrate");

    const consumer = join(temp, "consumer");
    mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
    execFileSync("pnpm", ["add", "--ignore-scripts", releasedTarball], { cwd: consumer, encoding: "utf8", stdio: "pipe" });
    const migrationCli = spawnSync("pnpm", ["exec", "veil-migrate"], {
      cwd: consumer,
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

function packSourceArtifact() {
  const output = execFileSync("pnpm", ["pack", "--pack-destination", temp], { cwd: root, encoding: "utf8" });
  const packedName = output.trim().split("\n").at(-1);
  check(packedName, "pnpm pack did not return a package path");
  return packedName.startsWith("/") ? packedName : join(temp, basename(packedName));
}

function extractPackage(tarball, destination) {
  const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
  check(entries.length > 0 && entries.every((entry) => entry.startsWith("package/") && !entry.includes("../")), "release tarball contains an unsafe package path");
  mkdirSync(destination);
  execFileSync("tar", ["-xzf", tarball, "-C", destination], { encoding: "utf8", stdio: "pipe" });
  return join(destination, "package");
}

function comparePackageContents(expected, released) {
  const expectedFiles = packageFiles(expected);
  const releasedFiles = packageFiles(released);
  check(expectedFiles.size === releasedFiles.size, "published release package file count differs from the release tag package");

  for (const [path, digest] of expectedFiles) {
    check(releasedFiles.get(path) === digest, `published release package differs from the release tag at ${path}`);
  }
}

function packageFiles(directory) {
  const files = new Map();
  visit(directory);
  return files;

  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.set(relative(directory, path), createHash("sha256").update(readFileSync(path)).digest("hex"));
      } else {
        check(false, `package contains unsupported filesystem entry: ${relative(directory, path)}`);
      }
    }
  }
}

function check(condition, message) {
  if (!condition) {
    console.error(`RELEASE ARTIFACT CHECK FAIL: ${message}`);
    process.exit(1);
  }
}

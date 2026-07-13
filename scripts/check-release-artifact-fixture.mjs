import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = packageJson.version;
const filename = `${packageJson.name.slice(1).replace("/", "-")}-${version}.tgz`;
const url = `https://github.com/tuzuminami/veil/releases/download/v${version}/${filename}`;
const temp = mkdtempSync(join(tmpdir(), "veil-release-artifact-fixture-"));

try {
  const output = execFileSync("pnpm", ["pack", "--pack-destination", temp], { cwd: root, encoding: "utf8" });
  const packedName = output.trim().split("\n").at(-1);
  if (!packedName) throw new Error("pnpm pack did not return a package path");
  const tarball = packedName.startsWith("/") ? packedName : join(temp, basename(packedName));
  const result = spawnSync(process.execPath, ["scripts/check-release-artifact.mjs", "--published"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      VEIL_RELEASE_TAG: `v${version}`,
      VEIL_RELEASE_ASSETS_JSON: JSON.stringify([{ name: filename, browser_download_url: url }]),
      VEIL_RELEASE_ASSET_PATH: tarball
    }
  });
  if (result.status !== 0) throw new Error(`release artifact fixture failed:\n${result.stdout}\n${result.stderr}`);
  console.log(`Release artifact fixture passed for ${packageJson.name}@${version}.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

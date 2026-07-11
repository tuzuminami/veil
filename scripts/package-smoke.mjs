import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const temp = mkdtempSync(join(tmpdir(), "veil-package-smoke-"));

try {
  const output = execFileSync("pnpm", ["pack", "--pack-destination", temp], { cwd: root, encoding: "utf8" });
  const tarballName = output.trim().split("\n").at(-1);
  if (!tarballName) throw new Error("pnpm pack did not return a package path");
  const tarball = tarballName.startsWith("/") ? tarballName : join(temp, basename(tarballName));

  execFileSync("pnpm", ["add", "--ignore-scripts", tarball], { cwd: temp, encoding: "utf8", stdio: "pipe" });
  execFileSync(process.execPath, ["--input-type=module", "--eval", packageProbe(packageJson.name)], {
    cwd: temp,
    encoding: "utf8",
    stdio: "pipe"
  });
  console.log(`Package install smoke passed for ${packageJson.name}@${packageJson.version}.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function packageProbe(name) {
  return `
    const root = await import(${JSON.stringify(name)});
    const sdk = await import(${JSON.stringify(`${name}/sdk`)});
    const auth = await import(${JSON.stringify(`${name}/auth`)});
    const postgres = await import(${JSON.stringify(`${name}/postgres`)});
    if (typeof root.VeilService !== "function") throw new Error("missing VeilService export");
    if (typeof sdk.VeilClient !== "function") throw new Error("missing VeilClient export");
    if (typeof auth.createOidcAuthenticator !== "function") throw new Error("missing OIDC export");
    if (typeof postgres.PostgresVeilStore !== "function") throw new Error("missing Postgres export");
  `;
}

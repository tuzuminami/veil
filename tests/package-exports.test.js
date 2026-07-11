import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";

test("package exports expose public entry points", async () => {
  const root = await import("@tuzuminami/veil");
  const sdk = await import("@tuzuminami/veil/sdk");

  assert.equal(typeof root.VeilService, "function");
  assert.equal(typeof root.FileVeilStore, "function");
  assert.equal(typeof root.buildServer, "function");
  assert.equal(typeof sdk.VeilClient, "function");
});

test("package dry-run excludes private material", () => {
  const output = execFileSync("pnpm", ["pack", "--dry-run"], { encoding: "utf8" });
  const denied = [
    ["PRIVATE", " CONTROL", " DOCUMENT"].join(""),
    ["Private", " Control", " Plane"].join(""),
    ["private", " requirements"].join(""),
    ["CODEX", "_AI", "_COMPANION"].join(""),
    ["CODEX", "_IMPLEMENTATION", "_HARNESS"].join(""),
    ["README", "_PRIVATE"].join(""),
    ["AGENTS", "_PRIVATE"].join(""),
    ["01", "_BMA"].join(""),
    ["02", "_StRS"].join(""),
    ["03", "_SyRS"].join(""),
    ["04", "_AD"].join(""),
    ["05", "_DD"].join(""),
    ["06", "_API", "_CONTRACT"].join(""),
    ["07", "_VV", "_PLAN"].join(""),
    ["08", "_TRACEABILITY"].join(""),
    ["09", "_MVP", "_BACKLOG"].join(""),
    ["10", "_RELEASE", "_CRITERIA"].join("")
  ];

  assert.match(output, /LICENSE/);
  for (const marker of denied) {
    assert.doesNotMatch(output, new RegExp(marker));
  }
});

test("bundled server fails closed in production without required configuration", () => {
  const result = spawnSync(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production", PORT: "0" }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL is required in production/);
  assert.doesNotMatch(result.stdout, /VEIL listening/);
});

test("public server builder fails closed in production without production auth", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const root = await import("@tuzuminami/veil");
    assert.throws(() => root.buildServer(), /production auth adapter/);
  } finally {
    if (previous === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previous;
    }
  }
});

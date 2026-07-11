import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const deniedPathPatterns = [
  /(^|\/)CODEX(_AI_COMPANION_OSS)?_IMPLEMENTATION_HARNESS\.md$/,
  /(^|\/)AGENTS\.private\.md$/,
  /(^|\/)(00_GLOSSARY|01_BMA|02_StRS|03_SyRS|04_AD|05_DD|06_API_CONTRACT|07_VV_PLAN|08_TRACEABILITY|09_MVP_BACKLOG|10_RELEASE_CRITERIA)\.md$/,
  /(^|\/)(private-ai-control-plane|\.private|\.codex-private|evidence-private|private-fixtures)(\/|$)/,
  /(^|\/)docs\/(ai|private)(\/|$)/,
  /(^|\/)\.env($|\.)/
];

const deniedMarkers = ["PRIVATE_SPECIFICATION_DO_NOT_COMMIT", "PRIVATE_OPERATOR_MATERIAL", "DO_NOT_COMMIT_OR_PUBLISH"];
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{32,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/
];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function lines(value) {
  return value.length === 0 ? [] : value.split("\n").filter(Boolean);
}

function fail(message) {
  console.error(`PRIVATE BOUNDARY FAIL: ${message}`);
  process.exit(1);
}

let files;
try {
  files = new Set([
    ...lines(git(["ls-files"])),
    ...lines(git(["diff", "--cached", "--name-only"])),
    ...lines(git(["ls-files", "--others", "--exclude-standard"]))
  ]);
} catch (error) {
  fail(`unable to inspect git file set: ${error instanceof Error ? error.message : String(error)}`);
}

for (const file of files) {
  if (file === ".env.example") continue;
  if (deniedPathPatterns.some((pattern) => pattern.test(file))) fail(`prohibited path tracked or staged: ${file}`);
  if (file === "scripts/check-private-boundary.mjs") continue;
  let stat;
  try {
    stat = statSync(file);
  } catch {
    continue;
  }
  if (!stat.isFile()) continue;
  const content = readFileSync(file, "utf8");
  for (const marker of deniedMarkers) {
    if (content.includes(marker)) fail(`private marker found in ${file}`);
  }
  for (const pattern of secretPatterns) {
    if (pattern.test(content)) fail(`high-confidence secret pattern found in ${file}`);
  }
}

console.log("Private boundary check passed.");

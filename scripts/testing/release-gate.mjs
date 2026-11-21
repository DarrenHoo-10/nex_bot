#!/usr/bin/env node
// The test gate for shipping a release (AGENTS.md, "Shipping a change"): the tests
// related to what changed since the last release, not the whole suite.
//
//   pnpm test:release                 # since the newest nexbot-v* tag before HEAD
//   pnpm test:release -- --base <ref> # since any commit or tag
//
// Vitest picks the test files whose import graph reaches a changed file (and every
// file when its config, setup or package.json changed). The CI selection and
// verification-record checks always run too: they are cheap, and CI's first job
// fails on them before any test shard starts. The full suite runs in CI on every
// push to main (docs/ci.md); a release does not wait for it.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const at = args.indexOf("--base");
const git = (...command) => spawnSync("git", command, { encoding: "utf8" });

let base = at >= 0 ? args[at + 1] : undefined;
if (at >= 0 && !base) fail("--base needs a commit or tag");
if (!base) {
  const tag = git("describe", "--tags", "--abbrev=0", "--match", "nexbot-v*", "HEAD");
  base = tag.status === 0 ? tag.stdout.trim() : undefined;
  if (!base) fail("no nexbot-v* release tag before HEAD: fetch tags (git fetch origin --tags) or pass --base <ref>");
}
if (git("rev-parse", "--verify", "--quiet", `${base}^{commit}`).status !== 0) {
  // Vitest treats an unknown ref as "uncommitted changes only" and would quietly test almost nothing.
  fail(`${base} is not a commit here: fetch it (git fetch origin --tags) or pass another --base`);
}

const changed = git("diff", "--name-only", base, "--").stdout.trim().split("\n").filter(Boolean);
console.log(`release gate: ${changed.length} files changed since ${base}`);

const vitest = (extra) => {
  const run = spawnSync("pnpm", ["exec", "vitest", "run", ...extra], { stdio: "inherit", shell: process.platform === "win32" });
  return run.status ?? 1;
};
const steps = [
  ["CI selection and verification records", ["scripts/ci-scope.test.ts", "scripts/ci-workflow.test.ts", "scripts/testing/verification-docs.test.ts"]],
  [`tests related to changes since ${base}`, ["--changed", base, "--passWithNoTests"]],
];
for (const [label, extra] of steps) {
  console.log(`\nrelease gate: ${label}`);
  const status = vitest(extra);
  if (status !== 0) fail(`${label} failed`);
}
console.log("\nrelease gate: passed");

function fail(message) {
  console.error(`release gate: ${message}`);
  process.exit(1);
}

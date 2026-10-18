// Stages the macOS app's bundled device executor into apps/apple/build/Executor:
//   node                    official Node binary (SHA256 verified), nothing else from the distribution
//   executor-host.mjs       apps/apple/Executor host (stdin/stdout protocol)
//   nex-client-device.mjs   copy of electron/nex-client-device.mjs (the shared lifecycle, not forked)
//   client-executor/        output of scripts/build-client-executor.mjs
// Xcode's "Bundle device executor" phase copies and signs it. Usage: node scripts/build-mac-executor.mjs [--reuse-executor]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apple = path.join(root, "apps/apple");
const buildDir = path.join(apple, "build");
const cache = path.join(buildDir, "cache");
const stage = path.join(buildDir, "Executor");
const reuse = process.argv.includes("--reuse-executor");
if (process.platform !== "darwin") { console.error("The macOS executor can only be staged on macOS."); process.exit(2); }
const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
if (!arch) { console.error("Unsupported CPU: " + process.arch); process.exit(2); }

const version = process.version; // pin the Node that builds the bundle (client-node uses node:sqlite)
const executorOut = path.join(root, "dist-personal/client-executor");
if (!reuse || !existsSync(path.join(executorOut, "client-node/client-node.js"))) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/build-client-executor.mjs")], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const archive = `node-${version}-darwin-${arch}.tar.gz`;
const base = `https://nodejs.org/dist/${version}`;
const cached = path.join(cache, `node-${version}-darwin-${arch}`);
mkdirSync(cache, { recursive: true });
if (!existsSync(path.join(cached, "node"))) {
  const get = async (url) => { const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
  const sums = (await get(`${base}/SHASUMS256.txt`)).toString("utf8");
  const expected = sums.split("\n").map((l) => l.trim().split(/\s+/)).find(([, name]) => name === archive)?.[0];
  if (!expected) throw new Error(`${archive} is not listed in SHASUMS256.txt`);
  const data = await get(`${base}/${archive}`);
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected) throw new Error(`SHA256 mismatch for ${archive}: expected ${expected}, got ${actual}`);
  // Untrusted download: extract into its own empty directory and only copy the binary out.
  const work = mkdtempSync(path.join(cache, "extract-"));
  const tarball = path.join(work, archive), out = path.join(work, "out");
  mkdirSync(out); writeFileSync(tarball, data);
  const tar = spawnSync("tar", ["-xzf", tarball, "-C", out, `node-${version}-darwin-${arch}/bin/node`], { stdio: "inherit" });
  if (tar.status !== 0) throw new Error("tar failed");
  mkdirSync(cached, { recursive: true });
  copyFileSync(path.join(out, `node-${version}-darwin-${arch}/bin/node`), path.join(cached, "node.partial"));
  chmodSync(path.join(cached, "node.partial"), 0o755);
  renameSync(path.join(cached, "node.partial"), path.join(cached, "node"));
  rmSync(work, { recursive: true, force: true });
  console.log(`Downloaded and verified ${archive} (sha256 ${actual})`);
}

const next = stage + ".new";
rmSync(next, { recursive: true, force: true });
mkdirSync(next, { recursive: true });
copyFileSync(path.join(cached, "node"), path.join(next, "node")); chmodSync(path.join(next, "node"), 0o755);
copyFileSync(path.join(apple, "Executor/executor-host.mjs"), path.join(next, "executor-host.mjs"));
copyFileSync(path.join(root, "electron/nex-client-device.mjs"), path.join(next, "nex-client-device.mjs"));
cpSync(executorOut, path.join(next, "client-executor"), { recursive: true });
// pdf.js is only imported from legacy/build/pdf.mjs (with its worker); drop the browser bundles, viewer, types and source maps.
const pdf = path.join(next, "client-executor/node_modules/pdfjs-dist");
for (const sub of ["build", "web", "types", "image_decoders", "legacy/web", "legacy/image_decoders"]) rmSync(path.join(pdf, sub), { recursive: true, force: true });
for (const name of readdirSync(path.join(pdf, "legacy/build"))) if (/\.map$|\.min\.mjs$|sandbox|\.d\.mts$/.test(name)) rmSync(path.join(pdf, "legacy/build", name));
writeFileSync(path.join(next, "VERSION"), `node ${version}\n`);
rmSync(stage, { recursive: true, force: true });
renameSync(next, stage);
const size = spawnSync("du", ["-sh", stage], { encoding: "utf8" }).stdout.split("\t")[0];
console.log(`Staged ${stage} (${size}, Node ${version} darwin-${arch})`);

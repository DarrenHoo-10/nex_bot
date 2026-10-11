// Build-time compatibility for the pinned builder: its four-minute makensis
// bound is too short for direct expansion of the complete ML runtime. Keep
// the normal builder's templates, output validation and size checks intact.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const builder = require("electron-builder");
const libraryRequire = createRequire(require.resolve("app-builder-lib", { paths: [path.dirname(require.resolve("electron-builder"))] }));
if (libraryRequire("app-builder-lib/package.json").version !== "26.15.3") throw new Error("Requalify the NSIS build shim for this builder version");
const util = libraryRequire("builder-util/out/util");
const original = util.spawnAndWriteWithOutput;
util.spawnAndWriteWithOutput = (command, args, data, options) => {
  if (path.basename(command).toLowerCase() !== "makensis.exe") return original(command, args, data, options);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15 * 60_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdin.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("Personal NSIS compilation exceeded fifteen minutes"));
      else if (code !== 0) reject(new Error(`NSIS compilation failed (${code}): ${stdout}\n${stderr}`));
      else resolve({ stdout, stderr });
    });
    child.stdin.end(data);
  });
};
const config = parse(readFileSync(path.join(repo, "electron-builder.personal.yml"), "utf8"));
const requestedOutput = process.argv.find((arg) => arg.startsWith("--output="))?.slice(9);
if (requestedOutput) {
  const output = path.resolve(repo, requestedOutput);
  if (!output.startsWith(path.join(repo, "release") + path.sep)) throw new Error("Build output must stay inside release");
  config.directories.output = output;
}
process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ??= "1";
// Passing an object makes builder merge its legacy desktop default config.
// An explicit file keeps this personal distribution independent of that app.
const configFile = path.join(repo, "release", `personal-builder-${randomUUID()}.json`);
writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
try {
  await builder.build({ projectDir: repo, ...(process.argv.includes("--prepackaged") ? { prepackaged: path.join(repo, "release/personal-os/win-unpacked") } : {}), config: configFile,
    targets: builder.Platform.WINDOWS.createTarget(process.argv.includes("--portable") ? ["portable"] : ["nsis", "portable"], builder.Arch.x64), publish: "never" });
} finally { util.spawnAndWriteWithOutput = original; unlinkSync(configFile); }

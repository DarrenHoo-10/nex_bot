import { build } from "esbuild";
import { build as viteBuild } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, cpSync, realpathSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await import('./build-html-preview.mjs');
const output = path.join(root, "dist-personal");
const coreOnly = process.argv.includes("--core");
const shellOnly = process.argv.includes("--shell");
if (coreOnly && shellOnly) throw new Error("Choose either --core or --shell");
if (!coreOnly) {
const config = parse(readFileSync(path.join(root, "electron-builder.client.yml"), "utf8"));
const platform = process.platform, arch = process.arch;
if (!["win32", "darwin"].includes(platform)) throw new Error("Personal desktop packaging supports Windows and macOS");
const electronDir = path.join(root, config.electronDist);
const electronExe = path.join(electronDir, platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron.exe");
if (!existsSync(electronExe) || spawnSync(electronExe, ["-p", "process.versions.electron"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", windowsHide: true }).stdout?.trim() !== config.electronVersion) {
  const electronRequire = createRequire(realpathSync(path.join(root, "node_modules/electron/package.json")));
  const cache = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "electron", "Cache");
  const zipName = `electron-v${config.electronVersion}-${platform}-${arch}.zip`;
  let archive = existsSync(cache) ? readdirSync(cache).map((dir) => path.join(cache, dir, zipName)).find(existsSync) : undefined;
  if (!archive) archive = await (await import(pathToFileURL(electronRequire.resolve("@electron/get")).href)).downloadArtifact({ version: config.electronVersion, artifactName: "electron", platform, arch });
  const extract = (await import(pathToFileURL(electronRequire.resolve("@electron-internal/extract-zip")).href)).extract;
  mkdirSync(electronDir, { recursive: true }); await extract(archive, { dir: electronDir });
}
}
if (!coreOnly) await import("./build-client-executor.mjs");
if (shellOnly) { console.log("Desktop client runtime prepared"); process.exit(0); }
const serverOutput = path.join(output, "server");
mkdirSync(path.join(serverOutput, "core"), { recursive: true });
if (process.platform === "win32") await import("./build-personal-computer.mjs");
await viteBuild({ configFile: false, root, plugins: [react()], build: { outDir: path.join(serverOutput, "ui"), emptyOutDir: true, rollupOptions: { input: path.join(root, "personal.html") } } });
copyFileSync(path.join(serverOutput, "ui", "personal.html"), path.join(serverOutput, "ui", "index.html"));
await build({ entryPoints: ["server/personal-os/index.ts", "server/personal-os/workspaces.ts", "server/personal-os/worker.ts"].map((file) => path.join(root, file)), outdir: path.join(serverOutput, "core"), bundle: true, platform: "node", target: "node22", format: "esm", legalComments: "linked", define: { PI_BUNDLED_NODE: "true" }, external: ["pdfjs-dist/legacy/build/pdf.mjs"], banner: { js: "import { createRequire as nexCreateRequire } from 'node:module'; const require = nexCreateRequire(import.meta.url);" } });
await build({ entryPoints: [path.join(root, "server/personal-os/service.ts")], outfile: path.join(serverOutput, "core/service.js"), bundle: true, platform: "node", target: "node24", format: "esm", legalComments: "linked" });
for (const file of ["schema.sql", "node-schema.sql", "agent-schema.sql", "memory-schema.sql", "memory-lifecycle-schema.sql", "client-schema.sql", "task-control-schema.sql", "identity-schema.sql"]) copyFileSync(path.join(root, "server", "personal-os", file), path.join(serverOutput, "core", file));
cpSync(path.join(root, "server/personal-os/skills"), path.join(serverOutput, "core/skills"), { recursive: true });
mkdirSync(path.join(serverOutput, "core/model-catalog"), { recursive: true });
copyFileSync(path.join(root, "server/model-catalog/models-dev.snapshot.json"), path.join(serverOutput, "core/model-catalog/models-dev.snapshot.json"));
const pi = JSON.parse(readFileSync(path.join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
writeFileSync(path.join(serverOutput, "package.json"), JSON.stringify({ name: pi.name, version: pi.version, type: "module", piConfig: pi.piConfig }));
// PDF.js keeps its fake-worker module adjacent and loads the canvas shim using
// createRequire. Ship only its runtime plus the required native platform binary.
const modules = path.join(serverOutput, "node_modules"); mkdirSync(modules, { recursive: true });
cpSync(realpathSync(path.join(root, "node_modules/pdfjs-dist")), path.join(modules, "pdfjs-dist"), { recursive: true, dereference: true });
const pdfRequire = createRequire(realpathSync(path.join(root, "node_modules/pdfjs-dist/package.json")));
const canvasFile = pdfRequire.resolve("@napi-rs/canvas/package.json");
const canvasRequire = createRequire(canvasFile);
const canvasNative = process.platform === "darwin" ? `@napi-rs/canvas-darwin-${process.arch}` : process.platform === "win32" ? `@napi-rs/canvas-win32-${process.arch}-msvc` : `@napi-rs/canvas-linux-${process.arch}-gnu`;
for (const pkg of ["@napi-rs/canvas", canvasNative]) {
  const packageFile = (pkg === "@napi-rs/canvas" ? pdfRequire : canvasRequire).resolve(`${pkg}/package.json`);
  cpSync(path.dirname(packageFile), path.join(modules, pkg), { recursive: true, dereference: true });
}
const licenseDir = path.join(serverOutput, "licenses"); mkdirSync(licenseDir, { recursive: true });
copyFileSync(pdfRequire.resolve("@napi-rs/canvas/LICENSE"), path.join(licenseDir, "canvas-LICENSE.txt"));
copyFileSync(path.join(root, "third_party/rakazo/LICENSE"), path.join(licenseDir, "Rakazo-LICENSE.txt"));
copyFileSync(path.join(root, "third_party/rakazo/README.md"), path.join(licenseDir, "Rakazo-NOTICE.md"));
copyFileSync(path.join(root, "third_party/agent-reach/LICENSE"), path.join(licenseDir, "AgentReach-LICENSE.txt"));
copyFileSync(path.join(root, "LICENSE"), path.join(serverOutput, "LICENSE-OpenMausBot.txt"));
copyFileSync(path.join(root, "NOTICE"), path.join(serverOutput, "NOTICE"));
copyFileSync(path.join(root, "deploy/core/README.md"), path.join(serverOutput, "README.md"));
console.log("Backend service build complete:", serverOutput);

import { build } from "esbuild";
import { build as viteBuild } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, cpSync, realpathSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist-personal");
if (process.argv.includes("--release")) {
  const gate = spawnSync(process.execPath, [path.join(root, "scripts/verify-personal-resources.mjs")], { stdio: "inherit", windowsHide: true });
  if (gate.status !== 0) throw new Error("Production memory resource release gate failed");
}
const config = parse(readFileSync(path.join(root, "electron-builder.personal.yml"), "utf8"));
const electronDir = path.join(root, config.electronDist), electronExe = path.join(electronDir, "electron.exe");
if (!existsSync(electronExe) || spawnSync(electronExe, ["-p", "process.versions.electron"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", windowsHide: true }).stdout?.trim() !== config.electronVersion) {
  const electronRequire = createRequire(realpathSync(path.join(root, "node_modules/electron/package.json")));
  const cache = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "electron", "Cache");
  const zipName = `electron-v${config.electronVersion}-win32-x64.zip`;
  let archive = existsSync(cache) ? readdirSync(cache).map((dir) => path.join(cache, dir, zipName)).find(existsSync) : undefined;
  if (!archive) archive = await (await import(electronRequire.resolve("@electron/get"))).downloadArtifact({ version: config.electronVersion, artifactName: "electron", platform: "win32", arch: "x64" });
  const extract = (await import(electronRequire.resolve("extract-zip"))).default;
  mkdirSync(electronDir, { recursive: true }); await extract(archive, { dir: electronDir });
}
mkdirSync(path.join(output, "core"), { recursive: true });
await viteBuild({ configFile: false, root, plugins: [react()], build: { outDir: path.join(output, "ui"), emptyOutDir: true, rollupOptions: { input: path.join(root, "personal.html") } } });
copyFileSync(path.join(output, "ui", "personal.html"), path.join(output, "ui", "index.html"));
await build({ entryPoints: ["server/personal-os/index.ts", "server/personal-os/worker.ts"].map((file) => path.join(root, file)), outdir: path.join(output, "core"), bundle: true, platform: "node", target: "node22", format: "esm", legalComments: "linked", define: { PI_BUNDLED_NODE: "true" }, external: ["pdfjs-dist/legacy/build/pdf.mjs"], banner: { js: "import { createRequire as nexCreateRequire } from 'node:module'; const require = nexCreateRequire(import.meta.url);" } });
await build({ entryPoints: [path.join(root, "server/personal-os/client-node.ts")], outdir: path.join(output, "client-node"), bundle: true, platform: "node", target: "node22", format: "esm", legalComments: "linked", external: ["pdfjs-dist/legacy/build/pdf.mjs"], banner: { js: "import { createRequire as nexCreateRequire } from 'node:module'; const require = nexCreateRequire(import.meta.url);" } });
copyFileSync(path.join(root, "server/personal-os/node-schema.sql"), path.join(output, "client-node", "node-schema.sql"));
for (const file of ["schema.sql", "node-schema.sql", "agent-schema.sql", "memory-schema.sql", "memory-lifecycle-schema.sql", "client-schema.sql"]) copyFileSync(path.join(root, "server", "personal-os", file), path.join(output, "core", file));
copyFileSync(path.join(root, "server", "personal-os", "hindsight-service.py"), path.join(output, "core", "hindsight-service.py"));
const pi = JSON.parse(readFileSync(path.join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
writeFileSync(path.join(output, "package.json"), JSON.stringify({ name: pi.name, version: pi.version, type: "module", piConfig: pi.piConfig }));
// PDF.js keeps its fake-worker module adjacent and loads the canvas shim using
// createRequire. Ship only its runtime plus the required native platform binary.
const modules = path.join(output, "node_modules"); mkdirSync(modules, { recursive: true });
cpSync(realpathSync(path.join(root, "node_modules/pdfjs-dist")), path.join(modules, "pdfjs-dist"), { recursive: true, dereference: true });
const pdfRequire = createRequire(realpathSync(path.join(root, "node_modules/pdfjs-dist/package.json")));
const canvasFile = pdfRequire.resolve("@napi-rs/canvas/package.json");
const canvasRequire = createRequire(canvasFile);
for (const pkg of ["@napi-rs/canvas", "@napi-rs/canvas-win32-x64-msvc"]) {
  const packageFile = (pkg === "@napi-rs/canvas" ? pdfRequire : canvasRequire).resolve(`${pkg}/package.json`);
  cpSync(path.dirname(packageFile), path.join(modules, pkg), { recursive: true, dereference: true });
}
const licenseDir = path.join(output, "licenses"); mkdirSync(licenseDir, { recursive: true });
copyFileSync(pdfRequire.resolve("@napi-rs/canvas/LICENSE"), path.join(licenseDir, "canvas-LICENSE.txt"));
copyFileSync(path.join(root, "LICENSE"), path.join(output, "LICENSE-OpenMausBot.txt"));
console.log("Personal OS build complete:", output);

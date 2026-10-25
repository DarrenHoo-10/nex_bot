import { build } from "esbuild";
import { build as viteBuild } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, copyFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { htmlPreviewShell } from "../shared/html-preview-shell.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist-personal/client-executor");
mkdirSync(path.join(output, "client-node"), { recursive: true });
await build({ entryPoints: [path.join(root, "server/personal-os/client-node.ts")], outfile: path.join(output, "client-node/client-node.js"), bundle: true, platform: "node", target: "node22", format: "esm", legalComments: "linked", external: ["pdfjs-dist/legacy/build/pdf.mjs"], banner: { js: "import { createRequire as nexRequire } from 'node:module'; const require = nexRequire(import.meta.url);" } });
copyFileSync(path.join(root, "server/personal-os/node-schema.sql"), path.join(output, "client-node/node-schema.sql"));
writeFileSync(path.join(output, "package.json"), JSON.stringify({ type: "module", private: true }));
if (process.platform === "win32") {
  await import("./build-personal-computer.mjs");
  cpSync(path.join(root, "dist-personal/server/computer-runtime"), path.join(output, "computer-runtime"), { recursive: true });
}
const pdfRoot = realpathSync(path.join(root, "node_modules/pdfjs-dist"));
const pdfRequire = createRequire(path.join(pdfRoot, "package.json"));
const canvasRequire = createRequire(pdfRequire.resolve("@napi-rs/canvas/package.json"));
const native = process.platform === "darwin" ? `@napi-rs/canvas-darwin-${process.arch}` : process.platform === "win32" ? `@napi-rs/canvas-win32-${process.arch}-msvc` : `@napi-rs/canvas-linux-${process.arch}-gnu`;
mkdirSync(path.join(output, "node_modules"), { recursive: true });
cpSync(pdfRoot, path.join(output, "node_modules/pdfjs-dist"), { recursive: true });
for (const pkg of ["@napi-rs/canvas", native]) {
  const filename = (pkg === "@napi-rs/canvas" ? pdfRequire : canvasRequire).resolve(`${pkg}/package.json`);
  cpSync(path.dirname(filename), path.join(output, "node_modules", pkg), { recursive: true });
}
copyFileSync(path.join(root, "LICENSE"), path.join(output, "LICENSE.txt"));
copyFileSync(pdfRequire.resolve("@napi-rs/canvas/LICENSE"), path.join(output, "canvas-LICENSE.txt"));
// A complete client uses the matching UI instead of waiting for a server rollout.
const ui = path.join(root, "dist-personal/client-ui");
await viteBuild({ configFile: false, root, plugins: [react()], build: { outDir: ui, emptyOutDir: true, rollupOptions: { input: path.join(root, "personal.html") } } });
copyFileSync(path.join(ui, "personal.html"), path.join(ui, "index.html"));
writeFileSync(path.join(ui, "html-preview.html"), htmlPreviewShell());
console.log("Client executor and matching UI prepared:", output);

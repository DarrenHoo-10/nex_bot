import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { androidViewportUnits } from "./android-viewport.mjs";
import { htmlPreviewShell } from "../shared/html-preview-shell.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const input = path.join(root, "android/app/build/ui-entry");
mkdirSync(input, { recursive: true });
writeFileSync(path.join(input, "index.html"), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>NexBot</title></head><body><div id="root"></div><script type="module" src="/src/personal/android-entry.ts"></script></body></html>');
await build({ configFile: false, root, plugins: [tailwindcss(), androidViewportUnits(), react()], publicDir: false, build: {
  target: "chrome100", outDir: path.join(root, "android/app/build/generated/workspaceAssets/workspace"), emptyOutDir: true,
  rollupOptions: { input: path.join(input, "index.html") },
} });
// Vite preserves an HTML entry's path relative to root.
const { readFileSync } = await import("node:fs");
const output = path.join(root, "android/app/build/generated/workspaceAssets/workspace");
writeFileSync(path.join(output, "index.html"), readFileSync(path.join(output, "android/app/build/ui-entry/index.html")));
rmSync(path.join(output, "android"), { recursive: true, force: true });
writeFileSync(path.join(output, "html-preview.html"), htmlPreviewShell());
// Avatar atlases use stable /companions URLs and must be available offline.
cpSync(path.join(root, "public/companions"), path.join(output, "companions"), { recursive: true });

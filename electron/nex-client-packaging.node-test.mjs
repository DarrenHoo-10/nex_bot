import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The client packages list their files explicitly. A local module missing from
// that list makes the packaged main process fail on import before any window.
function localImports(file) {
  const source = readFileSync(path.join(root, file), "utf8");
  const specifiers = [...source.matchAll(/(?:from\s+|require\()\s*["'](\.{1,2}\/[^"']+)["']/g)].map((match) => match[1]);
  return specifiers.map((specifier) => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
}

for (const config of ["electron-builder.client.yml", "electron-builder.client.mac.yml"]) {
  test(`${config} packages every local module the client main and preload import`, () => {
    const files = readFileSync(path.join(root, config), "utf8").split("\n").map((line) => line.match(/^\s*-\s*'?([^'#]+?)'?\s*$/)?.[1]).filter(Boolean);
    for (const imported of [...localImports("electron/nex-client-main.mjs"), ...localImports("electron/nex-client-preload.cjs")]) {
      assert.ok(files.includes(imported), `${config} does not package ${imported}`);
    }
  });
}

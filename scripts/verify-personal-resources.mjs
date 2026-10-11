// Release gate and byte inventory. All inputs are ignored build artifacts;
// never enumerate a user profile, vault or developer environment here.
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(process.argv.find((arg) => arg.startsWith("--resources="))?.slice(12) ?? path.join(repo, "dist-personal/memory-runtime"));
const manifest = JSON.parse(readFileSync(path.join(root, "runtime.json"), "utf8"));
const lock = JSON.parse(readFileSync(path.join(repo, "scripts/memory-runtime-lock.json"), "utf8"));
const quality = JSON.parse(readFileSync(path.join(repo, "release/personal-os/chinese-memory-quality.json"), "utf8"));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (manifest.release !== lock.engine || !equal(manifest.dependencies, lock.dependencies) || !equal(manifest.models.revisions, lock.models)) throw new Error("Runtime lock mismatch");
if (quality.release !== manifest.release || quality.queries !== 100 || !quality.passed || quality.recallAt10 < .85 || quality.recallAt10 - quality.likeRecallAt10 < .20 || !equal(quality.models, manifest.models.revisions)) throw new Error("Chinese retrieval gate missing or wrong revisions");
const python = path.resolve(root, manifest.python);
if (!python.startsWith(root + path.sep)) throw new Error("Python escapes resource directory");
const check = spawnSync(python, ["-I", "-c", "import sys,json,importlib.metadata as m; print(json.dumps({'python':'.'.join(map(str,sys.version_info[:3])),'dependencies':{d.metadata['Name'].lower():d.version for d in m.distributions()},'paths':sys.path}))"], { encoding: "utf8", windowsHide: true });
if (check.status !== 0) throw new Error("Bundled Python cannot run independently");
const runtime = JSON.parse(check.stdout);
if (runtime.python !== lock.python || !equal(Object.entries(runtime.dependencies).sort(), Object.entries(lock.dependencies).sort()) || runtime.paths.some((entry) => !path.resolve(entry).startsWith(root + path.sep))) throw new Error("External dependencies or Python version mismatch");
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((item) => {
    if (item.name === "__pycache__" || item.name.endsWith(".pyc") || item.name === "inventory.json" || (directory === root && item.name.endsWith(".zip"))) return [];
    const filename = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error("Resource symlink is not portable");
    return item.isDirectory() ? files(filename) : [filename];
  });
}
const inventory = {};
for (const filename of files(root)) {
  const digest = createHash("sha256"); for await (const chunk of createReadStream(filename)) digest.update(chunk);
  inventory[path.relative(root, filename).replaceAll("\\", "/")] = digest.digest("hex");
}
const modelFiles = Object.keys(inventory).filter((filename) => filename.startsWith("models/"));
if (!equal(modelFiles.sort(), Object.keys(manifest.models.sha256).sort()) || modelFiles.some((filename) => inventory[filename] !== manifest.models.sha256[filename])) throw new Error("Model integrity mismatch");
const inventoryFile = path.join(root, "inventory.json");
if (process.argv.includes("--compare")) {
  const expected = JSON.parse(readFileSync(inventoryFile, "utf8"));
  if (!equal(Object.entries(inventory).sort(), Object.entries(expected).sort())) throw new Error("Packaged runtime bytes changed");
} else writeFileSync(inventoryFile, JSON.stringify(inventory, null, 2) + "\n");
console.log(JSON.stringify({ passed: true, files: Object.keys(inventory).length, dependencies: Object.keys(lock.dependencies).length, python: runtime.python, engine: manifest.release, recallAt10: quality.recallAt10 }));

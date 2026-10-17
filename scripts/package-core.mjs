import path from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { c as archive } from "tar";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repo, "dist-personal/server");
if (!existsSync(path.join(source, "core/service.js"))) throw new Error("Run build:core before packaging");
const output = path.join(repo, "release/core"); mkdirSync(output, { recursive: true });
const filename = `NexBot-Core-0.8.1-${process.platform}-${process.arch}.tar.gz`;
const file = path.join(output, filename);
const entries = ["core", "ui", "node_modules", "package.json", "licenses", "LICENSE-OpenMausBot.txt", "NOTICE", "README.md"];
if (existsSync(path.join(source, "computer-runtime"))) entries.push("computer-runtime");
await archive({ cwd: source, file, gzip: true, portable: true, filter: (entry) => !entry.split("/").some((part) => ["electron", "memory-runtime", "vault-key.bin", "core.db", "service.lock", "service.json"].includes(part) || part.startsWith(".env")) }, entries);
const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
writeFileSync(path.join(output, "SHA256SUMS.txt"), `${digest}  ${filename}\n`);
console.log("Backend service archive:", file);

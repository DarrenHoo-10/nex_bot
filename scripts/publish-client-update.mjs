// Mirrors client installers to OSS and updates the release manifest that Core's
// /api/client/update serves. Run where the OSS_* variables are set (the Core host):
//   node scripts/publish-client-update.mjs --dir=<assets> --tag=<release tag> [--notes=<text>] [--dry-run]
// Only installers built from a pushed main commit may be published (see AGENTS.md).
import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const dir = arg("dir"), tag = arg("tag"), notes = arg("notes") ?? "", dryRun = process.argv.includes("--dry-run");
if (!dir || !tag || !/^[A-Za-z0-9._-]+$/.test(tag)) throw new Error("用法：--dir=<安装包目录> --tag=<发布标签> [--notes=<说明>] [--dry-run]");
const { OSS_ENDPOINT: endpoint, OSS_BUCKET: bucket, OSS_ACCESS_KEY_ID: keyId, OSS_ACCESS_KEY_SECRET: secret } = process.env;
if (!endpoint || !bucket || !keyId || !secret) throw new Error("缺少 OSS_ENDPOINT / OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET");
const host = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`).hostname;
const origin = `https://${host.startsWith(bucket + ".") ? host : `${bucket}.${host}`}`;
const manifestKey = "nexbot/releases/manifest.json";

const patterns = {
  windows: /^NexBot-(\d+\.\d+\.\d+)-x64-Client-Portable\.exe$/,
  android: /^nexbot-(\d+\.\d+\.\d+)-(?!unsigned)[a-z]+\.apk$/,
  mac: /^NexBot-(\d+\.\d+\.\d+)-mac-arm64\.dmg$/,
  ios: /^NexBot-(\d+\.\d+\.\d+)-ios-unsigned\.ipa$/,
};

function signed(method, key, headers = {}, md5 = "", type = "") {
  const date = new Date().toUTCString();
  const oss = Object.entries(headers).filter(([name]) => name.startsWith("x-oss-")).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}:${value}\n`).join("");
  const signature = createHmac("sha1", secret).update(`${method}\n${md5}\n${type}\n${date}\n${oss}/${bucket}/${key}`).digest("base64");
  return { Date: date, Authorization: `OSS ${keyId}:${signature}`, ...headers, ...(md5 ? { "Content-MD5": md5 } : {}), ...(type ? { "Content-Type": type } : {}) };
}
async function put(key, body, type, overwrite) {
  const md5 = createHash("md5").update(body).digest("base64");
  const headers = { "x-oss-object-acl": "private", ...(overwrite ? {} : { "x-oss-forbid-overwrite": "true" }) };
  const response = await fetch(`${origin}/${key}`, { method: "PUT", headers: signed("PUT", key, headers, md5, type), body, redirect: "error" });
  await response.body?.cancel();
  if (response.status === 409 && !overwrite) return "exists";
  if (!response.ok) throw new Error(`上传 ${key} 返回 HTTP ${response.status}`);
  return "uploaded";
}
async function get(key) {
  return fetch(`${origin}/${key}`, { headers: signed("GET", key), redirect: "error" });
}

const files = [];
for (const name of readdirSync(dir).sort()) {
  for (const [platform, pattern] of Object.entries(patterns)) {
    const match = pattern.exec(name);
    if (!match) continue;
    if (files.some((file) => file.platform === platform)) throw new Error(`同一平台有多个安装包：${platform}`);
    const bytes = readFileSync(path.join(dir, name));
    files.push({ platform, version: match[1], file: name, key: `nexbot/releases/${tag}/${name}`, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), bytes });
  }
}
if (!files.length) throw new Error("目录里没有可发布的安装包");

let previous = { platforms: {} };
const current = await get(manifestKey);
if (current.ok) previous = await current.json(); else { await current.body?.cancel(); if (current.status !== 404) throw new Error(`读取发布清单返回 HTTP ${current.status}`); }
const manifest = { version: 1, tag, publishedAt: new Date().toISOString(), notes, platforms: { ...previous.platforms } };
for (const { platform, bytes: _bytes, ...entry } of files) manifest.platforms[platform] = entry;
for (const file of files) console.log(`${file.platform.padEnd(8)} ${file.version.padEnd(8)} ${file.file} ${file.size} ${file.sha256}`);
if (dryRun) { console.log(JSON.stringify(manifest, null, 2)); process.exit(0); }

for (const file of files) {
  const state = await put(file.key, file.bytes, "application/octet-stream", false);
  // Read the object back so the manifest never points at a missing or different file.
  const check = await get(file.key);
  const remote = Buffer.from(await check.arrayBuffer());
  if (!check.ok || createHash("sha256").update(remote).digest("hex") !== file.sha256) throw new Error(`${file.key} 读回校验失败`);
  console.log(`${state === "exists" ? "已存在且一致" : "已上传并校验"}：${file.key}`);
}
await put(manifestKey, Buffer.from(JSON.stringify(manifest, null, 2)), "application/json", true);
console.log(`发布清单已更新：${tag}`);

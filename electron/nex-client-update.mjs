import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, copyFileSync } from "node:fs";
import path from "node:path";

const versionPattern = /^\d+\.\d+\.\d+$/;
export const portablePattern = /^NexBot-\d+\.\d+\.\d+-x64-Client-Portable(?: \(\d+\))?\.exe$/i;

/**
 * Checks Core for a newer Windows client, downloads it in the background and
 * verifies its size and SHA-256 before offering it. Nothing is installed
 * without the user choosing "立即更新".
 */
export class ClientUpdater {
  constructor({ version, directory, fetch: transport = fetch, changed = () => {} }) {
    Object.assign(this, { version, directory, transport, changed });
    this.status = "idle"; this.busy = false;
  }
  state() {
    return { status: this.status, current: this.version, version: this.offer?.version, progress: this.progress, error: this.error, notes: this.offer?.notes };
  }
  set(status, extra = {}) { Object.assign(this, { status, ...extra }); this.changed(this.state()); }
  async check(origin) {
    if (this.busy || this.status === "ready") return this.state();
    this.busy = true;
    try {
      const url = new URL("/api/client/update", origin);
      url.searchParams.set("platform", "windows"); url.searchParams.set("version", this.version);
      const response = await this.transport(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const offer = await response.json();
      if (!offer.available) { this.offer = undefined; this.set("idle", { error: undefined }); return this.state(); }
      if (!versionPattern.test(offer.version) || !portablePattern.test(offer.file) || !/^[a-f0-9]{64}$/.test(offer.sha256) || !Number.isSafeInteger(offer.size) || !String(offer.url).startsWith("https://")) throw new Error("更新信息无效");
      this.offer = offer;
      this.file = path.join(this.directory, offer.file);
      if (existsSync(this.file) && this.digest(this.file) === offer.sha256) { this.set("ready", { error: undefined }); return this.state(); }
      await this.download(offer);
      this.set("ready", { progress: 1, error: undefined });
    } catch (error) {
      // A failed check or download is retried at the next check.
      this.set(this.offer ? "error" : "idle", { error: this.offer ? (error instanceof Error ? error.message : "更新下载失败") : undefined });
    } finally { this.busy = false; }
    return this.state();
  }
  digest(file) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
  async download(offer) {
    mkdirSync(this.directory, { recursive: true });
    const partial = `${this.file}.part`;
    this.set("downloading", { progress: 0, error: undefined });
    const response = await this.transport(offer.url, { redirect: "error", signal: AbortSignal.timeout(30 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`下载返回 HTTP ${response.status}`);
    const hash = createHash("sha256"), out = createWriteStream(partial);
    let received = 0, reported = 0;
    try {
      for await (const chunk of response.body) {
        received += chunk.byteLength;
        if (received > offer.size) throw new Error("更新文件大小不符");
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
        if (received - reported > offer.size / 50) { reported = received; this.set("downloading", { progress: received / offer.size }); }
      }
      await new Promise((resolve, reject) => out.end((error) => error ? reject(error) : resolve()));
    } catch (error) { out.destroy(); rmSync(partial, { force: true }); throw error; }
    if (received !== offer.size || hash.digest("hex") !== offer.sha256) { rmSync(partial, { force: true }); throw new Error("更新文件校验失败"); }
    renameSync(partial, this.file);
  }
}

/**
 * Places the verified portable next to the running one and returns the
 * PowerShell script that waits for this client to exit, starts the new
 * version with the same profile/origin arguments and removes the old file.
 */
export function portableHandoff({ downloaded, currentExe, pids, args }) {
  const directory = path.dirname(currentExe), target = path.join(directory, path.basename(downloaded));
  if (path.resolve(target) !== path.resolve(currentExe)) copyFileSync(downloaded, target);
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const removeOld = path.resolve(target) !== path.resolve(currentExe) && portablePattern.test(path.basename(currentExe));
  const argumentList = args.length ? ` -ArgumentList ${args.map(quote).join(",")}` : "";
  return [
    `Wait-Process -Id ${pids.map(Number).filter(Number.isSafeInteger).join(",")} -Timeout 60 -ErrorAction SilentlyContinue`,
    `Start-Process -FilePath ${quote(target)}${argumentList}`,
    ...(removeOld ? [`Start-Sleep -Seconds 3`, `Remove-Item -LiteralPath ${quote(currentExe)} -Force -ErrorAction SilentlyContinue`] : []),
  ].join("; ");
}

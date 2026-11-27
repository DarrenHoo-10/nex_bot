import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

const setupPattern = /^NexBot-(\d+\.\d+\.\d+)-x64-Client-Setup\.exe$/;

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
    this.set("checking", { error: undefined });
    try {
      const url = new URL("/api/client/update", origin);
      url.searchParams.set("platform", "windows"); url.searchParams.set("version", this.version);
      url.searchParams.set("format", "nsis");
      const response = await this.transport(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const offer = await response.json();
      if (offer.available === false) { this.offer = undefined; this.set("current", { error: undefined, progress: undefined }); return this.state(); }
      if (offer.available !== true) throw new Error("更新信息无效");
      const installer = setupPattern.exec(offer.file);
      if (!installer || installer[1] !== offer.version || !/^[a-f0-9]{64}$/.test(offer.sha256) || !Number.isSafeInteger(offer.size) || offer.size < 1 || !String(offer.url).startsWith("https://")) throw new Error("更新信息无效");
      this.offer = offer;
      this.file = path.join(this.directory, offer.file);
      if (existsSync(this.file) && this.digest(this.file) === offer.sha256) { this.set("ready", { progress: 1, error: undefined }); return this.state(); }
      await this.download(offer);
      this.set("ready", { progress: 1, error: undefined });
    } catch (error) {
      // A failed check or download is retried at the next check.
      this.set("error", { error: error instanceof Error ? error.message : "检查更新失败" });
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
 * Wait for the client to exit before NSIS replaces files in its registered directory.
 * Windows PowerShell 5.1 (ConsoleHost) exits immediately with code 0 without running
 * scripts when spawned with `detached: true` (DETACHED_PROCESS), while a direct
 * non-detached child is terminated when Electron quits. Run a short-lived hidden
 * launcher (`detached: false`) that hands off to an independent hidden PowerShell
 * via `Start-Process`, and wait for the launcher to exit cleanly before quitting.
 */
export async function runInstallerAfterExit({ downloaded, currentExe, pid, args, launch = spawn, timeoutMs = 15_000 }) {
  if (!existsSync(downloaded)) throw new Error("更新文件已丢失，请重新下载");
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("无效的进程 ID");
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const launchArgs = args.map((arg) => {
    const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, "$&$&");
    return `"${escaped}"`;
  }).join(" ");
  const argumentList = launchArgs ? ` -ArgumentList ${quote(launchArgs)}` : "";
  const script = [
    `Wait-Process -Id ${pid} -Timeout 60 -ErrorAction SilentlyContinue`,
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 1 }`,
    `try { Start-Process -FilePath ${quote(downloaded)} -ArgumentList '/S --updated' -Wait -ErrorAction Stop }`,
    `finally { if (Test-Path -LiteralPath ${quote(currentExe)}) { Start-Process -FilePath ${quote(currentExe)}${argumentList} } }`,
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const launcher = `Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','${encoded}') -ErrorAction Stop`;
  const child = launch(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", launcher],
    { detached: false, stdio: "ignore", windowsHide: true },
  );
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(new Error("启动更新程序超时"));
    }, timeoutMs);
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(signal ? `更新启动器异常终止 (${signal})` : `无法启动更新程序 (退出码 ${code ?? "未知"})`));
    });
  });
}

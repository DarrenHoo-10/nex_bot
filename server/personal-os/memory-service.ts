import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { CoreStore, hash } from "./store.ts";
import { MemoryModelGateway } from "./memory-gateway.ts";
import { MemoryLedger } from "./memory-ledger.ts";
import { HindsightClient } from "./hindsight.ts";

export interface MemoryRuntimeOptions { command: string; args?: string[]; fixture?: boolean; models?: Record<string, unknown> }
export class ManagedMemoryService {
  readonly gateway: MemoryModelGateway;
  child?: ChildProcessWithoutNullStreams;
  startup?: Promise<void>;
  state = "not_installed";
  diagnostic = "";
  closing = false;
  constructor(readonly store: CoreStore, readonly ledger: MemoryLedger, readonly options?: MemoryRuntimeOptions) { this.gateway = new MemoryModelGateway(store); }
  start() {
    // An absent distribution is an explicit unavailable mode, not another
    // homegrown engine or an implicit download into the user's environment.
    if (!this.options || this.startup || this.closing) return;
    this.state = "starting";
    this.startup = this.boot().catch(() => { this.state = "unavailable"; this.ledger.lastError = "memory_engine_start_failed"; this.ledger.changed(); });
  }
  async boot() {
    await this.gateway.start();
    if (this.closing) return;
    const token = randomBytes(32).toString("hex");
    let pgSecret = this.store.get("SELECT ciphertext FROM secrets WHERE id='memory-pg-key'");
    if (!pgSecret) { this.store.run("INSERT INTO secrets VALUES('memory-pg-key',?)", this.store.encrypt(randomBytes(32).toString("hex"))); pgSecret = this.store.get("SELECT ciphertext FROM secrets WHERE id='memory-pg-key'")!; }
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(HINDSIGHT_|OPENAI_|ANTHROPIC_)/.test(key)) delete env[key];
    const script = new URL("./hindsight-service.py", import.meta.url);
    this.child = spawn(this.options!.command, [...(this.options!.args ?? []), fileURLToPath(script), ...(this.options!.fixture ? ["--fixture"] : [])], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const child = this.child;
    child.stderr.resume(); // deliberately no provider/content logging
    child.once("exit", () => { this.ledger.client = undefined; if (!this.closing) { this.state = "unavailable"; this.ledger.lastError = "memory_engine_stopped"; this.ledger.changed(); } });
    child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify({ dataDir: path.join(this.store.dir, "hindsight"), namespace: "nex-" + hash(this.store.dir).slice(0, 16), pgPassword: this.store.decrypt(String(pgSecret.ciphertext)), gateway: this.gateway.origin, gatewayToken: this.gateway.token, serviceToken: token, models: this.options!.models }) + "\n");
    await new Promise<void>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => { child.stdin.end(); reject(new Error("Memory startup timeout")); }, 180_000);
      const fail = () => { clearTimeout(timer); child.stdin.end(); reject(new Error("Memory startup failed")); };
      child.once("error", fail); child.once("exit", fail);
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > 16_384) { fail(); return; }
        while (buffer.includes("\n")) {
          const position = buffer.indexOf("\n"), line = buffer.slice(0, position); buffer = buffer.slice(position + 1);
          try {
            const event = JSON.parse(line) as { type: string; endpoint: string; release: string; diagnostic?: string };
            if (event.type === "error") { if (this.options!.fixture) this.diagnostic = event.diagnostic ?? ""; fail(); return; }
            if (event.type !== "ready" || event.release !== "0.10.3") continue;
            this.ledger.client = new HindsightClient(event.endpoint, token);
            this.state = "ready"; this.ledger.lastError = null;
            clearTimeout(timer); child.off("exit", fail); child.off("error", fail);
            resolve(); this.ledger.changed();
          } catch { /* only framed control events are used */ }
        }
      });
    });
  }
  async close() {
    this.closing = true;
    this.child?.stdin.end("quit\n");
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      const child = this.child;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          // Kill only the process tree we spawned. No global Python/pg0 kill.
          if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).once("exit", () => resolve());
          else { child.kill("SIGKILL"); resolve(); }
        }, 15_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    await this.startup;
    if (this.gateway.origin) await this.gateway.close();
  }
}
export function bundledMemoryRuntime(): MemoryRuntimeOptions | undefined {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "memory-runtime");
  const manifestFile = path.join(root, "runtime.json");
  if (!existsSync(manifestFile)) return;
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { release: string; python: string; models: Record<string, unknown> };
  const command = path.resolve(root, manifest.python);
  if (manifest.release !== "0.10.3" || !command.startsWith(root + path.sep) || !existsSync(command)) throw new Error("Invalid memory runtime distribution");
  return { command, models: { ...manifest.models, root: root } };
}

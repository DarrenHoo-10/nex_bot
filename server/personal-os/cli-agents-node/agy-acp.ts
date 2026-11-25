// AGY's public stdio ACP transport. Authentication and settings stay with the
// user's CLI profile. The client never forwards raw subprocess diagnostics.
import { StringDecoder } from "node:string_decoder";
import { killCliTree, spawnCli } from "../../procs.ts";
import { agyRecord, agyString, type AgyRecord } from "./agy-native.ts";

type RpcId = string | number;
type Inbound = (method: string, params: AgyRecord, id: RpcId | undefined) => void;
type Pending = {
  resolve: (value: AgyRecord) => void;
  reject: (error: AgyAcpError) => void;
  timer: NodeJS.Timeout;
  isPrompt: boolean;
};

const MAX_LINE = 8 * 1024 * 1024;
const PROMPT_IDLE = 15 * 60_000;

export class AgyAcpError extends Error {
  constructor(readonly rpcCode: number | undefined, message: string) {
    super(message);
  }
}

export class AgyAcp {
  private readonly child: ReturnType<typeof spawnCli>;
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<number, Pending>();
  private readonly exited: Promise<void>;
  private buffer = "";
  private id = 0;
  private stopped: Promise<void> | undefined;
  private closed = false;
  capabilities: AgyRecord = {};

  constructor(
    executable: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    private readonly inbound: Inbound,
    private readonly disconnected: () => void,
  ) {
    this.child = spawnCli(executable, ["acp"], {
      cwd, env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" }, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.resume();
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(this.decoder.write(chunk)));
    this.child.on("error", () => this.fail("无法启动 Antigravity CLI"));
    this.exited = new Promise((resolve) => this.child.once("close", () => {
      this.fail("Antigravity CLI 已断开");
      resolve();
    }));
  }

  get pid(): number | undefined { return this.child.pid; }

  async initialize(): Promise<void> {
    const response = await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "nexagent", title: "NexAgent", version: "1" },
      clientCapabilities: { elicitation: { form: {} } },
    });
    if (response.protocolVersion !== 1) throw new AgyAcpError(undefined, "Antigravity CLI 的 ACP 版本不兼容");
    this.capabilities = agyRecord(response.agentCapabilities);
  }

  call(method: string, params: AgyRecord, timeout = 8000): { written: Promise<void>; result: Promise<AgyRecord> } {
    const id = ++this.id;
    const result = new Promise<AgyRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgyAcpError(undefined, "Antigravity CLI 响应超时"));
      }, timeout);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer, isPrompt: method === "session/prompt" });
    });
    const written = this.write({ jsonrpc: "2.0", id, method, params }).catch((error: AgyAcpError) => {
      this.complete(id)?.reject(error);
      throw error;
    });
    // Both promises may reject before the caller can await the other one.
    void written.catch(() => {});
    void result.catch(() => {});
    return { written, result };
  }

  async request(method: string, params: AgyRecord, timeout?: number): Promise<AgyRecord> {
    const { written, result } = this.call(method, params, timeout);
    await written;
    return result;
  }

  prompt(params: AgyRecord): ReturnType<AgyAcp["call"]> {
    return this.call("session/prompt", params, PROMPT_IDLE);
  }

  cancel(sessionId: string): Promise<void> {
    return this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  respond(id: RpcId, result: unknown): Promise<void> {
    return this.write({ jsonrpc: "2.0", id, result });
  }

  refuse(id: RpcId, code = -32601): Promise<void> {
    return this.write({ jsonrpc: "2.0", id, error: { code, message: "Unsupported ACP request" } });
  }

  close(): Promise<void> {
    this.stopped ??= this.stop();
    return this.stopped;
  }

  private async stop(): Promise<void> {
    this.fail("Antigravity CLI 已断开");
    this.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.exited, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 750);
      timer.unref();
    })]);
    clearTimeout(timer);
    if (!await killCliTree(this.child, 1000)) throw new AgyAcpError(undefined, "Antigravity CLI 仍在退出");
  }

  private write(message: AgyRecord): Promise<void> {
    if (this.closed) return Promise.reject(new AgyAcpError(undefined, "Antigravity CLI 已断开"));
    return new Promise((resolve, reject) => {
      this.child.stdin.write(JSON.stringify(message) + "\n", (error) => {
        if (error) reject(new AgyAcpError(undefined, "写入 Antigravity CLI 的结果未知"));
        else resolve();
      });
    });
  }

  private receive(text: string): void {
    if (this.closed) return;
    this.buffer += text;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      if (newline > MAX_LINE) { void this.close().catch(() => {}); return; }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.startsWith("{")) this.message(line);
    }
    if (this.buffer.length > MAX_LINE) void this.close().catch(() => {});
  }

  private message(line: string): void {
    let message: AgyRecord;
    try { message = agyRecord(JSON.parse(line)); } catch { return; }
    if (message.jsonrpc !== "2.0") return;
    if (typeof message.method === "string") {
      if (message.method === "session/update") {
        for (const pending of this.pending.values()) if (pending.isPrompt) pending.timer.refresh();
      }
      const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined;
      this.inbound(message.method, agyRecord(message.params), id);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.complete(message.id);
    if (!pending) return;
    if (message.error) {
      const error = agyRecord(message.error);
      pending.reject(new AgyAcpError(typeof error.code === "number" ? error.code : undefined, agyString(error.message) || "Antigravity CLI 请求失败"));
    } else pending.resolve(agyRecord(message.result));
  }

  private complete(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
    }
    return pending;
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.pending.keys()) this.complete(id)?.reject(new AgyAcpError(undefined, message));
    this.disconnected();
  }
}

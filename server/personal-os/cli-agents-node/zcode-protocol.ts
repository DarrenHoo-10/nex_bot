// ZCode's stdio NDJSON `app-server` transport.
// Unlike JSON-RPC 2.0 / ACP, ZCode's Zod strict schemas omit the `jsonrpc`
// envelope field: requests are `{ id, method, params }`, notifications are
// `{ method, params }`, and responses are `{ id, result }` or `{ id, error }`.
import { StringDecoder } from "node:string_decoder";
import { killCliTree, spawnCli } from "../../procs.ts";

export type ZcodeRpcId = string | number;
export type ZcodeRecord = Record<string, unknown>;
type Inbound = (method: string, params: ZcodeRecord, id: ZcodeRpcId | undefined) => void;

interface Pending {
  resolve: (value: ZcodeRecord) => void;
  reject: (error: ZcodeProtocolError) => void;
  timer: NodeJS.Timeout;
}

const MAX_LINE = 8 * 1024 * 1024;

export function asZcodeRecord(value: unknown): ZcodeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ZcodeRecord) : {};
}

export function asZcodeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asZcodeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export class ZcodeProtocolError extends Error {
  constructor(
    readonly rpcCode: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface ZcodeServerSpawn {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export class ZcodeAppServer {
  private readonly child: ReturnType<typeof spawnCli>;
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<number, Pending>();
  private readonly exited: Promise<void>;
  private buffer = "";
  private nextId = 0;
  private stopped: Promise<void> | undefined;
  private closed = false;

  constructor(
    spawn: ZcodeServerSpawn,
    private readonly inbound: Inbound,
    private readonly disconnected: () => void,
  ) {
    this.child = spawnCli(spawn.command, spawn.args, {
      cwd: spawn.cwd,
      env: spawn.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.resume();
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(this.decoder.write(chunk)));
    this.child.on("error", () => this.fail("无法启动 ZCode"));
    this.exited = new Promise((resolve) =>
      this.child.once("close", () => {
        this.fail("ZCode 已断开");
        resolve();
      }),
    );
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  call(method: string, params?: ZcodeRecord, timeout = 15_000): { written: Promise<void>; result: Promise<ZcodeRecord> } {
    const id = ++this.nextId;
    const result = new Promise<ZcodeRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ZcodeProtocolError(undefined, "ZCode 响应超时"));
      }, timeout);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
    const envelope: ZcodeRecord = params === undefined ? { id, method } : { id, method, params };
    const written = this.write(envelope).catch((error: ZcodeProtocolError) => {
      this.complete(id)?.reject(error);
      throw error;
    });
    void written.catch(() => {});
    void result.catch(() => {});
    return { written, result };
  }

  async request(method: string, params?: ZcodeRecord, timeout?: number): Promise<ZcodeRecord> {
    const { written, result } = this.call(method, params, timeout);
    await written;
    return result;
  }

  notify(method: string, params?: ZcodeRecord): Promise<void> {
    return this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: ZcodeRpcId, result: unknown): Promise<void> {
    return this.write({ id, result });
  }

  refuse(id: ZcodeRpcId, code = -32601, message = "Unsupported ZCode request"): Promise<void> {
    return this.write({ id, error: { code, message } });
  }

  close(): Promise<void> {
    this.stopped ??= this.stop();
    return this.stopped;
  }

  private async stop(): Promise<void> {
    this.fail("ZCode 已断开");
    this.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 750);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    if (!(await killCliTree(this.child, 1000))) throw new ZcodeProtocolError(undefined, "ZCode 仍在退出");
  }

  private write(message: ZcodeRecord): Promise<void> {
    if (this.closed) return Promise.reject(new ZcodeProtocolError(undefined, "ZCode 已断开"));
    return new Promise((resolve, reject) => {
      this.child.stdin.write(JSON.stringify(message) + "\n", (error) => {
        if (error) reject(new ZcodeProtocolError(undefined, "写入 ZCode 的结果未知"));
        else resolve();
      });
    });
  }

  private receive(text: string): void {
    if (this.closed) return;
    this.buffer += text;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      if (newline > MAX_LINE) {
        void this.close().catch(() => {});
        return;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.startsWith("{")) this.message(line);
    }
    if (this.buffer.length > MAX_LINE) void this.close().catch(() => {});
  }

  private message(line: string): void {
    let message: ZcodeRecord;
    try {
      message = asZcodeRecord(JSON.parse(line));
    } catch {
      return;
    }
    if (typeof message.method === "string") {
      const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined;
      this.inbound(message.method, asZcodeRecord(message.params), id);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.complete(message.id);
    if (!pending) return;
    if (message.error) {
      const error = asZcodeRecord(message.error);
      pending.reject(
        new ZcodeProtocolError(
          typeof error.code === "number" ? error.code : undefined,
          asZcodeString(error.message) || "ZCode 请求失败",
        ),
      );
    } else {
      pending.resolve(asZcodeRecord(message.result));
    }
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
    for (const id of this.pending.keys()) this.complete(id)?.reject(new ZcodeProtocolError(undefined, message));
    this.disconnected();
  }
}

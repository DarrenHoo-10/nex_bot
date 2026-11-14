import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FrameDecoder,
  FrameKind,
  decodeCredit,
  decodeResize,
  encodeClose,
  encodeFrame,
  encodeJsonFrame,
} from "./hc-frames.ts";
import {
  HC_REQUIRED_METHODS,
  HC_SOCKET_MAX_BYTES,
  HcError,
  HerdrCore,
  hcEnvironment,
  hcSocketPath,
  herdrCoreExecutableName,
  locateHerdrCore,
  type HcAttachStream,
  type HcEvent,
  type HcSnapshot,
  type HcState,
} from "./hc.ts";

// ---------------------------------------------------------------------------
// A fake herdr-core: plain-line hello, then framed JSON-RPC on channel 0.

class Reply {
  constructor(
    readonly result: unknown,
    readonly after?: () => void,
  ) {}
}

class RpcFailure {
  constructor(
    readonly kind: string,
    readonly message: string,
    readonly hint = "",
  ) {}
}

interface Conn {
  socket: net.Socket;
  decoder: FrameDecoder;
  buffer: Buffer;
  framed: boolean;
  streams: Map<number, { observe: boolean }>;
  eventChannel: number | null;
}

type Handler = (params: Record<string, unknown>, conn: Conn) => unknown | Promise<unknown>;

class FakeCore {
  server = net.createServer((socket) => this.accept(socket));
  conns = new Set<Conn>();
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  inputs: Array<{ channel: number; kind: number; text: string }> = [];
  credits: Array<{ channel: number; bytes: number }> = [];
  resizes: Array<{ channel: number; cols: number; rows: number }> = [];
  closes: number[] = [];
  hello: Record<string, unknown> = {
    version: "0.1.21",
    generation: 1,
    methods: [...HC_REQUIRED_METHODS, "machine.list", "server.stop"],
    features: ["resize_notifications"],
    framed: true,
    core: { id: "fake" },
  };
  nextChannel = 10;
  handlers = new Map<string, Handler>();
  helloParams: Record<string, unknown> | null = null;

  constructor(readonly endpoint: string) {
    this.handlers.set("terminal.run", (params) => terminalRecord(params));
    this.handlers.set("terminal.list", () => ({ terminals: [terminalRecord({ name: "one" })], hidden_finished: 0, machines: [] }));
    this.handlers.set("terminal.get", (params) => {
      if (params.terminal === "missing") throw new RpcFailure("not_found", "no such terminal", "run terminal.list");
      return terminalRecord({ name: String(params.terminal) });
    });
    this.handlers.set("terminal.send", () => ({ turn: 1, started: null, status: null }));
    this.handlers.set("terminal.keys", () => ({ turn: 2 }));
    this.handlers.set("terminal.interrupt", () => ({ outcome: "interrupted", key: "ctrl+c" }));
    this.handlers.set("terminal.read", () => ({ text: "screen", complete: true, how: "screen" }));
    this.handlers.set("terminal.attach", (params, conn) => {
      if (params.terminal === "missing") throw new RpcFailure("not_found", "no such terminal");
      const channel = this.nextChannel++;
      conn.streams.set(channel, { observe: params.observe === true });
      return new Reply(
        {
          channel,
          terminal: terminalRecord({ name: String(params.terminal) }),
          resize_notifications: params.resize_notifications === true,
          automatic_input: false,
        },
        // Sent in the same socket write as the reply: the client must have
        // registered the channel before it reads the first paint.
        () => undefined,
      );
    });
    this.handlers.set("events.subscribe", (_params, conn) => {
      const channel = this.nextChannel++;
      conn.eventChannel = channel;
      return { seq: 5, terminals: [terminalRecord({ name: "one" })], channel };
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.endpoint, () => resolve());
    });
  }

  async stop(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  dropAll(): void {
    for (const conn of this.conns) conn.socket.destroy();
    this.conns.clear();
  }

  private accept(socket: net.Socket): void {
    const conn: Conn = { socket, decoder: new FrameDecoder(), buffer: Buffer.alloc(0), framed: false, streams: new Map(), eventChannel: null };
    this.conns.add(conn);
    socket.on("error", () => {});
    socket.on("close", () => this.conns.delete(conn));
    socket.on("data", (chunk: Buffer) => {
      if (!conn.framed) {
        conn.buffer = Buffer.concat([conn.buffer, chunk]);
        const newline = conn.buffer.indexOf(0x0a);
        if (newline < 0) return;
        const request = JSON.parse(conn.buffer.subarray(0, newline).toString("utf8"));
        this.helloParams = request.params;
        const rest = conn.buffer.subarray(newline + 1);
        conn.buffer = Buffer.alloc(0);
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: this.hello })}\n`);
        conn.framed = true;
        if (rest.length > 0) this.frames(conn, rest);
        return;
      }
      this.frames(conn, chunk);
    });
  }

  private frames(conn: Conn, chunk: Buffer): void {
    for (const frame of conn.decoder.push(chunk)) {
      if (frame.channel === 0) {
        void this.rpc(conn, JSON.parse(frame.payload.toString("utf8")));
        continue;
      }
      if (frame.kind === FrameKind.CREDIT) {
        this.credits.push({ channel: frame.channel, bytes: decodeCredit(frame.payload) });
      } else if (frame.kind === FrameKind.RESIZE) {
        this.resizes.push({ channel: frame.channel, ...decodeResize(frame.payload) });
      } else if (frame.kind === FrameKind.CLOSE) {
        this.closes.push(frame.channel);
        conn.streams.delete(frame.channel);
        conn.socket.write(encodeClose(frame.channel));
      } else if (frame.kind === FrameKind.DATA || frame.kind === FrameKind.AUTOMATIC_INPUT) {
        const text = frame.payload.toString("utf8");
        this.inputs.push({ channel: frame.channel, kind: frame.kind, text });
        if (conn.streams.get(frame.channel)?.observe === false) {
          conn.socket.write(encodeFrame(frame.channel, FrameKind.DATA, `echo:${text}`));
        }
      }
    }
  }

  private async rpc(conn: Conn, request: { id: number; method: string; params: Record<string, unknown> }): Promise<void> {
    this.calls.push({ method: request.method, params: request.params });
    const handler = this.handlers.get(request.method);
    if (!handler) {
      conn.socket.write(
        encodeJsonFrame(0, { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found", data: { kind: "invalid_params" } } }),
      );
      return;
    }
    try {
      const out = await handler(request.params, conn);
      if (out === HANG) return;
      const reply = out instanceof Reply ? out : new Reply(out);
      let wire = encodeJsonFrame(0, { jsonrpc: "2.0", id: request.id, result: reply.result });
      const result = reply.result as { channel?: number };
      if (request.method === "terminal.attach" && typeof result.channel === "number") {
        wire = Buffer.concat([wire, encodeFrame(result.channel, FrameKind.DATA, "\x1b[?9001hPAINT")]);
      }
      conn.socket.write(wire);
      reply.after?.();
    } catch (error) {
      if (error instanceof RpcFailure) {
        conn.socket.write(
          encodeJsonFrame(0, {
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32000, message: error.message, data: { kind: error.kind, hint: error.hint } },
          }),
        );
        return;
      }
      throw error;
    }
  }

  pushEventText(conn: Conn, text: string, split?: number): void {
    const channel = conn.eventChannel;
    if (channel === null) throw new Error("no event channel");
    const bytes = Buffer.from(text, "utf8");
    if (split === undefined) {
      conn.socket.write(encodeFrame(channel, FrameKind.DATA, bytes));
    } else {
      conn.socket.write(encodeFrame(channel, FrameKind.DATA, bytes.subarray(0, split)));
      conn.socket.write(encodeFrame(channel, FrameKind.DATA, bytes.subarray(split)));
    }
  }

  pushNotification(conn: Conn, method: string, params: Record<string, unknown>, split?: number): void {
    this.pushEventText(conn, `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, split);
  }

  get current(): Conn {
    const conn = [...this.conns].at(-1);
    if (!conn) throw new Error("no client connected");
    return conn;
  }

  streamChannel(): number {
    for (const conn of this.conns) for (const channel of conn.streams.keys()) return channel;
    throw new Error("no attach stream");
  }
}

const HANG = Symbol("hang");

function terminalRecord(params: Record<string, unknown>): Record<string, unknown> {
  return {
    address: `t-${String(params.name ?? "x")}`,
    name: params.name ?? null,
    state: "running",
    argv: params.argv ?? ["fake"],
    cwd: params.cwd ?? "/",
    cols: 80,
    rows: 24,
    pid: 123,
    labels: params.labels ?? {},
    exit_code: null,
    reason: null,
    created_ms: 1,
    finished_ms: null,
  };
}

// ---------------------------------------------------------------------------

function endpointFor(name: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

async function waitFor<T>(read: () => T | undefined | false, ms = 3000, what = "condition"): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let fake: FakeCore;
let root: string;
const clients: HerdrCore[] = [];

function client(overrides: Partial<ConstructorParameters<typeof HerdrCore>[0]> = {}): HerdrCore {
  const core = new HerdrCore({
    binary: process.execPath,
    session: "nexbot-test",
    socket: fake.endpoint,
    startTimeoutMs: 1500,
    connectIntervalMs: 10,
    requestTimeoutMs: 2000,
    backoff: { minMs: 20, maxMs: 80 },
    startArgs: ["-e", ""],
    ...overrides,
  });
  clients.push(core);
  return core;
}

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "nexbot-hc-"));
  fake = new FakeCore(endpointFor(`nexbot-hctest-${randomUUID().slice(0, 8)}`));
  await fake.listen();
});

afterEach(async () => {
  for (const core of clients.splice(0)) core.close();
  await fake.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("locating herdr-core", () => {
  const exe = herdrCoreExecutableName();
  const touch = (file: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "");
    return file;
  };

  it("prefers NEX_HERDR_CORE_PATH, then the packaged folder, then dist-native", () => {
    const moduleUrl = pathToFileURL(path.join(root, "app", "client-node", "hc.js")).href;
    const dev = touch(path.join(root, "dist-native", "herdr-core", `${process.platform}-${process.arch}`, exe));
    expect(locateHerdrCore({ env: {}, moduleUrl })).toBe(dev);

    const packaged = touch(path.join(root, "app", "herdr-core", exe));
    expect(locateHerdrCore({ env: {}, moduleUrl })).toBe(packaged);

    const override = touch(path.join(root, "custom", exe));
    expect(locateHerdrCore({ env: { NEX_HERDR_CORE_PATH: override }, moduleUrl })).toBe(override);
    // A stale override falls through rather than failing the lookup.
    expect(locateHerdrCore({ env: { NEX_HERDR_CORE_PATH: path.join(root, "gone") }, moduleUrl })).toBe(packaged);
  });

  it("returns null when it is nowhere", () => {
    const moduleUrl = pathToFileURL(path.join(root, "a", "b", "hc.js")).href;
    expect(locateHerdrCore({ env: {}, moduleUrl, platform: "linux", arch: "x64" })).toBeNull();
  });

  it("uses the platform-specific name and folder", () => {
    expect(herdrCoreExecutableName("win32")).toBe("herdr-core.exe");
    expect(herdrCoreExecutableName("darwin")).toBe("herdr-core");
    const moduleUrl = pathToFileURL(path.join(root, "a", "hc.js")).href;
    const mac = touch(path.join(root, "dist-native", "herdr-core", "darwin-arm64", "herdr-core"));
    expect(locateHerdrCore({ env: {}, moduleUrl, platform: "darwin", arch: "arm64" })).toBe(mac);
  });
});

describe("environment", () => {
  it("selects the session and socket and leaves XDG variables alone", () => {
    const env = hcEnvironment(
      { session: "s1", socket: "sock" },
      { XDG_STATE_HOME: "/x/state", XDG_CONFIG_HOME: "/x/config", HC_SESSION: "old", PATH: "p" },
    );
    expect(env).toMatchObject({ HC_SESSION: "s1", HC_SOCKET: "sock", XDG_STATE_HOME: "/x/state", XDG_CONFIG_HOME: "/x/config", PATH: "p" });
  });

  it("hands the injected base environment (the user's login shell variables) to the core and its terminals", () => {
    const login = { PATH: "/opt/homebrew/bin:/usr/bin", HTTPS_PROXY: "http://127.0.0.1:7890", ANTHROPIC_BASE_URL: "https://gw.example" };
    const env = hcEnvironment({ session: "s1", socket: "/tmp/a.sock" }, { ...login, HC_SESSION: "old" });
    expect(env).toMatchObject({ ...login, HC_SESSION: "s1", HC_SOCKET: "/tmp/a.sock" });
  });

  it("starts the core with the injected environment", async () => {
    await fake.stop();
    const marker = path.join(root, "env.txt");
    const script = path.join(root, "env.mjs");
    writeFileSync(script, 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], process.env.NEX_LOGIN_MARK ?? "missing");\n');
    const core = client({ startArgs: [script, marker], startTimeoutMs: 1500, env: { ...process.env, NEX_LOGIN_MARK: "from-login-shell" } });
    await core.ensureStarted().catch(() => undefined);
    await waitFor(() => existsSync(marker), 4000, "start command");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8")).toBe("from-login-shell");
  });
});

describe("socket path", () => {
  const hash = "1a2b3c4d";
  it("is a named pipe on Windows", () => {
    expect(hcSocketPath({ hash, dataDir: "C:\\Users\\me\\AppData\\Roaming\\nexbot", platform: "win32" })).toBe("\\\\.\\pipe\\nexbot-hc-1a2b3c4d");
  });

  it("lives in the data directory on macOS when that fits a Unix socket", () => {
    expect(hcSocketPath({ hash, dataDir: "/Users/me/nex", platform: "darwin", tmpdir: "/var/folders/x/T" })).toBe("/Users/me/nex/hc/1a2b3c4d.sock");
  });

  it("falls back to the per-user temp directory when the path is too long", () => {
    const dataDir = "/Users/someone/Library/Application Support/com.nexorai.nexbot/executor/device/0123456789abcdef";
    const socket = hcSocketPath({ hash, dataDir, platform: "darwin", tmpdir: "/var/folders/ab/cdefg_hijk/T" });
    expect(socket).toBe("/var/folders/ab/cdefg_hijk/T/nexbot-hc-1a2b3c4d.sock");
    expect(Buffer.byteLength(socket)).toBeLessThan(HC_SOCKET_MAX_BYTES);
  });
});

describe("handshake and calls", () => {
  it("sends hello with framed mode, generation 1 and resize notifications", async () => {
    const core = client();
    await core.ensureStarted();
    expect(fake.helloParams).toEqual({ framed: true, generation: 1, features: ["resize_notifications"] });
    expect(core.state()).toMatchObject({ status: "ready", attempt: 0 });
    expect(core.state().hello?.version).toBe("0.1.21");
  });

  it("maps the wrapper methods onto the JSON-RPC calls", async () => {
    const core = client();
    const terminal = await core.run({ argv: ["fake"], cwd: "/w", name: "n1", labels: { nexbot: "1" }, size: { cols: 100, rows: 30 } });
    expect(terminal.name).toBe("n1");
    await core.list({ labels: { nexbot: "1" } });
    await core.get("n1");
    await core.send({ terminal: "n1", text: "hi" });
    await core.keys("n1", ["ctrl+c"]);
    await core.interrupt("n1", { timeout: 3 });
    await core.read("n1", { lines: 20 });
    expect(fake.calls.map((call) => call.method)).toEqual([
      "terminal.run",
      "terminal.list",
      "terminal.get",
      "terminal.send",
      "terminal.keys",
      "terminal.interrupt",
      "terminal.read",
    ]);
    expect(fake.calls[0].params).toMatchObject({ argv: ["fake"], cwd: "/w", labels: { nexbot: "1" }, size: { cols: 100, rows: 30 } });
    expect(fake.calls[5].params).toEqual({ terminal: "n1", timeout: 3 });
    expect(fake.calls[4].params).toEqual({ terminal: "n1", keys: ["ctrl+c"] });
  });

  it("refuses methods that Agent mode must never use, without sending them", async () => {
    const core = client();
    for (const method of ["server.stop", "machine.list", "file.read", "templates.list", "doc.set", "hello"]) {
      await expect(core.call(method)).rejects.toMatchObject({ kind: "hc_forbidden" });
    }
    expect(fake.calls).toEqual([]);
    expect(fake.conns.size).toBe(0);
  });

  it("surfaces core errors with kind, hint and code", async () => {
    const core = client();
    const error = await core.get("missing").catch((caught) => caught);
    expect(error).toBeInstanceOf(HcError);
    expect(error).toMatchObject({ kind: "not_found", hint: "run terminal.list", code: -32000, message: "no such terminal" });
  });

  it("answers concurrent calls out of order", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    fake.handlers.set("terminal.read", async () => {
      await gate;
      return { text: "slow", complete: true, how: "screen" };
    });
    const core = client();
    const slow = core.read("a");
    const fast = await core.get("b");
    expect(fast.name).toBe("b");
    release();
    expect((await slow).text).toBe("slow");
  });

  it("times out a call the core never answers", async () => {
    fake.handlers.set("terminal.read", () => HANG);
    const core = client({ requestTimeoutMs: 80 });
    await expect(core.read("a")).rejects.toMatchObject({ kind: "hc_timeout" });
    // The connection is still usable afterwards.
    await expect(core.get("b")).resolves.toMatchObject({ name: "b" });
  });

  it("reports an incompatible version once and does not retry", async () => {
    fake.hello = { ...fake.hello, version: "0.2.0" };
    const core = client();
    await expect(core.ensureStarted()).rejects.toMatchObject({ kind: "hc_version" });
    expect(core.state()).toMatchObject({ status: "incompatible", lastError: { kind: "hc_version" } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(core.state().status).toBe("incompatible");
  });

  it("rejects a core that lacks a required method or another generation", async () => {
    fake.hello = { ...fake.hello, methods: ["terminal.run"] };
    await expect(client().ensureStarted()).rejects.toMatchObject({ kind: "hc_version", message: expect.stringContaining("terminal.attach") });
    fake.hello = { ...fake.hello, methods: [...HC_REQUIRED_METHODS], generation: 2 };
    await expect(client().ensureStarted()).rejects.toMatchObject({ kind: "hc_version" });
  });
});

describe("attach streams", () => {
  it("delivers the first paint that follows the reply in the same chunk", async () => {
    const core = client();
    const stream = await core.attach({ terminal: "n1", cols: 90, rows: 30 }, { autoAck: false });
    const chunks: string[] = [];
    stream.on("data", (data) => chunks.push(data.toString()));
    await waitFor(() => chunks.length === 1, 2000, "first paint");
    expect(chunks[0]).toBe("[?9001hPAINT");
    expect(fake.calls[0]).toMatchObject({ method: "terminal.attach", params: { terminal: "n1", cols: 90, rows: 30, observe: false, history: 0 } });
    expect(stream.channel).toBeGreaterThanOrEqual(10);
    expect(stream.terminal.name).toBe("n1");
  });

  it("sends input, receives output, acknowledges credit and detaches", async () => {
    const core = client();
    const stream = await attachWithPaint(core, "n1");
    const received = stream.chunks;
    stream.stream.write("hello");
    await waitFor(() => received.some((text) => text.includes("echo:hello")), 2000, "echo");
    expect(fake.inputs).toEqual([{ channel: stream.stream.channel, kind: FrameKind.DATA, text: "hello" }]);
    // autoAck returned credit for the paint and the echo.
    await waitFor(() => fake.credits.reduce((sum, credit) => sum + credit.bytes, 0) >= "echo:hello".length, 2000, "credit");
    expect(fake.credits.every((credit) => credit.channel === stream.stream.channel)).toBe(true);

    const closed = new Promise<{ reason: string }>((resolve) => stream.stream.once("close", resolve));
    stream.stream.close();
    expect(await closed).toEqual({ reason: "detached" });
    await waitFor(() => fake.closes.includes(stream.stream.channel), 2000, "close frame");
    expect(() => stream.stream.write("x")).toThrow(HcError);
    // The core is still connected; only the stream ended.
    await expect(core.get("n1")).resolves.toBeTruthy();
  });

  it("holds back credit until the owner acknowledges when autoAck is off", async () => {
    const core = client();
    const attached = await attachWithPaint(core, "n1", { autoAck: false });
    await waitFor(() => attached.chunks.length > 0, 2000, "first paint");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fake.credits).toEqual([]);
    const size = Buffer.byteLength(attached.chunks.join(""));
    attached.stream.ack(size);
    await waitFor(() => fake.credits.length === 1, 2000, "ack");
    expect(fake.credits[0]).toEqual({ channel: attached.stream.channel, bytes: size });
  });

  it("sends resize and focus, and splits large writes into 64 KiB frames", async () => {
    const core = client();
    const { stream } = await attachWithPaint(core, "n1");
    stream.resize(132, 43);
    await waitFor(() => fake.resizes.length === 1, 2000, "resize");
    expect(fake.resizes[0]).toEqual({ channel: stream.channel, cols: 132, rows: 43 });
    stream.write("a".repeat(150_000));
    await waitFor(() => fake.inputs.reduce((sum, input) => sum + input.text.length, 0) === 150_000, 2000, "large input");
    expect(fake.inputs.map((input) => input.text.length)).toEqual([65536, 65536, 18928]);
  });

  it("makes an observing stream read-only", async () => {
    const core = client();
    const stream = await core.attach({ terminal: "n1", cols: 80, rows: 24, observe: true });
    expect(stream.observe).toBe(true);
    expect(() => stream.write("x")).toThrow(/observing/);
    expect(() => stream.resize(1, 1)).toThrow(/observing/);
    expect(fake.calls[0].params).toMatchObject({ observe: true });
  });

  it("passes resize notifications and the core's close reason through", async () => {
    const core = client();
    const stream = await core.attach({ terminal: "n1", cols: 80, rows: 24, resizeNotifications: true });
    expect(stream.resizeNotifications).toBe(true);
    const resizes: Array<{ cols: number; rows: number }> = [];
    stream.on("resize", (size) => resizes.push(size));
    const closed = new Promise<unknown>((resolve) => stream.once("close", resolve));
    const channel = stream.channel;
    const sizePayload = Buffer.alloc(4);
    sizePayload.writeUInt16LE(100, 0);
    sizePayload.writeUInt16LE(50, 2);
    fake.current.socket.write(encodeFrame(channel, FrameKind.RESIZE, sizePayload));
    fake.current.socket.write(encodeFrame(channel, FrameKind.CLOSE, JSON.stringify({ reason: "exited", exit_code: 0, signal: null })));
    expect(await closed).toEqual({ reason: "exited", exitCode: 0, signal: null });
    expect(resizes).toEqual([{ cols: 100, rows: 50 }]);
    expect(stream.closed).toBe(true);
  });

  it("rejects an attach to a missing terminal with the core's kind", async () => {
    const core = client();
    await expect(core.attach({ terminal: "missing", cols: 80, rows: 24 })).rejects.toMatchObject({ kind: "not_found" });
  });

  it("only uses AUTOMATIC_INPUT when hello and attach both negotiated it", async () => {
    const core = client();
    const { stream } = await attachWithPaint(core, "n1");
    expect(stream.automaticInput).toBe(false);
    stream.write("\x1b[1;1R", { automatic: true });
    await waitFor(() => fake.inputs.length === 1, 2000, "input");
    expect(fake.inputs[0].kind).toBe(FrameKind.DATA);
  });
});

async function attachWithPaint(
  core: HerdrCore,
  terminal: string,
  options: { autoAck?: boolean } = {},
): Promise<{ stream: HcAttachStream; chunks: string[] }> {
  const stream = await core.attach({ terminal, cols: 80, rows: 24 }, options);
  const chunks: string[] = [];
  stream.on("data", (data) => chunks.push(data.toString()));
  // The first paint shared a socket chunk with the attach reply.
  await waitFor(() => chunks.some((text) => text.includes("PAINT")), 2000, "first paint");
  return { stream, chunks };
}

describe("events", () => {
  it("returns a snapshot, emits events across split frames and returns credit", async () => {
    const core = client();
    const events: HcEvent[] = [];
    core.on("event", (event) => events.push(event));
    const snapshot = await core.subscribe({ labels: { nexbot: "1" } });
    expect(snapshot).toMatchObject({ seq: 5, resync: false });
    expect(snapshot.terminals).toHaveLength(1);
    expect(fake.calls.at(-1)).toEqual({ method: "events.subscribe", params: { labels: { nexbot: "1" } } });

    const conn = fake.current;
    fake.pushNotification(conn, "event", { seq: 6, type: "status", terminal: "t-one", data: { state: "working" } });
    fake.pushNotification(conn, "event", { seq: 7, type: "turn", terminal: "t-one", data: { turn: 3 } }, 20);
    fake.pushNotification(conn, "heartbeat", {});
    await waitFor(() => events.length === 2, 2000, "two events");
    expect(events.map((event) => [event.seq, event.type, event.terminal])).toEqual([
      [6, "status", "t-one"],
      [7, "turn", "t-one"],
    ]);
    expect(events[1].data).toEqual({ turn: 3 });
    await waitFor(() => fake.credits.length >= 4, 2000, "event credit");
    expect(fake.credits.every((credit) => credit.channel === conn.eventChannel)).toBe(true);
  });

  it("emits a resync snapshot when the core reports missed events", async () => {
    const core = client();
    const snapshots: HcSnapshot[] = [];
    core.on("snapshot", (snapshot) => snapshots.push(snapshot));
    await core.subscribe();
    fake.pushNotification(fake.current, "missed", { seq: 40, terminals: [{ address: "t-x" }] });
    await waitFor(() => snapshots.length === 2, 2000, "missed snapshot");
    expect(snapshots[1]).toMatchObject({ seq: 40, resync: true });
  });
});

describe("disconnect and reconnect", () => {
  it("closes streams, fails pending calls, reconnects with backoff and re-subscribes", async () => {
    const core = client();
    const states: HcState[] = [];
    core.on("state", (state) => states.push(state));
    const snapshots: HcSnapshot[] = [];
    core.on("snapshot", (snapshot) => snapshots.push(snapshot));
    await core.subscribe({ labels: { nexbot: "1" } });
    const stream = await core.attach({ terminal: "n1", cols: 80, rows: 24 });
    const closed = new Promise<unknown>((resolve) => stream.once("close", resolve));

    fake.handlers.set("terminal.read", () => HANG);
    const pending = core.read("n1").catch((error) => error);
    await waitFor(() => fake.calls.some((call) => call.method === "terminal.read"), 2000, "read call");

    fake.dropAll();
    expect(await pending).toMatchObject({ kind: "hc_disconnected" });
    expect(await closed).toEqual({ reason: "hc_disconnected" });

    await waitFor(() => states.some((state) => state.status === "reconnecting"), 2000, "reconnecting");
    await waitFor(() => core.state().status === "ready", 4000, "ready again");
    await waitFor(() => snapshots.length === 2, 2000, "re-subscribe snapshot");
    expect(snapshots[1]).toMatchObject({ resync: true, seq: 5 });
    expect(fake.calls.filter((call) => call.method === "events.subscribe")).toHaveLength(2);
    // New calls work, and the old terminal is addressed the same way.
    await expect(core.get("n1")).resolves.toMatchObject({ name: "n1" });
    expect(core.state().attempt).toBe(0);
  });

  it("calls made while disconnected start a fresh connection", async () => {
    const core = client({ reconnect: false });
    await core.ensureStarted();
    fake.dropAll();
    await waitFor(() => core.state().status !== "ready", 2000, "disconnected");
    await expect(core.get("again")).resolves.toMatchObject({ name: "again" });
  });

  it("stops reconnecting after close() and leaves the core alone", async () => {
    const core = client();
    await core.ensureStarted();
    core.close();
    expect(core.state().status).toBe("closed");
    await expect(core.ensureStarted()).rejects.toMatchObject({ kind: "hc_closed" });
    fake.dropAll();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fake.conns.size).toBe(0);
    expect(fake.calls.map((call) => call.method)).not.toContain("server.stop");
  });

  it("backs off exponentially between 1x and the cap while the core is unavailable", async () => {
    await fake.stop();
    const core = client({
      binary: path.join(root, "does-not-exist"),
      startTimeoutMs: 40,
      connectIntervalMs: 5,
      backoff: { minMs: 20, maxMs: 80 },
    });
    const delays: number[] = [];
    core.on("state", (state) => {
      if (state.status === "unavailable" && state.nextRetryMs !== undefined) delays.push(state.nextRetryMs);
    });
    await expect(core.ensureStarted()).rejects.toMatchObject({ kind: "hc_unavailable" });
    await waitFor(() => new Set(delays).size >= 3 && delays.length >= 4, 5000, "four retries");
    expect(delays[0]).toBe(20);
    expect(delays.slice(0, 4)).toEqual([20, 40, 80, 80]);
    expect(core.state().attempt).toBeGreaterThanOrEqual(3);
    // Restore the listener so afterEach can close it.
    fake = new FakeCore(fake.endpoint);
    await fake.listen();
  });
});

describe("starting the core", () => {
  it("runs the start command detached when nothing answers, then connects", async () => {
    await fake.stop();
    const marker = path.join(root, "started.txt");
    const script = path.join(root, "start.mjs");
    writeFileSync(
      script,
      'import { appendFileSync } from "node:fs";\nappendFileSync(process.argv[2], `${process.env.HC_SESSION}|${process.env.HC_SOCKET}\\n`);\n',
    );
    const core = client({ startArgs: [script, marker], startTimeoutMs: 5000 });
    const ready = core.ensureStarted();
    await waitFor(() => existsSync(marker), 4000, "start command");
    fake = new FakeCore(fake.endpoint);
    await fake.listen();
    await ready;
    expect(core.state().status).toBe("ready");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual([`nexbot-test|${fake.endpoint}`]);
  });

  it("does not start anything when the core already answers", async () => {
    const marker = path.join(root, "never.txt");
    const script = path.join(root, "start.mjs");
    writeFileSync(script, 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], "x");\n');
    const core = client({ startArgs: [script, marker] });
    await core.ensureStarted();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(existsSync(marker)).toBe(false);
  });

  it("shares one connection between concurrent callers", async () => {
    const core = client();
    await Promise.all([core.ensureStarted(), core.ensureStarted(), core.get("a"), core.get("b")]);
    expect(fake.conns.size).toBe(1);
  });
});

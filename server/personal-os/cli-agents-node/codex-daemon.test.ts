// The Codex daemon client against a fake JSON-RPC peer. No real daemon, proxy or Codex
// process is involved: the connector hands back an in-memory peer that plays the server.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceCliMessage } from "../../../shared/cli-agents.ts";
import { CodexDaemons, DaemonError, proxyConnector, type DaemonPeer } from "./codex-daemon.ts";

const THREAD = "019a1b2c-0000-7000-8000-000000000001";
const OTHER = "019a1b2c-0000-7000-8000-000000000002";
const HOME = "/home/user/.codex";

type Rec = Record<string, unknown>;

class FakeServer {
  readonly received: Rec[] = [];
  readonly events = new EventEmitter();
  loaded: string[] = [THREAD];
  pages = false;
  latestTurn: Rec | null = null;
  failMethods = new Set<string>();
  silentMethods = new Set<string>();
  private lineListener: (line: string) => void = () => {};
  private closeListener: () => void = () => {};
  closed = false;

  readonly peer: DaemonPeer = {
    send: (line) => {
      if (this.closed) return false;
      const message = JSON.parse(line) as Rec;
      this.received.push(message);
      queueMicrotask(() => this.handle(message));
      return true;
    },
    close: () => {
      this.drop();
    },
    onLine: (listener) => {
      this.lineListener = listener;
    },
    onClose: (listener) => {
      this.closeListener = listener;
    },
  };

  drop(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeListener();
  }

  push(message: Rec): void {
    this.lineListener(JSON.stringify(message));
  }

  methods(): string[] {
    return this.received.filter((m) => typeof m.method === "string").map((m) => m.method as string);
  }

  find(method: string): Rec | undefined {
    return this.received.find((m) => m.method === method);
  }

  private reply(id: unknown, result: Rec): void {
    this.push({ id, result });
  }

  private handle(message: Rec): void {
    const method = message.method as string | undefined;
    const id = message.id;
    if (method === undefined || id === undefined) return;
    if (this.silentMethods.has(method)) return;
    if (this.failMethods.has(method)) {
      this.push({ id, error: { code: -32600, message: `${method} refused` } });
      return;
    }
    const params = (message.params ?? {}) as Rec;
    switch (method) {
      case "initialize":
        this.reply(id, { userAgent: "fake" });
        break;
      case "thread/loaded/list":
        if (this.pages && !params.cursor) this.reply(id, { data: this.loaded.slice(0, 1), nextCursor: "c2" });
        else if (this.pages) this.reply(id, { data: this.loaded.slice(1), nextCursor: null });
        else this.reply(id, { data: this.loaded, nextCursor: null });
        break;
      case "thread/resume":
        this.reply(id, { thread: { id: params.threadId } });
        break;
      case "thread/turns/list":
        this.reply(id, { data: this.latestTurn ? [this.latestTurn] : [], nextCursor: null, backwardsCursor: null });
        break;
      case "turn/start":
        this.reply(id, { turn: { id: "turn-new", status: "inProgress" } });
        break;
      case "turn/steer":
        this.reply(id, { turnId: params.expectedTurnId });
        break;
      default:
        this.push({ id, error: { code: -32601, message: "unknown method" } });
    }
  }
}

function setup(configure?: (server: FakeServer) => void, extra: Partial<ConstructorParameters<typeof CodexDaemons>[0]> = {}) {
  const server = new FakeServer();
  configure?.(server);
  const emitted: DeviceCliMessage[] = [];
  const connect = vi.fn(async () => server.peer);
  const lost: string[] = [];
  const daemons = new CodexDaemons({
    connect,
    detect: async () => true,
    emit: (message) => {
      emitted.push(message);
      return true;
    },
    onLost: (home) => lost.push(home),
    retryMs: 60_000,
    listEveryMs: 0,
    rpcTimeoutMs: 400,
    ...extra,
  });
  return { server, emitted, connect, lost, daemons };
}

const open: CodexDaemons[] = [];
afterEach(() => {
  for (const daemons of open.splice(0)) daemons.close();
  vi.useRealTimers();
});

function track<T extends { daemons: CodexDaemons }>(value: T): T {
  open.push(value.daemons);
  return value;
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("joining the daemon", () => {
  it("initializes, sends the initialized notification and lists the loaded threads", async () => {
    const { server, daemons, connect } = track(setup());
    expect(daemons.threads(HOME)).toBeUndefined();
    await daemons.refresh(HOME);
    expect(connect).toHaveBeenCalledWith(HOME);
    expect(server.methods()).toEqual(["initialize", "initialized", "thread/loaded/list"]);
    const init = server.find("initialize")?.params as Rec;
    expect((init.clientInfo as Rec).name).toBe("nexbot");
    expect(server.received.every((m) => !("jsonrpc" in m))).toBe(true);
    expect([...(daemons.threads(HOME) ?? [])]).toEqual([THREAD]);
  });

  it("follows the pages of the thread list and ignores malformed ids", async () => {
    const { server, daemons } = track(
      setup((s) => {
        s.pages = true;
        s.loaded = [THREAD, OTHER, "../bad id"];
      }),
    );
    await daemons.refresh(HOME);
    expect([...(daemons.threads(HOME) ?? [])].sort()).toEqual([THREAD, OTHER].sort());
    expect(server.received.filter((m) => m.method === "thread/loaded/list")).toHaveLength(2);
  });

  it("reuses one connection across refreshes", async () => {
    const { daemons, connect, server } = track(setup());
    await daemons.refresh(HOME);
    await daemons.refresh(HOME);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(server.received.filter((m) => m.method === "thread/loaded/list")).toHaveLength(2);
  });

  it("does not connect when there is no control socket", async () => {
    const { daemons, connect } = track(setup(undefined, { detect: async () => false }));
    await daemons.refresh(HOME);
    expect(connect).not.toHaveBeenCalled();
    expect(daemons.threads(HOME)).toBeUndefined();
  });

  it("backs off after a failed connection instead of retrying every scan", async () => {
    let now = 1000;
    const connect = vi.fn(async () => {
      throw new DaemonError("stopped", "no daemon");
    });
    const daemons = new CodexDaemons({ connect, detect: async () => true, emit: () => true, retryMs: 10_000, now: () => now });
    open.push(daemons);
    await daemons.refresh(HOME);
    await daemons.refresh(HOME);
    expect(connect).toHaveBeenCalledTimes(1);
    now += 10_001;
    await daemons.refresh(HOME);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(daemons.threads(HOME)).toBeUndefined();
  });

  it("treats a refused initialize as no daemon", async () => {
    const { daemons, server } = track(setup((s) => s.failMethods.add("initialize")));
    await daemons.refresh(HOME);
    expect(daemons.threads(HOME)).toBeUndefined();
    expect(server.closed).toBe(true);
  });

  it("forgets the threads and reports the loss when the connection drops", async () => {
    const { daemons, server, lost } = track(setup());
    await daemons.refresh(HOME);
    server.drop();
    expect(daemons.threads(HOME)).toBeUndefined();
    expect(lost).toEqual([HOME]);
  });

  it("closing the pool ends the proxy connection only", async () => {
    const { daemons, server } = track(setup());
    await daemons.refresh(HOME);
    daemons.close();
    expect(server.closed).toBe(true);
    expect(server.methods()).not.toContain("thread/archive");
  });
});

describe("sending through the daemon", () => {
  it("resumes the thread without turns and starts a turn when none is running", async () => {
    const { daemons, server } = track(setup());
    await daemons.refresh(HOME);
    const result = await daemons.send(HOME, THREAD, "hello");
    expect(result).toEqual({ steered: false });
    const resume = server.find("thread/resume")?.params as Rec;
    expect(resume).toEqual({ threadId: THREAD, excludeTurns: true });
    const start = server.find("turn/start")?.params as Rec;
    expect(start.threadId).toBe(THREAD);
    expect(start.input).toEqual([{ type: "text", text: "hello", text_elements: [] }]);
    expect(server.find("turn/steer")).toBeUndefined();
  });

  it("joins a thread only once", async () => {
    const { daemons, server } = track(setup());
    await daemons.send(HOME, THREAD, "one");
    server.push({ method: "turn/completed", params: { threadId: THREAD, turn: { id: "turn-new", status: "completed" } } });
    await daemons.send(HOME, THREAD, "two");
    expect(server.received.filter((m) => m.method === "thread/resume")).toHaveLength(1);
    expect(server.received.filter((m) => m.method === "turn/start")).toHaveLength(2);
  });

  it("steers the turn that is in progress when the thread is joined", async () => {
    const { daemons, server } = track(setup((s) => (s.latestTurn = { id: "turn-7", status: "inProgress" })));
    const result = await daemons.send(HOME, THREAD, "also this");
    expect(result).toEqual({ steered: true });
    const steer = server.find("turn/steer")?.params as Rec;
    expect(steer.expectedTurnId).toBe("turn-7");
    expect(steer.threadId).toBe(THREAD);
    expect(server.find("turn/start")).toBeUndefined();
  });

  it("tracks turn/started and turn/completed notifications", async () => {
    const { daemons, server } = track(setup());
    await daemons.refresh(HOME);
    await daemons.join(HOME, THREAD);
    server.push({ method: "turn/started", params: { threadId: THREAD, turn: { id: "turn-9", status: "inProgress" } } });
    await daemons.send(HOME, THREAD, "steer me");
    expect((server.find("turn/steer")?.params as Rec | undefined)?.expectedTurnId).toBe("turn-9");
    server.push({ method: "turn/completed", params: { threadId: THREAD, turn: { id: "turn-9", status: "completed" } } });
    await daemons.send(HOME, THREAD, "fresh");
    expect(server.find("turn/start")).toBeDefined();
  });

  it("starts a turn when steering fails because the turn ended meanwhile", async () => {
    const { daemons, server } = track(
      setup((s) => {
        s.latestTurn = { id: "turn-7", status: "inProgress" };
        s.failMethods.add("turn/steer");
      }),
    );
    const result = await daemons.send(HOME, THREAD, "late");
    expect(result).toEqual({ steered: false });
    expect(server.find("turn/start")).toBeDefined();
  });

  it("reports a refused start with the daemon's message", async () => {
    const { daemons } = track(setup((s) => s.failMethods.add("turn/start")));
    await expect(daemons.send(HOME, THREAD, "x")).rejects.toMatchObject({ name: "DaemonError", code: "unknown", message: expect.stringContaining("turn/start refused") });
  });

  it("times out a daemon that does not answer", async () => {
    const { daemons } = track(setup((s) => s.silentMethods.add("turn/start")));
    await expect(daemons.send(HOME, THREAD, "x")).rejects.toMatchObject({ code: "unknown" });
  });

  it("fails as stopped when the daemon is gone", async () => {
    const connect = vi.fn(async () => {
      throw new Error("ENOENT");
    });
    const daemons = new CodexDaemons({ connect, emit: () => true });
    open.push(daemons);
    await expect(daemons.send(HOME, THREAD, "x")).rejects.toMatchObject({ code: "stopped" });
  });
});

describe("approvals", () => {
  async function ready() {
    const context = track(setup());
    await context.daemons.refresh(HOME);
    return context;
  }

  function requests(emitted: DeviceCliMessage[]) {
    return emitted.filter((m): m is Extract<DeviceCliMessage, { type: "cli.request" }> => m.type === "cli.request");
  }

  it("maps a command approval to a cli.request and accepts it", async () => {
    const { server, emitted, daemons } = await ready();
    server.push({
      id: "srv-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: THREAD, turnId: "t", itemId: "i", command: "rm -rf build", cwd: "/work", reason: "clean" },
    });
    const [request] = requests(emitted);
    expect(request.kind).toBe("permission");
    expect(request.tool).toBe("shell");
    expect(request.summary).toBe("rm -rf build");
    expect(request.ref).toContain(THREAD);
    expect(request.expiresAt).toBeGreaterThan(Date.now());
    expect(daemons.owns(request.id)).toBe(true);
    expect(daemons.answer({ id: request.id, decision: "allow" })).toBe("ok");
    expect(server.received.at(-1)).toEqual({ id: "srv-1", result: { decision: "accept" } });
    expect(daemons.owns(request.id)).toBe(false);
    expect(emitted.some((m) => m.type === "cli.request.resolved")).toBe(false);
  });

  it("declines a file-change approval", async () => {
    const { server, emitted, daemons } = await ready();
    server.push({ id: 5, method: "item/fileChange/requestApproval", params: { threadId: THREAD, turnId: "t", itemId: "i", reason: "needs write", grantRoot: "/work" } });
    const [request] = requests(emitted);
    expect(request.tool).toBe("apply_patch");
    expect(request.summary).toBe("needs write");
    daemons.answer({ id: request.id, decision: "deny" });
    expect(server.received.at(-1)).toEqual({ id: 5, result: { decision: "decline" } });
  });

  it("grants the requested permissions, or none when denied", async () => {
    const { server, emitted, daemons } = await ready();
    const permissions = { fileSystem: { write: ["/work"] }, network: { enabled: true } };
    server.push({ id: "p1", method: "item/permissions/requestApproval", params: { threadId: THREAD, turnId: "t", itemId: "i", cwd: "/work", permissions, reason: "net" } });
    server.push({ id: "p2", method: "item/permissions/requestApproval", params: { threadId: THREAD, turnId: "t", itemId: "j", cwd: "/work", permissions } });
    const [first, second] = requests(emitted);
    expect(first.tool).toBe("permissions");
    expect(second.summary).toBe("/work");
    daemons.answer({ id: first.id, decision: "allow" });
    expect(server.received.at(-1)).toEqual({ id: "p1", result: { permissions, scope: "turn" } });
    daemons.answer({ id: second.id, decision: "deny" });
    expect(server.received.at(-1)).toEqual({ id: "p2", result: { permissions: {}, scope: "turn" } });
  });

  it("clips a long command and ignores other server requests", async () => {
    const { server, emitted } = await ready();
    server.push({ id: 1, method: "item/commandExecution/requestApproval", params: { threadId: THREAD, turnId: "t", itemId: "i", command: "x".repeat(5000) } });
    server.push({ id: 2, method: "item/tool/requestUserInput", params: { threadId: THREAD } });
    server.push({ id: 3, method: "item/fileChange/requestApproval", params: { turnId: "t" } });
    const found = requests(emitted);
    expect(found).toHaveLength(1);
    expect(found[0].summary.length).toBeLessThanOrEqual(1000);
  });

  it("closes the request as terminal when the daemon says another client resolved it", async () => {
    const { server, emitted, daemons } = await ready();
    server.push({ id: "srv-2", method: "item/commandExecution/requestApproval", params: { threadId: THREAD, turnId: "t", itemId: "i", command: "ls" } });
    const [request] = requests(emitted);
    server.push({ method: "serverRequest/resolved", params: { threadId: THREAD, requestId: "srv-2" } });
    expect(emitted.at(-1)).toEqual({ type: "cli.request.resolved", id: request.id, by: "terminal" });
    expect(() => daemons.answer({ id: request.id, decision: "allow" })).toThrowError(expect.objectContaining({ code: "not_found" }));
  });

  it("closes open requests as gone when the connection drops", async () => {
    const { server, emitted } = await ready();
    server.push({ id: "srv-3", method: "item/commandExecution/requestApproval", params: { threadId: THREAD, turnId: "t", itemId: "i", command: "ls" } });
    const [request] = requests(emitted);
    server.drop();
    expect(emitted.at(-1)).toEqual({ type: "cli.request.resolved", id: request.id, by: "gone" });
  });

  it("times a request out", async () => {
    vi.useFakeTimers();
    const context = track(setup(undefined, { ttlMs: 5000, listEveryMs: 1_000_000 }));
    const refreshing = context.daemons.refresh(HOME);
    await vi.advanceTimersByTimeAsync(10);
    await refreshing;
    context.server.push({ id: "srv-4", method: "item/commandExecution/requestApproval", params: { threadId: THREAD, turnId: "t", itemId: "i", command: "ls" } });
    const [request] = requests(context.emitted);
    await vi.advanceTimersByTimeAsync(5001);
    expect(context.emitted.at(-1)).toEqual({ type: "cli.request.resolved", id: request.id, by: "timeout" });
    expect(context.daemons.owns(request.id)).toBe(false);
  });

  it("announces open requests again after Core reconnects", async () => {
    const { server, emitted, daemons } = await ready();
    server.push({ id: "srv-5", method: "item/commandExecution/requestApproval", params: { threadId: THREAD, turnId: "t", itemId: "i", command: "ls" } });
    const before = requests(emitted).length;
    daemons.relink();
    const after = requests(emitted);
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)?.id).toBe(after[0].id);
  });

  it("refuses an unknown request id", async () => {
    const { daemons } = await ready();
    expect(daemons.owns("nope")).toBe(false);
    expect(() => daemons.answer({ id: "nope", decision: "allow" })).toThrowError(DaemonError);
  });
});

describe("the proxy connector", () => {
  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
    stdout.setEncoding = () => {};
    const written: string[] = [];
    child.stdout = stdout;
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { destroyed: false, write: (text: string) => written.push(text) });
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit("close"));
    });
    return { child, stdout, written };
  }

  it("runs `codex app-server proxy` with CODEX_HOME and no socket argument", async () => {
    const { child, stdout, written } = fakeChild();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const connect = proxyConnector({ codexPath: async () => "/usr/bin/codex", env: { PATH: "/bin" }, platform: "linux", spawnFn: spawnFn as never });
    const peer = await connect("/home/u/.codex");
    const [command, args, options] = spawnFn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(command).toBe("/usr/bin/codex");
    expect(args).toEqual(["app-server", "proxy"]);
    expect(options.env.CODEX_HOME).toBe("/home/u/.codex");
    expect(args.some((arg) => arg.includes("--sock"))).toBe(false);

    const lines: string[] = [];
    let closed = 0;
    peer.onLine((line) => lines.push(line));
    peer.onClose(() => closed++);
    expect(peer.send('{"id":1}')).toBe(true);
    expect(written).toEqual(['{"id":1}\n']);
    stdout.emit("data", '{"a":1}\n{"b"');
    stdout.emit("data", ":2}\n");
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    peer.close();
    await tick();
    expect(closed).toBe(1);
    expect(peer.send("{}")).toBe(false);
  });

  it("goes through cmd.exe for a Windows shim and refuses a path with shell characters", async () => {
    const { child } = fakeChild();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const connect = proxyConnector({ codexPath: async () => "C:\\npm\\codex.cmd", env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, platform: "win32", spawnFn: spawnFn as never });
    await connect("C:\\Users\\u\\.codex");
    const [command, args, options] = spawnFn.mock.calls[0] as unknown as [string, string[], { windowsVerbatimArguments: boolean }];
    expect(command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(args[3]).toContain("app-server proxy");
    expect(options.windowsVerbatimArguments).toBe(true);

    const unsafe = proxyConnector({ codexPath: async () => "C:\\a&b\\codex.cmd", platform: "win32", spawnFn: spawnFn as never });
    await expect(unsafe("C:\\h")).rejects.toMatchObject({ code: "cli_missing" });
  });

  it("fails as cli_missing when Codex is not installed", async () => {
    const connect = proxyConnector({ codexPath: async () => null });
    await expect(connect("/h")).rejects.toMatchObject({ code: "cli_missing" });
  });

  it("rejects when the process cannot be spawned", async () => {
    const { child } = fakeChild();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
      return child;
    });
    const connect = proxyConnector({ codexPath: async () => "/nope/codex", platform: "linux", spawnFn: spawnFn as never });
    await expect(connect("/h")).rejects.toMatchObject({ code: "stopped" });
  });
});

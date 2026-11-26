// Joining the Codex shared app-server daemon as a second client. When a Codex TUI
// runs against the shared daemon (its control socket lives in
// `<CODEX_HOME>/app-server-control/`), `codex app-server proxy` bridges stdio to that
// socket, and the JSON-RPC conversation below lets nex_bot see which threads are
// loaded, start or steer a turn in one, and answer its approval prompts.
//
// Nothing here starts, stops or configures the daemon: when there is no control
// socket (or the proxy cannot connect) the home simply has no daemon, and sessions
// keep to their other routes. Closing a connection only ends the proxy process.
//
// Wire notes (generated schema, codex app-server): messages omit the "jsonrpc"
// field; the handshake is `initialize` then an `initialized` notification.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { CLI_LIMITS, SKILL_LIMIT, skillCommandName, type SkillOption, cliRef, isCliNativeId, type CliErrorCode, type CliOpArgs, type DeviceCliMessage } from "../../../shared/cli-agents.ts";
import { clipUnits } from "./items.ts";

const CONTROL_DIR = "app-server-control";
const RPC_TIMEOUT_MS = 15_000;
const LIST_PAGE = 200;
const LIST_MAX = 1000;
const RETRY_MS = 15_000;
const LIST_EVERY_MS = 1500;
const REQUEST_TTL_MS = 1_790_000;
const LINE_MAX = 8 * 1024 * 1024;

export class DaemonError extends Error {
  constructor(
    readonly code: CliErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

/** One JSON object per line in both directions. */
export interface DaemonPeer {
  send(line: string): boolean;
  close(): void;
  onLine(listener: (line: string) => void): void;
  onClose(listener: () => void): void;
}

export type DaemonConnector = (home: string) => Promise<DaemonPeer>;

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// ---------------------------------------------------------------------------
// JSON-RPC over a peer

interface RpcHandler {
  notification(method: string, params: Rec): void;
  request(id: string | number, method: string, params: Rec): void;
  closed(): void;
}

class Rpc {
  private nextId = 1;
  private readonly waiting = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private ended = false;

  constructor(
    private readonly peer: DaemonPeer,
    private readonly handler: RpcHandler,
  ) {
    peer.onLine((line) => this.line(line));
    peer.onClose(() => this.end());
  }

  get open(): boolean {
    return !this.ended;
  }

  request<T = Rec>(method: string, params: Rec, ms = RPC_TIMEOUT_MS): Promise<T> {
    if (this.ended) return Promise.reject(new DaemonError("stopped", "会话已停止"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new DaemonError("unknown", "会话没有响应"));
      }, ms);
      timer.unref?.();
      this.waiting.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      if (!this.peer.send(JSON.stringify({ id, method, params }))) {
        clearTimeout(timer);
        this.waiting.delete(id);
        reject(new DaemonError("stopped", "会话已停止"));
      }
    });
  }

  notify(method: string, params?: Rec): void {
    this.peer.send(JSON.stringify(params ? { method, params } : { method }));
  }

  respond(id: string | number, result: Rec): boolean {
    return this.peer.send(JSON.stringify({ id, result }));
  }

  close(): void {
    this.end();
    try {
      this.peer.close();
    } catch {
      // already gone
    }
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const [id, entry] of this.waiting) {
      clearTimeout(entry.timer);
      const submitted = entry.method === "turn/steer" || entry.method === "turn/start";
      entry.reject(submitted ? new DaemonError("unknown", "消息的投递结果待确认") : new DaemonError("stopped", "会话已停止"));
      this.waiting.delete(id);
    }
    this.handler.closed();
  }

  private line(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let message: Rec | null;
    try {
      message = rec(JSON.parse(trimmed));
    } catch {
      return;
    }
    if (!message) return;
    const method = typeof message.method === "string" ? message.method : undefined;
    const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined;
    if (method !== undefined) {
      const params = rec(message.params) ?? {};
      if (id !== undefined) this.handler.request(id, method, params);
      else this.handler.notification(method, params);
      return;
    }
    if (typeof id !== "number") return;
    const entry = this.waiting.get(id);
    if (!entry) return;
    this.waiting.delete(id);
    clearTimeout(entry.timer);
    const failure = rec(message.error);
    if (!failure) { entry.resolve(message.result ?? {}); return; }
    const detail = str(failure.message) ?? "request failed";
    // Only an explicit rejection is safe to convert to a second submission.
    const ended = entry.method === "turn/steer" && /^no active turn to steer\b/i.test(detail);
    const replaced = entry.method === "turn/steer" && /^expected active turn id .* but found /i.test(detail);
    const code = replaced ? "busy" : ended ? "turn_changed" : "unknown";
    entry.reject(new DaemonError(code, clipUnits(`Codex: ${detail}`, 200)));
  }
}

// ---------------------------------------------------------------------------
// the real connection: `codex app-server proxy`

const CMD_SCRIPT = /\.(cmd|bat)$/i;
const CMD_UNSAFE = /[&|<>^%"!\r\n]/;

export interface ProxyConnectorOptions {
  /** the resolved Codex CLI, or null when it is not installed */
  codexPath: () => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnFn?: typeof spawn;
}

/** A peer that speaks to the daemon through `codex app-server proxy`, with CODEX_HOME set to `home`. */
export function proxyConnector(options: ProxyConnectorOptions): DaemonConnector {
  return (home) => connectCodexProcess(options, home, "proxy");
}

async function connectCodexProcess(
  options: ProxyConnectorOptions,
  home: string,
  mode: "proxy" | "stdio",
  cwd?: string,
): Promise<DaemonPeer> {
  const file = await options.codexPath();
  if (!file) throw new DaemonError("cli_missing", "未找到 Codex");
  const platform = options.platform ?? process.platform;
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  if (platform === "win32") {
    for (const key of Object.keys(env)) if (key.toUpperCase() === "CODEX_HOME") delete env[key];
  }
  env.CODEX_HOME = home;
  let command = file;
  const subcommand = mode === "proxy" ? "proxy" : "--stdio";
  let args = ["app-server", subcommand];
  let verbatim = false;
  if (platform === "win32" && CMD_SCRIPT.test(file)) {
    if (CMD_UNSAFE.test(file)) throw new DaemonError("cli_missing", "Codex 路径不可用");
    command = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
    args = ["/d", "/s", "/c", `""${file}" app-server ${subcommand}"`];
    verbatim = true;
  }
  const child: ChildProcess = (options.spawnFn ?? spawn)(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: verbatim });
  return new Promise<DaemonPeer>((resolve, reject) => {
    const lines: Array<(line: string) => void> = [];
    const closers: Array<() => void> = [];
    let buffer = "";
    let done = false;
    const closed = (): void => {
      if (done) return;
      done = true;
      for (const listener of closers) listener();
    };
    child.once("error", (error) => {
      if (!done) reject(new DaemonError("stopped", clipUnits(String(error.message), 200)));
      closed();
    });
    child.once("close", closed);
    child.stdin?.on("error", () => {});
    child.stderr?.on("data", () => {});
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        for (const listener of lines) listener(line);
        at = buffer.indexOf("\n");
      }
      if (buffer.length > LINE_MAX) child.kill();
    });
    child.once("spawn", () =>
      resolve({
        send: (line) => {
          if (done || !child.stdin || child.stdin.destroyed) return false;
          child.stdin.write(line + "\n");
          return true;
        },
        close: () => {
          if (mode === "proxy") child.kill();
          else {
            child.stdin?.end();
            const kill = setTimeout(() => child.kill(), 1500);
            kill.unref();
            child.once("close", () => clearTimeout(kill));
          }
        },
        onLine: (listener) => void lines.push(listener),
        onClose: (listener) => {
          if (done) listener();
          else closers.push(listener);
        },
      }),
    );
  });
}

/** Give a new CLI chat a durable ID before the terminal waits for its first message. */
export async function prepareCodexThread(
  input: { executable: string; home: string; cwd: string },
  options: Pick<ProxyConnectorOptions, "platform" | "env"> = {},
): Promise<string> {
  const peer = await connectCodexProcess({ ...options, codexPath: async () => input.executable }, input.home, "stdio", input.cwd);
  const rpc = new Rpc(peer, { notification() {}, request() {}, closed() {} });
  const closed = new Promise<void>((resolve) => peer.onClose(resolve));
  try {
    const timeout = 6_000;
    await rpc.request("initialize", { clientInfo: { name: "nexbot", title: "NexBot", version: "1" }, capabilities: null }, timeout);
    rpc.notify("initialized");
    const result = await rpc.request("thread/start", { cwd: input.cwd }, timeout);
    const id = rec(result.thread)?.id;
    if (!isCliNativeId(id)) throw new DaemonError("unknown", "Codex 没有返回会话 ID");
    // Codex lazily creates the rollout. Naming the blank thread persists it without submitting a turn.
    await rpc.request("thread/name/set", { threadId: id, name: CODEX_NEW_THREAD_NAME }, timeout);
    return id;
  } finally {
    rpc.close();
    await closed;
  }
}

/** Ask the installed CLI for its enabled project, user and plugin skills without starting a turn. */
export async function codexSkills(options: ProxyConnectorOptions, home: string, cwd: string) {
  const peer = await connectCodexProcess(options, home, "stdio", cwd);
  const rpc = new Rpc(peer, { notification() {}, request() {}, closed() {} });
  try {
    await rpc.request("initialize", { clientInfo: { name: "nexbot", version: "1" }, capabilities: null }, 4000);
    rpc.notify("initialized");
    const result = await rpc.request("skills/list", { cwds: [cwd] }, 8000);
    const group = Array.isArray(result.data) ? rec(result.data[0]) : null;
    if (!Array.isArray(group?.skills)) throw new DaemonError("invalid", "Codex 未返回技能列表");
    const unique = new Map<string, SkillOption>();
    for (const entry of group.skills) {
      const row = rec(entry);
      if (!row || row.enabled === false || typeof row.name !== "string" || !skillCommandName.test(row.name) || unique.has(row.name)) continue;
      unique.set(row.name, { name: row.name, description: clipUnits(str(row.shortDescription) ?? str(row.description) ?? "", 300) });
      if (unique.size === SKILL_LIMIT) break;
    }
    return { skills: [...unique.values()] };
  } finally { rpc.close(); }
}

export const CODEX_NEW_THREAD_NAME = "NexAgent 新会话";

/** True when `<home>/app-server-control/` holds anything: a control socket a TUI may be using. */
export async function controlSocketExists(home: string): Promise<boolean> {
  try {
    return (await readdir(path.join(home, CONTROL_DIR))).length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// the pool

export interface CodexDaemonOptions {
  connect: DaemonConnector;
  /** Whether a control socket exists for the home. Default: `controlSocketExists`. */
  detect?: (home: string) => Promise<boolean>;
  emit: (message: DeviceCliMessage) => boolean;
  now?: () => number;
  ttlMs?: number;
  rpcTimeoutMs?: number;
  retryMs?: number;
  listEveryMs?: number;
  log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  /** a connection ended: the set of loaded threads of that home changed */
  onLost?: (home: string) => void;
}

interface Home {
  rpc: Rpc | null;
  connecting: Promise<Rpc | null> | null;
  threads: Set<string> | undefined;
  listedAt: number;
  retryAt: number;
  joined: Set<string>;
  /** the turn in progress per thread */
  active: Map<string, string>;
}

type ApprovalKind = "shell" | "apply_patch" | "permissions";

interface Tracked {
  id: string;
  home: string;
  rpcId: string | number;
  threadId: string;
  kind: ApprovalKind;
  params: Rec;
  expiresAt: number;
  timer: NodeJS.Timeout;
  rpc: Rpc;
}

const APPROVALS: Record<string, ApprovalKind> = {
  "item/commandExecution/requestApproval": "shell",
  "item/fileChange/requestApproval": "apply_patch",
  "item/permissions/requestApproval": "permissions",
};

export class CodexDaemons {
  private readonly homes = new Map<string, Home>();
  private readonly requests = new Map<string, Tracked>();
  private closed = false;

  constructor(private readonly options: CodexDaemonOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string): void {
    try {
      this.options.log?.(level, message);
    } catch {
      // logging must not break the client
    }
  }

  private home(home: string): Home {
    let state = this.homes.get(home);
    if (!state) {
      state = { rpc: null, connecting: null, threads: undefined, listedAt: Number.NEGATIVE_INFINITY, retryAt: 0, joined: new Set(), active: new Map() };
      this.homes.set(home, state);
    }
    return state;
  }

  /** The threads the daemon had loaded at the last refresh; undefined without a daemon. */
  threads(home: string): ReadonlySet<string> | undefined {
    const state = this.homes.get(home);
    return state?.rpc?.open ? state.threads : undefined;
  }

  /** Looks at the daemon again (at most every `listEveryMs`). Never throws and never starts a daemon. */
  async refresh(home: string): Promise<void> {
    if (this.closed) return;
    const state = this.home(home);
    const detect = this.options.detect ?? controlSocketExists;
    if (!(await detect(home))) {
      if (state.rpc) state.rpc.close();
      return;
    }
    const rpc = await this.connection(home, state);
    if (!rpc) return;
    if (this.now() - state.listedAt < (this.options.listEveryMs ?? LIST_EVERY_MS)) return;
    try {
      const found = new Set<string>();
      let cursor: string | null = null;
      do {
        const page: Rec = await rpc.request("thread/loaded/list", { limit: LIST_PAGE, ...(cursor ? { cursor } : {}) }, this.options.rpcTimeoutMs);
        const data = Array.isArray(page.data) ? page.data : [];
        for (const id of data) if (isCliNativeId(id)) found.add(id);
        cursor = str(page.nextCursor) ?? null;
      } while (cursor && found.size < LIST_MAX);
      state.threads = found;
      state.listedAt = this.now();
    } catch (error) {
      this.log("warn", `listing the daemon's threads failed: ${String(error)}`);
      rpc.close();
    }
  }

  private connection(home: string, state: Home): Promise<Rpc | null> {
    if (state.rpc?.open) return Promise.resolve(state.rpc);
    if (state.connecting) return state.connecting;
    if (this.now() < state.retryAt) return Promise.resolve(null);
    state.connecting = (async () => {
      let rpc: Rpc | null = null;
      try {
        const peer = await this.options.connect(home);
        rpc = new Rpc(peer, {
          notification: (method, params) => this.onNotification(home, method, params),
          request: (id, method, params) => this.onRequest(home, rpc as Rpc, id, method, params),
          closed: () => this.onClosed(home, rpc),
        });
        await rpc.request(
          "initialize",
          { clientInfo: { name: "nexbot", title: "NexBot", version: "1" }, capabilities: null },
          this.options.rpcTimeoutMs,
        );
        rpc.notify("initialized");
        if (this.closed) {
          rpc.close();
          return null;
        }
        state.rpc = rpc;
        state.threads = undefined;
        state.listedAt = Number.NEGATIVE_INFINITY;
        return rpc;
      } catch (error) {
        this.log("debug", `no usable Codex daemon for ${home}: ${String(error)}`);
        state.retryAt = this.now() + (this.options.retryMs ?? RETRY_MS);
        rpc?.close();
        return null;
      } finally {
        state.connecting = null;
      }
    })();
    return state.connecting;
  }

  private onClosed(home: string, rpc: Rpc | null): void {
    const state = this.homes.get(home);
    if (!state || (rpc && state.rpc && state.rpc !== rpc)) return;
    const had = state.rpc !== null;
    state.rpc = null;
    state.threads = undefined;
    state.joined.clear();
    state.active.clear();
    state.retryAt = this.now() + (this.options.retryMs ?? RETRY_MS);
    for (const tracked of this.requests.values()) if (tracked.home === home) this.resolve(tracked, "gone");
    if (had) this.options.onLost?.(home);
  }

  // -- joining and sending ---------------------------------------------------------

  private async ready(home: string): Promise<{ state: Home; rpc: Rpc }> {
    const state = this.home(home);
    const rpc = await this.connection(home, state);
    if (!rpc) throw new DaemonError("stopped", "会话已停止");
    return { state, rpc };
  }

  /** Joins a loaded thread as a second client (without its history) and learns whether a turn is running. */
  async join(home: string, threadId: string): Promise<void> {
    const { state, rpc } = await this.ready(home);
    if (state.joined.has(threadId)) return;
    await rpc.request("thread/resume", { threadId, excludeTurns: true }, this.options.rpcTimeoutMs);
    state.joined.add(threadId);
    try {
      const latest = await rpc.request<Rec>("thread/turns/list", { threadId, limit: 1, sortDirection: "desc" }, this.options.rpcTimeoutMs);
      const turn = Array.isArray(latest.data) ? rec(latest.data[0]) : null;
      const id = str(turn?.id);
      if (turn && id && turn.status === "inProgress") state.active.set(threadId, id);
      else state.active.delete(threadId);
    } catch (error) {
      this.log("debug", `reading the latest turn of ${threadId} failed: ${String(error)}`);
    }
  }

  /** Receipt for an explicit guide, including a guide that arrived after completion. */
  async steer(home: string, threadId: string, text: string): Promise<{ accepted: boolean; started: boolean }> {
    try {
      const { steered } = await this.send(home, threadId, text);
      return { accepted: true, started: !steered };
    } catch (error) {
      if (error instanceof DaemonError && error.code === "busy") throw new DaemonError("turn_changed", error.message);
      throw error;
    }
  }

  /** Puts a message into the thread: steers the running turn, or starts a new one. */
  async send(home: string, threadId: string, text: string): Promise<{ steered: boolean }> {
    await this.join(home, threadId);
    const { state, rpc } = await this.ready(home);
    const input = [{ type: "text", text, text_elements: [] }];
    const running = state.active.get(threadId);
    if (running) {
      try {
        await rpc.request("turn/steer", { threadId, expectedTurnId: running, input }, this.options.rpcTimeoutMs);
        return { steered: true };
      } catch (error) {
        // the turn may have ended in the meantime; a lost connection is not that
        if (!rpc.open) throw new DaemonError("unknown", "引导的投递结果待确认");
        if (!(error instanceof DaemonError) || error.code !== "turn_changed") throw error;
        if (state.active.get(threadId) === running) state.active.delete(threadId);
        this.log("debug", `steering ${threadId} failed, starting a turn instead: ${String(error)}`);
      }
    }
    const started = await rpc.request<Rec>("turn/start", { threadId, input }, this.options.rpcTimeoutMs);
    const id = str(rec(started.turn)?.id);
    if (id) state.active.set(threadId, id);
    return { steered: false };
  }

  // -- notifications and approval requests ---------------------------------------------

  private onNotification(home: string, method: string, params: Rec): void {
    const state = this.homes.get(home);
    if (!state) return;
    const threadId = str(params.threadId);
    if (method === "turn/started" && threadId) {
      const id = str(rec(params.turn)?.id);
      if (id) state.active.set(threadId, id);
    } else if (method === "turn/completed" && threadId) {
      const finished = str(rec(params.turn)?.id);
      if (!finished || state.active.get(threadId) === finished) state.active.delete(threadId);
    } else if (method === "serverRequest/resolved") {
      const rpcId = params.requestId;
      for (const tracked of this.requests.values()) {
        if (tracked.home === home && tracked.rpcId === rpcId) this.resolve(tracked, "terminal");
      }
    } else if (method === "thread/closed" && threadId) {
      state.joined.delete(threadId);
      state.active.delete(threadId);
      state.threads?.delete(threadId);
    }
  }

  private onRequest(home: string, rpc: Rpc, rpcId: string | number, method: string, params: Rec): void {
    const kind = APPROVALS[method];
    // anything else is left to the other clients of the daemon
    if (!kind) return;
    const threadId = str(params.threadId);
    if (!threadId || !isCliNativeId(threadId) || this.closed) return;
    const id = randomUUID();
    const ttl = this.options.ttlMs ?? REQUEST_TTL_MS;
    const timer = setTimeout(() => this.resolve(tracked, "timeout"), ttl);
    timer.unref?.();
    const tracked: Tracked = { id, home, rpcId, threadId, kind, params, expiresAt: this.now() + ttl, timer, rpc };
    this.requests.set(id, tracked);
    this.announce(tracked);
  }

  private announce(tracked: Tracked): boolean {
    return this.options.emit({
      type: "cli.request",
      ref: cliRef("codex", tracked.threadId),
      id: tracked.id,
      kind: "permission",
      tool: tracked.kind,
      summary: summaryOf(tracked.kind, tracked.params),
      ...detailOf(tracked.kind, tracked.params),
      // accepted for the session: `acceptForSession` for commands and edits, scope `session` for permissions
      always: true,
      expiresAt: tracked.expiresAt,
    });
  }

  /** Closes a request on our side and tells Core why. The daemon's own request is left as it is. */
  private resolve(tracked: Tracked, by: "terminal" | "timeout" | "gone"): void {
    if (this.requests.get(tracked.id) !== tracked) return;
    clearTimeout(tracked.timer);
    this.requests.delete(tracked.id);
    this.options.emit({ type: "cli.request.resolved", id: tracked.id, by });
  }

  /** Core came back: its copies were closed with the old link, so announce the open ones again. */
  relink(): void {
    for (const tracked of this.requests.values()) this.announce(tracked);
  }

  /** Whether an approval of this thread is open. */
  hasPendingFor(threadId: string): boolean {
    for (const tracked of this.requests.values()) if (tracked.threadId === threadId) return true;
    return false;
  }

  /** Whether the request belongs to a daemon thread. */
  owns(requestId: string): boolean {
    return this.requests.has(requestId);
  }

  /** Answers an approval: allow accepts it (for the rest of the session with `always`), deny declines it.
   * Throws DaemonError not_found when it is closed. */
  answer(args: CliOpArgs["answer"]): string {
    const tracked = this.requests.get(args.id);
    if (!tracked) throw new DaemonError("not_found", "request is closed");
    if (!tracked.rpc.open) {
      this.resolve(tracked, "gone");
      throw new DaemonError("not_found", "request is closed");
    }
    const allow = args.decision === "allow";
    const session = allow && args.always === true;
    let result: Rec;
    if (tracked.kind === "permissions") {
      const asked = rec(tracked.params.permissions) ?? {};
      result = allow ? { permissions: grantedOf(asked), scope: session ? "session" : "turn" } : { permissions: {}, scope: "turn" };
    } else {
      result = { decision: allow ? (session ? "acceptForSession" : "accept") : "decline" };
    }
    if (!tracked.rpc.respond(tracked.rpcId, result)) {
      this.resolve(tracked, "gone");
      throw new DaemonError("not_found", "request is closed");
    }
    // Core closes its copy when this answer succeeds, so no resolved message goes back.
    clearTimeout(tracked.timer);
    this.requests.delete(tracked.id);
    return "ok";
  }

  /** Ends every proxy connection (the daemon itself is untouched). */
  close(): void {
    this.closed = true;
    for (const tracked of this.requests.values()) {
      clearTimeout(tracked.timer);
      this.requests.delete(tracked.id);
    }
    for (const state of this.homes.values()) state.rpc?.close();
    this.homes.clear();
  }
}

function grantedOf(asked: Rec): Rec {
  const granted: Rec = {};
  if (asked.fileSystem) granted.fileSystem = asked.fileSystem;
  if (asked.network) granted.network = asked.network;
  return granted;
}

/** What the card shows below the summary: the command, folder and reason, one per line. */
function detailOf(kind: ApprovalKind, params: Rec): { detail?: string } {
  const command = Array.isArray(params.command) ? params.command.filter((part) => typeof part === "string").join(" ") : str(params.command);
  const lines = [
    kind === "shell" && command ? `命令：${command}` : undefined,
    str(params.cwd) ? `目录：${str(params.cwd)}` : undefined,
    kind === "apply_patch" && str(params.grantRoot) ? `写入范围：${str(params.grantRoot)}` : undefined,
    str(params.reason) ? `原因：${str(params.reason)}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return lines.length > 1 ? { detail: clipUnits(lines.join("\n"), CLI_LIMITS.requestDetail) } : {};
}

function summaryOf(kind: ApprovalKind, params: Rec): string {
  const command = Array.isArray(params.command) ? params.command.filter((part) => typeof part === "string").join(" ") : str(params.command);
  const parts =
    kind === "shell"
      ? [command, str(params.reason), str(params.cwd)]
      : kind === "apply_patch"
        ? [str(params.reason), str(params.grantRoot)]
        : [str(params.reason), str(params.cwd)];
  return clipUnits(parts.find((part) => part !== undefined) ?? "", CLI_LIMITS.requestDescription);
}

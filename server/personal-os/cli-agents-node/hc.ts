// herdr-core client for Agent mode (plan 3.2).
//
// herdr-core ("hc") owns the Claude/Codex terminals so they keep running when
// this process exits, pauses or updates. We talk to it over its client
// endpoint (a named pipe on Windows, a Unix socket elsewhere): plain JSON-RPC
// lines for the `hello` handshake, then framed mode (see hc-frames.ts) where
// channel 0 carries JSON-RPC and every other channel is an attach stream or
// the event stream.
//
// Deliberately not wrapped: machine.*, file.*, templates.*, server.stop and
// doc.set. Agent mode never needs another machine, a file API or the core's
// lifecycle, and `call()` refuses them by name.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Frame,
  FrameDecoder,
  FrameKind,
  decodeCloseReason,
  decodeResize,
  encodeClose,
  encodeCredit,
  encodeFocus,
  encodeFrame,
  encodeJsonFrame,
  encodeResize,
} from "./hc-frames.ts";

// TODO(contract): swap for HERDR_CORE_VERSION from shared/cli-agents.ts.
export const HC_VERSION = "0.1.21";
export const HC_GENERATION = 1;
/** Methods this client calls; `hello` must list all of them. */
export const HC_REQUIRED_METHODS = [
  "terminal.run",
  "terminal.list",
  "terminal.get",
  "terminal.attach",
  "terminal.send",
  "terminal.keys",
  "terminal.interrupt",
  "terminal.read",
  "events.subscribe",
] as const;
/** What `call()` accepts. Anything else is a programming error, not a core error. */
const CALLABLE = new Set<string>(HC_REQUIRED_METHODS);

/** Window for one attach DATA frame we send (keys and pastes are small). */
const SEND_CHUNK = 64 * 1024;
const NO_EVENT_STALL_MS = 50_000;

// ---------------------------------------------------------------------------
// Errors

/** Kinds produced here start with `hc_`; kinds from the core are its own
 * stable `data.kind` strings (not_found, name_taken, spawn_failed, blocked ...). */
export type HcErrorKind =
  | "hc_unavailable"
  | "hc_version"
  | "hc_disconnected"
  | "hc_timeout"
  | "hc_protocol"
  | "hc_closed"
  | "hc_forbidden"
  | "hc_observe_only"
  | (string & {});

export class HcError extends Error {
  readonly kind: HcErrorKind;
  readonly hint: string;
  readonly code?: number;
  constructor(kind: HcErrorKind, message: string, hint = "", code?: number) {
    super(message);
    this.name = "HcError";
    this.kind = kind;
    this.hint = hint;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Locating the binary and building its environment

export interface LocateOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  /** import.meta.url of the bundle; tests point it at a temporary layout. */
  moduleUrl?: string;
}

export function herdrCoreExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "herdr-core.exe" : "herdr-core";
}

/** Finds herdr-core in this order: NEX_HERDR_CORE_PATH, the packaged
 * `herdr-core/` beside the executor's `client-node/` folder, then the
 * development `dist-native/herdr-core/<platform>-<arch>/` of a checkout.
 * Returns null when none exists; the bridge then reports `hc_unavailable`. */
export function locateHerdrCore(options: LocateOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const exe = herdrCoreExecutableName(platform);

  const override = env.NEX_HERDR_CORE_PATH?.trim();
  if (override && existsSync(override)) return path.resolve(override);

  const here = path.dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
  const packaged = path.resolve(here, "..", "herdr-core", exe);
  if (existsSync(packaged)) return packaged;

  let directory = here;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(directory, "dist-native", "herdr-core", `${platform}-${arch}`, exe);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/** The environment herdr-core and its terminals run in. XDG_STATE_HOME and
 * XDG_CONFIG_HOME are left alone on purpose: programs in the terminal inherit
 * them (git and gh read XDG_CONFIG_HOME) and must see the user's own. */
export function hcEnvironment(
  options: { session: string; socket: string },
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...base, HC_SESSION: options.session, HC_SOCKET: options.socket };
}

// ---------------------------------------------------------------------------
// Wire types (subset of hc.openrpc.json)

// TODO(contract): the engine/label names move to shared/cli-agents.ts.
export interface HcTerminal {
  address: string;
  name: string | null;
  state: string;
  argv: string[];
  cwd: string;
  cols: number;
  rows: number;
  pid: number | null;
  labels: Record<string, string>;
  exit_code: number | null;
  reason: string | null;
  created_ms: number;
  finished_ms: number | null;
  status?: unknown;
  [key: string]: unknown;
}

export interface HcRunParams {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  name?: string;
  labels?: Record<string, string>;
  size?: { cols: number; rows: number };
  keep?: boolean;
  rm?: boolean;
}

export interface HcListResult {
  terminals: HcTerminal[];
  hidden_finished: number;
  machines: unknown[];
}

export interface HcSendParams {
  terminal: string;
  text: string;
  wait?: boolean;
  timeout?: number;
  force?: boolean;
  if?: "idle" | "working";
}

export interface HcSendResult {
  turn: number;
  started?: boolean | null;
  status?: string | null;
  wait?: unknown;
}

export interface HcAttachParams {
  terminal: string;
  cols: number;
  rows: number;
  history?: number;
  observe?: boolean;
  resizeNotifications?: boolean;
  resumed?: boolean;
}

export interface HcEvent {
  seq: number;
  type: string;
  terminal?: string;
  machine?: string;
  data: unknown;
}

export interface HcHello {
  version: string;
  generation: number;
  methods: string[];
  features: string[];
  core?: { id?: string; name?: string };
}

export type HcStatus = "idle" | "connecting" | "ready" | "reconnecting" | "unavailable" | "incompatible" | "closed";

export interface HcState {
  status: HcStatus;
  since: number;
  /** Consecutive failed (re)connect attempts since the last ready state. */
  attempt: number;
  nextRetryMs?: number;
  lastError?: { kind: HcErrorKind; message: string; hint: string };
  hello?: HcHello;
}

export interface HcSnapshot {
  seq: number;
  terminals: HcTerminal[];
  /** True when this snapshot follows a reconnect or a `missed` notice. */
  resync: boolean;
}

export interface HcStreamClose {
  /** exited, killed, server_stop ... from the core; hc_disconnected / hc_closed / detached from us. */
  reason: string;
  exitCode?: number | null;
  signal?: number | string | null;
}

export type HcLogger = (level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;

export interface HerdrCoreOptions {
  binary: string;
  session: string;
  socket: string;
  log?: HcLogger;
  /** Detached command that brings the background core up (`herdr-core server start`). */
  startArgs?: string[];
  startTimeoutMs?: number;
  connectIntervalMs?: number;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  backoff?: { minMs: number; maxMs: number };
  reconnect?: boolean;
  /** Close the connection when the event stream is silent this long (heartbeats come every 15 s). */
  eventStallMs?: number;
  env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Attach stream

interface StreamEvents {
  data: [Buffer];
  resize: [{ cols: number; rows: number }];
  close: [HcStreamClose];
}

/** One attached terminal view. `data` carries the first paint and then raw
 * program output. The core sends 256 KiB of credit up front and more only as
 * we acknowledge bytes: with `autoAck` (default) that happens as soon as `data`
 * listeners return; otherwise the owner calls `ack()` once it has really
 * forwarded the bytes, which is how end-to-end flow control works. */
export class HcAttachStream extends EventEmitter<StreamEvents> {
  readonly channel: number;
  readonly terminal: HcTerminal;
  readonly observe: boolean;
  readonly automaticInput: boolean;
  readonly resizeNotifications: boolean;
  readonly autoAck: boolean;
  closed = false;
  /** Output that arrived before anyone listened (the first paint usually shares a
   * socket chunk with the attach reply). Held, not dropped, until a `data`
   * listener exists; credit is returned only on delivery, which bounds it. */
  private early: Buffer[] = [];
  private flushScheduled = false;
  private pendingClose: HcStreamClose | null = null;
  private readonly send: (frame: Buffer) => void;
  private readonly release: (channel: number) => void;

  constructor(init: {
    channel: number;
    terminal: HcTerminal;
    observe: boolean;
    automaticInput: boolean;
    resizeNotifications: boolean;
    autoAck: boolean;
    send: (frame: Buffer) => void;
    release: (channel: number) => void;
  }) {
    super();
    this.channel = init.channel;
    this.terminal = init.terminal;
    this.observe = init.observe;
    this.automaticInput = init.automaticInput;
    this.resizeNotifications = init.resizeNotifications;
    this.autoAck = init.autoAck;
    this.send = init.send;
    this.release = init.release;
    this.on("newListener", (event) => {
      if (event === "data") this.scheduleFlush();
    });
  }

  /** Called by the connection for each DATA frame. */
  deliver(payload: Buffer): void {
    if (this.listenerCount("data") === 0 || this.early.length > 0) {
      this.early.push(payload);
      this.scheduleFlush();
      return;
    }
    this.emitData(payload);
  }

  private emitData(payload: Buffer): void {
    this.emit("data", payload);
    if (this.autoAck) this.ack(payload.length);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      if (this.listenerCount("data") > 0) {
        for (let chunk = this.early.shift(); chunk; chunk = this.early.shift()) this.emitData(chunk);
      }
      if (this.pendingClose) {
        const reason = this.pendingClose;
        this.pendingClose = null;
        this.early = [];
        this.emit("close", reason);
      }
    });
  }

  /** Keys or pasted bytes from a human viewer. `automatic` marks replies the
   * viewer's terminal emulator generated itself (cursor reports, color
   * queries); they are sent as AUTOMATIC_INPUT only when the whole path
   * negotiated it, so they never count as typing for draft wait. */
  write(data: string | Uint8Array, options: { automatic?: boolean } = {}): void {
    if (this.closed) throw new HcError("hc_closed", "terminal stream is closed");
    if (this.observe) throw new HcError("hc_observe_only", "an observing stream cannot type");
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const kind = options.automatic && this.automaticInput ? FrameKind.AUTOMATIC_INPUT : FrameKind.DATA;
    for (let offset = 0; offset < bytes.length; offset += SEND_CHUNK) {
      this.send(encodeFrame(this.channel, kind, bytes.subarray(offset, offset + SEND_CHUNK)));
    }
  }

  resize(cols: number, rows: number): void {
    if (this.closed) throw new HcError("hc_closed", "terminal stream is closed");
    if (this.observe) throw new HcError("hc_observe_only", "an observing stream cannot resize");
    this.send(encodeResize(this.channel, cols, rows));
  }

  focus(focused: boolean): void {
    if (this.closed || this.observe) return;
    this.send(encodeFocus(this.channel, focused));
  }

  /** Return credit for bytes already written out (no-op after close). */
  ack(bytes: number): void {
    if (this.closed || bytes <= 0) return;
    this.send(encodeCredit(this.channel, bytes));
  }

  /** Detach. The program keeps running; the core answers with an empty CLOSE. */
  close(): void {
    if (this.closed) return;
    try {
      this.send(encodeClose(this.channel));
    } catch {
      // The connection is already gone; finishing locally is all that is left.
    }
    this.early = [];
    this.finish({ reason: "detached" });
  }

  /** Called by the connection. */
  finish(reason: HcStreamClose): void {
    if (this.closed) return;
    this.closed = true;
    this.release(this.channel);
    if (this.early.length > 0) {
      this.pendingClose = reason;
      this.scheduleFlush();
      return;
    }
    this.emit("close", reason);
  }
}

// ---------------------------------------------------------------------------
// The client

interface HcEvents {
  state: [HcState];
  event: [HcEvent];
  snapshot: [HcSnapshot];
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  onResult?: (result: unknown) => void;
}

interface Connection {
  socket: net.Socket;
  decoder: FrameDecoder;
  generation: number;
}

export interface CallOptions {
  timeoutMs?: number;
}

const DEFAULTS = {
  startArgs: ["server", "start"],
  startTimeoutMs: 10_000,
  connectIntervalMs: 200,
  requestTimeoutMs: 15_000,
  handshakeTimeoutMs: 5000,
  backoff: { minMs: 1000, maxMs: 30_000 },
  reconnect: true,
  eventStallMs: NO_EVENT_STALL_MS,
};

export class HerdrCore extends EventEmitter<HcEvents> {
  private readonly options: Required<Omit<HerdrCoreOptions, "log" | "env">> & { log: HcLogger; env: NodeJS.ProcessEnv };
  private connection: Connection | null = null;
  private connectionCounter = 0;
  private nextId = 2;
  private readonly pending = new Map<number, Pending>();
  private readonly streams = new Map<number, HcAttachStream>();
  private eventChannel: number | null = null;
  private eventBuffer = "";
  private subscription: { labels: Record<string, string> } | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private lastEventAt = 0;
  private starting: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private current: HcState = { status: "idle", since: Date.now(), attempt: 0 };
  private hadReady = false;

  constructor(options: HerdrCoreOptions) {
    super();
    this.options = {
      ...DEFAULTS,
      ...options,
      backoff: options.backoff ?? DEFAULTS.backoff,
      startArgs: options.startArgs ?? DEFAULTS.startArgs,
      log: options.log ?? (() => {}),
      env: hcEnvironment(options, options.env ?? process.env),
    };
  }

  state(): HcState {
    return { ...this.current };
  }

  // -- lifecycle ------------------------------------------------------------

  /** Connects to the core, starting it (detached) when nothing answers, and
   * checks version, generation and methods. Safe to call concurrently. */
  ensureStarted(): Promise<void> {
    if (this.closing) return Promise.reject(new HcError("hc_closed", "herdr-core client is closed"));
    if (this.current.status === "ready" && this.connection) return Promise.resolve();
    this.starting ??= this.startAndConnect().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Drops the connection and stops reconnecting. Terminals keep running. */
  close(): void {
    this.closing = true;
    this.clearReconnect();
    this.dropConnection(new HcError("hc_closed", "herdr-core client closed"), "hc_closed");
    this.setState({ status: "closed", attempt: 0 });
  }

  private async startAndConnect(): Promise<void> {
    this.clearReconnect();
    this.setState({ status: this.hadReady ? "reconnecting" : "connecting" });
    const deadline = Date.now() + this.options.startTimeoutMs;
    let spawned = false;
    let lastError: HcError | null = null;
    for (;;) {
      try {
        await this.connectOnce();
        return;
      } catch (caught) {
        const error = caught instanceof HcError ? caught : new HcError("hc_unavailable", String((caught as Error)?.message ?? caught));
        if (error.kind === "hc_version") {
          this.setState({ status: "incompatible", lastError: describe(error) });
          this.options.log("error", "herdr-core is not compatible", { message: error.message });
          throw error;
        }
        lastError = error;
      }
      if (!spawned) {
        spawned = true;
        const spawnError = this.spawnCore();
        if (spawnError) {
          lastError = spawnError;
          break;
        }
      }
      if (Date.now() >= deadline) break;
      await sleep(this.options.connectIntervalMs);
      if (this.closing) throw new HcError("hc_closed", "herdr-core client is closed");
    }
    const error = new HcError(
      "hc_unavailable",
      `herdr-core did not answer within ${this.options.startTimeoutMs} ms${lastError ? `: ${lastError.message}` : ""}`,
      lastError?.hint || "check that herdr-core can run on this computer (security software may block it)",
    );
    this.setState({ status: "unavailable", lastError: describe(error), attempt: this.current.attempt + 1, nextRetryMs: undefined });
    this.scheduleReconnect();
    throw error;
  }

  /** Runs `herdr-core server start` detached so the background core is never
   * in this process's tree: pausing the device node ends its own children
   * but must not end the terminals. Returns an error when it cannot launch. */
  private spawnCore(): HcError | null {
    try {
      const child = spawn(this.options.binary, this.options.startArgs, {
        env: this.options.env,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", (error) => this.options.log("warn", "herdr-core start command failed", { message: error.message }));
      child.unref();
      this.options.log("info", "started herdr-core", { binary: this.options.binary, session: this.options.session });
      return null;
    } catch (error) {
      return new HcError("hc_unavailable", `cannot run herdr-core: ${(error as Error).message}`, "herdr-core is missing or blocked");
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const generation = ++this.connectionCounter;
      const socket = net.connect(this.options.socket);
      const decoder = new FrameDecoder();
      let plain = "";
      let phase: "connect" | "hello" | "framed" = "connect";
      let settled = false;
      const timer = setTimeout(() => fail(new HcError("hc_timeout", "herdr-core did not answer hello")), this.options.handshakeTimeoutMs);

      const fail = (error: HcError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };

      socket.once("connect", () => {
        phase = "hello";
        const hello = {
          jsonrpc: "2.0",
          id: 1,
          method: "hello",
          params: { framed: true, generation: HC_GENERATION, features: ["resize_notifications"] },
        };
        socket.write(`${JSON.stringify(hello)}\n`);
      });

      socket.on("data", (chunk: Buffer) => {
        if (phase === "framed") {
          this.onFrames(generation, decoder, chunk);
          return;
        }
        if (phase !== "hello") return;
        plain += chunk.toString("latin1");
        const newline = plain.indexOf("\n");
        if (newline < 0) return;
        // Keep bytes after the reply: framed traffic may follow in this chunk.
        const lineBytes = Buffer.from(plain.slice(0, newline), "latin1").toString("utf8");
        const rest = Buffer.from(plain.slice(newline + 1), "latin1");
        try {
          const hello = this.checkHello(lineBytes);
          phase = "framed";
          settled = true;
          clearTimeout(timer);
          this.attachConnection({ socket, decoder, generation }, hello);
          resolve();
          if (rest.length > 0) this.onFrames(generation, decoder, rest);
        } catch (error) {
          fail(error instanceof HcError ? error : new HcError("hc_protocol", String((error as Error).message)));
        }
      });

      socket.on("error", (error: NodeJS.ErrnoException) => {
        if (!settled) {
          fail(new HcError("hc_unavailable", `cannot connect to herdr-core (${error.code ?? error.message})`));
          return;
        }
        this.options.log("debug", "herdr-core socket error", { message: error.message });
      });

      socket.on("close", () => {
        if (!settled) fail(new HcError("hc_unavailable", "herdr-core closed the connection during hello"));
        else this.onSocketClosed(generation);
      });
    });
  }

  private checkHello(line: string): HcHello {
    let message: { result?: Record<string, unknown>; error?: { message?: string; data?: { kind?: string; hint?: string } } };
    try {
      message = JSON.parse(line);
    } catch {
      throw new HcError("hc_protocol", "herdr-core sent an unreadable hello reply");
    }
    if (message.error) {
      const kind = message.error.data?.kind;
      throw new HcError(
        kind === "unsupported_generation" ? "hc_version" : (kind ?? "hc_protocol"),
        message.error.message ?? "hello failed",
        message.error.data?.hint ?? "",
      );
    }
    const result = message.result ?? {};
    const hello: HcHello = {
      version: String(result.version ?? ""),
      generation: Number(result.generation ?? -1),
      methods: Array.isArray(result.methods) ? result.methods.map(String) : [],
      features: Array.isArray(result.features) ? result.features.map(String) : [],
      core: result.core as HcHello["core"],
    };
    if (hello.version !== HC_VERSION || hello.generation !== HC_GENERATION) {
      throw new HcError(
        "hc_version",
        `herdr-core ${hello.version || "?"} (generation ${hello.generation}) is not the supported ${HC_VERSION} (generation ${HC_GENERATION})`,
        "update OpenMausBot so it ships the matching herdr-core",
      );
    }
    const missing = HC_REQUIRED_METHODS.filter((method) => !hello.methods.includes(method));
    if (missing.length > 0 || result.framed !== true) {
      throw new HcError(
        "hc_version",
        missing.length > 0 ? `herdr-core lacks methods: ${missing.join(", ")}` : "herdr-core did not switch to framed mode",
        "update OpenMausBot so it ships the matching herdr-core",
      );
    }
    return hello;
  }

  private attachConnection(connection: Connection, hello: HcHello): void {
    this.connection = connection;
    this.nextId = 2;
    this.hadReady = true;
    this.setState({ status: "ready", attempt: 0, hello, lastError: undefined, nextRetryMs: undefined });
    this.options.log("info", "connected to herdr-core", { version: hello.version, session: this.options.session });
    if (this.subscription) {
      const labels = this.subscription.labels;
      // Re-subscribe after a reconnect; the owner reconciles from the snapshot.
      void this.subscribe({ labels }, true).catch((error) => {
        this.options.log("warn", "could not re-subscribe to herdr-core events", { message: (error as Error).message });
        connection.socket.destroy();
      });
    }
  }

  // -- reconnect ------------------------------------------------------------

  private onSocketClosed(generation: number): void {
    if (!this.connection || this.connection.generation !== generation) return;
    this.dropConnection(new HcError("hc_disconnected", "lost the connection to herdr-core"), "hc_disconnected");
    if (this.closing || !this.options.reconnect) {
      if (!this.closing) this.setState({ status: "unavailable" });
      return;
    }
    this.setState({ status: "reconnecting" });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closing || !this.options.reconnect || this.reconnectTimer || this.current.status === "incompatible") return;
    const { minMs, maxMs } = this.options.backoff;
    const attempt = Math.max(1, this.current.attempt);
    const delay = Math.min(maxMs, minMs * 2 ** (attempt - 1));
    this.setState({ nextRetryMs: delay, attempt: this.current.status === "reconnecting" ? this.current.attempt + 1 : this.current.attempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureStarted().catch(() => {
        // startAndConnect schedules the next attempt itself.
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private dropConnection(error: HcError, streamReason: string): void {
    const connection = this.connection;
    this.connection = null;
    this.eventChannel = null;
    this.eventBuffer = "";
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stallTimer = null;
    if (connection) {
      connection.socket.removeAllListeners("data");
      connection.socket.destroy();
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const stream of this.streams.values()) stream.finish({ reason: streamReason });
    this.streams.clear();
  }

  private setState(change: Partial<HcState> & { status?: HcStatus }): void {
    const next: HcState = { ...this.current, ...change };
    if (change.status && change.status !== this.current.status) next.since = Date.now();
    this.current = next;
    this.emit("state", { ...next });
  }

  // -- inbound frames -------------------------------------------------------

  private onFrames(generation: number, decoder: FrameDecoder, chunk: Buffer): void {
    let frames: Frame[];
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      this.options.log("error", "herdr-core framing error", { message: (error as Error).message });
      this.connection?.socket.destroy();
      return;
    }
    for (const frame of frames) {
      if (!this.connection || this.connection.generation !== generation) return;
      this.onFrame(frame);
    }
  }

  private onFrame(frame: Frame): void {
    if (frame.channel === 0) {
      if (frame.kind === FrameKind.DATA) this.onRpcMessage(frame.payload.toString("utf8"));
      return;
    }
    if (frame.channel === this.eventChannel) {
      this.onEventFrame(frame);
      return;
    }
    const stream = this.streams.get(frame.channel);
    if (!stream) return;
    switch (frame.kind) {
      case FrameKind.DATA:
        stream.deliver(frame.payload);
        break;
      case FrameKind.RESIZE:
        try {
          stream.emit("resize", decodeResize(frame.payload));
        } catch {
          // A malformed size is not worth dropping the stream for.
        }
        break;
      case FrameKind.CLOSE: {
        const reason = decodeCloseReason(frame.payload);
        stream.finish({
          reason: typeof reason?.reason === "string" ? reason.reason : "closed",
          exitCode: (reason?.exit_code as number | null | undefined) ?? null,
          signal: (reason?.signal as number | string | null | undefined) ?? null,
        });
        break;
      }
      default:
        break;
    }
  }

  private onRpcMessage(text: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { code?: number; message?: string; data?: { kind?: string; hint?: string } };
    };
    try {
      message = JSON.parse(text);
    } catch {
      this.options.log("warn", "herdr-core sent unreadable JSON on channel 0");
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new HcError(message.error.data?.kind ?? "hc_protocol", message.error.message ?? `${pending.method} failed`, message.error.data?.hint ?? "", message.error.code),
        );
        return;
      }
      try {
        // Runs before the promise resolves, so stream channels are registered
        // before the next frame in this chunk (the first paint) is dispatched.
        pending.onResult?.(message.result);
      } catch (error) {
        pending.reject(error as Error);
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if (message.method) this.onNotification(message.method, message.params ?? {});
  }

  private onEventFrame(frame: Frame): void {
    if (frame.kind === FrameKind.CLOSE) {
      // The core ended the event stream; reconnecting restores it.
      this.connection?.socket.destroy();
      return;
    }
    if (frame.kind !== FrameKind.DATA) return;
    this.lastEventAt = Date.now();
    this.eventBuffer += frame.payload.toString("utf8");
    let newline = this.eventBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.eventBuffer.slice(0, newline).trim();
      this.eventBuffer = this.eventBuffer.slice(newline + 1);
      if (line) this.onRpcMessage(line);
      newline = this.eventBuffer.indexOf("\n");
    }
    // One message per frame without a trailing newline is also accepted.
    const rest = this.eventBuffer.trim();
    if (rest) {
      try {
        JSON.parse(rest);
        this.eventBuffer = "";
        this.onRpcMessage(rest);
      } catch {
        // Partial message: wait for the next frame.
      }
    }
    if (this.eventChannel !== null) this.sendFrame(encodeCredit(this.eventChannel, frame.payload.length));
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method === "event") {
      this.emit("event", {
        seq: Number(params.seq ?? 0),
        type: String(params.type ?? ""),
        terminal: typeof params.terminal === "string" ? params.terminal : undefined,
        machine: typeof params.machine === "string" ? params.machine : undefined,
        data: params.data,
      });
    } else if (method === "missed") {
      this.emit("snapshot", {
        seq: Number(params.seq ?? 0),
        terminals: Array.isArray(params.terminals) ? (params.terminals as HcTerminal[]) : [],
        resync: true,
      });
    }
    // heartbeat: only the arrival time matters (lastEventAt).
  }

  // -- outbound -------------------------------------------------------------

  private sendFrame(frame: Buffer): void {
    const connection = this.connection;
    if (!connection || connection.socket.destroyed) throw new HcError("hc_disconnected", "not connected to herdr-core");
    connection.socket.write(frame);
  }

  private request<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    onResult?: (result: T) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.connection) {
        reject(new HcError("hc_disconnected", "not connected to herdr-core", "retry once the core reconnects"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HcError("hc_timeout", `${method} did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        onResult: onResult as ((result: unknown) => void) | undefined,
      });
      try {
        this.sendFrame(encodeJsonFrame(0, { jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error as Error);
      }
    });
  }

  /** Raw JSON-RPC call limited to the methods this client wraps. */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, options: CallOptions = {}): Promise<T> {
    if (!CALLABLE.has(method)) {
      throw new HcError("hc_forbidden", `${method} is not available to Agent mode`);
    }
    await this.ensureStarted();
    return this.request<T>(method, params, options.timeoutMs ?? this.options.requestTimeoutMs);
  }

  // -- wrappers -------------------------------------------------------------

  run(params: HcRunParams, options?: CallOptions): Promise<HcTerminal> {
    return this.call<HcTerminal>("terminal.run", { ...params }, options);
  }

  list(params: { all?: boolean; labels?: Record<string, string> } = {}, options?: CallOptions): Promise<HcListResult> {
    return this.call<HcListResult>("terminal.list", { ...params }, options);
  }

  get(terminal: string, options?: CallOptions): Promise<HcTerminal> {
    return this.call<HcTerminal>("terminal.get", { terminal }, options);
  }

  /** Pastes `text` and presses Enter once any human draft has been sent or has
   * been idle 60 s, else after ~3 s of quiet, so the default timeout allows both. */
  send(params: HcSendParams, options: CallOptions = {}): Promise<HcSendResult> {
    const waitMs = params.wait ? ((params.timeout ?? 180) + 15) * 1000 : 0;
    return this.call<HcSendResult>("terminal.send", { ...params }, { timeoutMs: options.timeoutMs ?? 75_000 + waitMs });
  }

  keys(terminal: string, keys: string[], options?: CallOptions): Promise<{ turn: number; status?: string | null }> {
    return this.call("terminal.keys", { terminal, keys }, options);
  }

  interrupt(
    terminal: string,
    params: { timeout?: number } = {},
    options: CallOptions = {},
  ): Promise<{ outcome: string; key: string }> {
    return this.call(
      "terminal.interrupt",
      { terminal, ...(params.timeout === undefined ? {} : { timeout: params.timeout }) },
      { timeoutMs: options.timeoutMs ?? ((params.timeout ?? 10) + 10) * 1000 },
    );
  }

  read(terminal: string, params: { lines?: number } = {}, options?: CallOptions): Promise<{ text: string; complete: boolean; how: string }> {
    return this.call("terminal.read", { terminal, ...params }, options);
  }

  /** Opens a raw view of a terminal. Never throws for a missing terminal
   * without an `HcError` carrying the core's kind (`not_found`, `finished`...). */
  async attach(params: HcAttachParams, options: { autoAck?: boolean; timeoutMs?: number } = {}): Promise<HcAttachStream> {
    await this.ensureStarted();
    const connection = this.connection;
    if (!connection) throw new HcError("hc_disconnected", "not connected to herdr-core");
    const generation = connection.generation;
    let created: HcAttachStream | null = null;
    await this.request<{
      channel: number;
      terminal: HcTerminal;
      resize_notifications?: boolean;
      automatic_input?: boolean;
    }>(
      "terminal.attach",
      {
        terminal: params.terminal,
        cols: params.cols,
        rows: params.rows,
        history: params.history ?? 0,
        observe: params.observe ?? false,
        resize_notifications: params.resizeNotifications ?? false,
        resumed: params.resumed ?? false,
      },
      options.timeoutMs ?? this.options.requestTimeoutMs,
      (result) => {
        if (typeof result?.channel !== "number" || result.channel <= 0) {
          throw new HcError("hc_protocol", "terminal.attach returned no channel");
        }
        const hello = this.current.hello;
        const stream = new HcAttachStream({
          channel: result.channel,
          terminal: result.terminal,
          observe: params.observe ?? false,
          automaticInput: result.automatic_input === true && (hello?.features.includes("automatic_input") ?? false),
          resizeNotifications: result.resize_notifications === true,
          autoAck: options.autoAck ?? true,
          send: (frame) => {
            if (this.connection?.generation !== generation) throw new HcError("hc_disconnected", "not connected to herdr-core");
            this.sendFrame(frame);
          },
          release: (channel) => {
            this.streams.delete(channel);
          },
        });
        this.streams.set(result.channel, stream);
        created = stream;
      },
    );
    if (!created) throw new HcError("hc_protocol", "terminal.attach returned no stream");
    return created;
  }

  /** Subscribes to terminal changes for the given labels. Returns the snapshot;
   * later changes arrive as `event`, and a reconnect or `missed` notice as a
   * fresh `snapshot` (resync: true) to reconcile against. */
  subscribe(params: { labels?: Record<string, string> } = {}, resync = false): Promise<HcSnapshot> {
    const labels = params.labels ?? {};
    return (async () => {
      if (!resync) await this.ensureStarted();
      const result = await this.request<{ seq: number; terminals: HcTerminal[]; channel?: number | null }>(
        "events.subscribe",
        { labels },
        this.options.requestTimeoutMs,
        (value) => {
          if (typeof value.channel === "number") {
            this.eventChannel = value.channel;
            this.eventBuffer = "";
          }
          this.watchEventStream();
        },
      );
      // Remembered only once it worked, so the first connect does not re-subscribe.
      this.subscription = { labels };
      const snapshot: HcSnapshot = { seq: result.seq, terminals: result.terminals ?? [], resync };
      this.emit("snapshot", snapshot);
      return snapshot;
    })();
  }

  private watchEventStream(): void {
    this.lastEventAt = Date.now();
    if (this.stallTimer) clearInterval(this.stallTimer);
    const stallMs = this.options.eventStallMs;
    this.stallTimer = setInterval(() => {
      if (Date.now() - this.lastEventAt > stallMs) {
        this.options.log("warn", "herdr-core event stream went silent; reconnecting");
        this.connection?.socket.destroy();
      }
    }, Math.max(250, Math.floor(stallMs / 5)));
    this.stallTimer.unref?.();
  }
}

function describe(error: HcError): { kind: HcErrorKind; message: string; hint: string } {
  return { kind: error.kind, message: error.message, hint: error.hint };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

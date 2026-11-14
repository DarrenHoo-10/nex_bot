// The Agent bridge (plan 3.9): the computer side of Agent mode. It reports the
// Claude and Codex sessions found on this computer, serves transcripts, starts
// and continues sessions inside herdr-core terminals, and relays terminal
// streams, one message at a time over the device link Core already holds.
//
// Lifecycle: DeviceNode builds it, calls `prepare()` before the hello,
// `link()` once Core bound the device, `unlink()` when the socket drops and
// `detach()` on close. herdr-core and its terminals are never stopped here; a
// closed or paused device just stops watching them.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  CLI_ERROR_TEXT,
  CLI_OP_MUTATING,
  CLI_OP_TIMEOUT_MS,
  HERDR_CORE_VERSION,
  MAX_ITEMS_PER_MESSAGE,
  MAX_SEND_TEXT,
  PAGE_SIZE,
  clampTermSize,
  cliRef,
  parseCliOpResult,
  parseCliRef,
  parseCoreCliMessage,
  utf8ByteLength,
  type CliAgentsCapability,
  type CliEngine,
  type CliErrorCode,
  type CliItem,
  type CliOp,
  type CliOpArgs,
  type CliSessionRef,
  type CliSessionWire,
  type CoreCliMessage,
  type DeviceCliMessage,
} from "../../../shared/cli-agents.ts";
import { decodeTermFrame } from "../../../shared/cli-agent-frames.ts";
import { HookError, HookServer, TurnTracker, locateHookPlugin } from "./hooks.ts";
import { SessionDiscovery, type SessionDiscoveryOptions, type SessionsDiff } from "./discovery.ts";
import {
  HerdrCore,
  locateHerdrCore,
  type HcAttachParams,
  type HcEvent,
  type HcListResult,
  type HcRunParams,
  type HcSendParams,
  type HcSendResult,
  type HcSnapshot,
  type HcState,
  type HcTerminal,
} from "./hc.ts";
import { LaunchError, PENDING_NATIVE_ID, clearCliCache, cliVersion, launchEnv, planLaunch, resolveCli, terminalName } from "./launch.ts";
import { CliLocalStore, type StoredReply } from "./local-store.ts";
import { OpenLocalError, openLocal, type OpenLocalPlan } from "./open-local.ts";
import { TranscriptReader } from "./reader.ts";
import { TermStreams, hcErrorCode, type TermStream } from "./streams.ts";

/** What the bridge needs from herdr-core. `HerdrCore` is one; tests pass a fake. */
export interface HcLike {
  ensureStarted(): Promise<void>;
  close(): void;
  state(): HcState;
  run(params: HcRunParams): Promise<HcTerminal>;
  list(params?: { all?: boolean; labels?: Record<string, string> }): Promise<HcListResult>;
  get(terminal: string): Promise<HcTerminal>;
  read(terminal: string, params?: { lines?: number }): Promise<{ text: string }>;
  /** `send` that fails with kind `hc_draft` instead of merging into a local draft */
  sendGuarded(params: HcSendParams): Promise<HcSendResult>;
  interrupt(terminal: string, params?: { timeout?: number }): Promise<{ outcome: string }>;
  attach(params: HcAttachParams, options?: { autoAck?: boolean }): Promise<TermStream>;
  subscribe(params?: { labels?: Record<string, string> }): Promise<HcSnapshot>;
  on(event: "event", listener: (event: HcEvent) => void): unknown;
  on(event: "snapshot", listener: (snapshot: HcSnapshot) => void): unknown;
  on(event: "state", listener: (state: HcState) => void): unknown;
}

/** Where messages to Core go. Both return false when the socket is not open. */
export interface BridgeLink {
  json(message: DeviceCliMessage): boolean;
  binary(frame: Uint8Array): boolean;
}

export interface HcScope {
  session: string;
  socket: string;
  binary: string | null;
}

export interface CliAgentBridgeOptions {
  /** Data directory: `cli-agents.db` and `attach-<address>.cmd` live here. */
  dir: string;
  /** An herdr-core client, or a factory given the session, socket and binary. Default: the real one. */
  hc?: HcLike | ((scope: HcScope) => HcLike);
  /** Path of herdr-core; null means "not installed". Default: locateHerdrCore(). */
  binary?: string | null;
  claudeDirs?: string[];
  codexHomes?: string[];
  discovery?: Partial<SessionDiscoveryOptions>;
  resolveCli?: (engine: CliEngine) => Promise<string | null>;
  cliVersion?: (file: string) => Promise<string | null>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  launcher?: (plan: OpenLocalPlan) => Promise<void>;
  hasWindowsTerminal?: boolean;
  log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  /** How long a new Codex terminal may wait for its session file. Default 10 minutes. */
  codexClaimMs?: number;
  /** After continuing a Codex session without a lock file: how long an immediate exit counts as "open elsewhere". Default 5 s. */
  settleMs?: number;
  /** How long start/continue wait for the new session to show up in the list. Default 5 s. */
  rowWaitMs?: number;
  readerPollMs?: number;
  coalesceMs?: number;
  /** nex_bot's Claude plugin (permission prompts, questions, turn ends). Default: locateHookPlugin(); null turns hooks off. */
  pluginDir?: string | null;
  /** The Node runtime the hooks run with. Default: this process (the Electron executor runs it as Node). */
  hookNode?: string;
  /** How long a Claude session must stay idle before the status fallback reports a turn end. Default 3 s. */
  turnFallbackMs?: number;
  /** Directory of the hook socket on Unix and the open request lifetime; tests override them. */
  hookSocketDir?: string;
  hookTtlMs?: number;
}

class OpFailure extends Error {
  constructor(readonly code: CliErrorCode, message?: string) {
    super(message ?? CLI_ERROR_TEXT[code]);
  }
}

interface TerminalInfo {
  address: string;
  engine: CliEngine;
  /** null while a new Codex session has not been matched to its file */
  nativeId: string | null;
  cwd: string;
  registeredAt: number;
  /** herdr-core has listed it at least once, so a later absence means it ended */
  seen: boolean;
}

interface PendingClaim {
  address: string;
  cwd: string;
  launchedAt: number;
  known: Set<string>;
  waiter?: (ref: CliSessionRef | null) => void;
}

interface Watch {
  ref: CliSessionRef;
  engine: CliEngine;
  reader: TranscriptReader | null;
}

const HC_LABELS = { nexbot: "1" } as const;
/** herdr-core events after which the list of terminals may differ; status, title and size do not matter here */
const TERMINAL_CHANGES = new Set(["created", "lost", "restarted", "finished", "removed"]);
const REGISTER_GRACE_MS = 5000;
const REPLY_RESULT_LIMIT = 900_000;
const ITEMS_MESSAGE_BYTES = 1024 * 1024;

const normalizeDir = (dir: string, platform: NodeJS.Platform): string => {
  const resolved = (platform === "win32" ? path.win32 : path.posix).resolve(dir).replace(/[\\/]+$/, "");
  return platform === "win32" ? resolved.toLowerCase() : resolved;
};

export class CliAgentBridge {
  private readonly platform: NodeJS.Platform;
  private readonly store: CliLocalStore;
  private readonly discovery: SessionDiscovery;
  private readonly streams: TermStreams;
  private readonly watches = new Map<string, Watch>();
  private readonly terminals = new Map<string, TerminalInfo>();
  private readonly pending: PendingClaim[] = [];
  private readonly inflight = new Map<string, Promise<StoredReply>>();
  private readonly busyRefs = new Set<string>();
  private readonly tasks = new Set<Promise<unknown>>();
  private engines: Array<{ engine: CliEngine; version: string | null }> = [];
  private prepared: Promise<void> | null = null;
  private scope: { origin: string; workspaceId: string } = { origin: "local", workspaceId: "local" };
  private hc: HcLike | null = null;
  private hcScope: HcScope | null = null;
  private hcStatus: "starting" | "ready" | "error" = "starting";
  private hcError = "";
  private hcWired = false;
  private warming: Promise<void> | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing = false;
  private refreshAgain = false;
  private expiryTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private link_: BridgeLink | null = null;
  private seq = 0;
  private discoveryStarted = false;
  private detached = false;
  private hooks: HookServer | null = null;
  private hooksStarting: Promise<HookServer | null> | null = null;
  private pluginDir: string | null | undefined;
  private readonly turns: TurnTracker;
  private readonly states = new Map<string, CliSessionWire["state"]>();
  private readonly fallbackTimers = new Map<string, NodeJS.Timeout>();
  private readonly codexTails = new Map<string, TranscriptReader>();

  constructor(private readonly options: CliAgentBridgeOptions) {
    this.platform = options.platform ?? process.platform;
    this.store = new CliLocalStore(path.join(options.dir, "cli-agents.db"));
    this.turns = new TurnTracker((message) => this.sendJson(message));
    this.discovery = new SessionDiscovery({
      ...(options.claudeDirs ? { claudeDirs: options.claudeDirs } : {}),
      ...(options.codexHomes ? { codexHomes: options.codexHomes } : {}),
      ...options.discovery,
      nexbotTerminals: () => this.nexbotTerminals(),
      onChange: (diff) => this.onDiscovery(diff),
      onError: (error) => this.log("warn", `scan failed: ${String(error)}`),
    });
    this.streams = new TermStreams({
      attach: async (params) => {
        const hc = await this.requireHc();
        return hc.attach({ ...params, resizeNotifications: params.observe }, { autoAck: false });
      },
      send: (message) => this.sendJson(message),
      sendBinary: (frame) => void this.link_?.binary(frame),
      onExited: (address, exitCode) => this.terminalEnded(address, exitCode),
      errorCode: hcErrorCode,
      log: (message) => this.log("debug", message),
      ...(options.coalesceMs === undefined ? {} : { coalesceMs: options.coalesceMs }),
    });
  }

  // -- what the device tells Core about itself ---------------------------------

  /** Finds the installed CLIs. Call before the hello so `capability()` is accurate; it never throws. */
  prepare(): Promise<void> {
    this.prepared ??= (async () => {
      const find = this.options.resolveCli ?? ((engine: CliEngine) => resolveCli(engine, { platform: this.platform, ...(this.options.env ? { env: this.options.env } : {}) }));
      const version = this.options.cliVersion ?? ((file: string) => cliVersion(file, { platform: this.platform, timeoutMs: 3000, ...(this.options.env ? { env: this.options.env } : {}) }));
      const found: Array<{ engine: CliEngine; version: string | null }> = [];
      await Promise.all(
        (["claude", "codex"] as const).map(async (engine) => {
          try {
            const file = await find(engine);
            if (file) found.push({ engine, version: await version(file).catch(() => null) });
          } catch (error) {
            this.log("warn", `looking for ${engine} failed: ${String(error)}`);
          }
        }),
      );
      this.engines = found.sort((a, b) => a.engine.localeCompare(b.engine));
    })();
    return this.prepared;
  }

  capability(): CliAgentsCapability {
    const available = this.binaryPath() !== null || this.options.hc !== undefined;
    return {
      version: 1,
      engines: this.engines.map((entry) => entry.engine),
      terminal: {
        name: "herdr-core",
        version: HERDR_CORE_VERSION,
        ready: available,
        ...(available ? {} : { error: CLI_ERROR_TEXT.hc_unavailable }),
      },
    };
  }

  /** For the client UI. */
  state(): { hc: "starting" | "ready" | "error"; hcError: string; engines: Array<{ engine: CliEngine; version: string | null }> } {
    const available = this.binaryPath() !== null || this.options.hc !== undefined;
    return { hc: available ? this.hcStatus : "error", hcError: available ? this.hcError : CLI_ERROR_TEXT.hc_unavailable, engines: this.engines.map((entry) => ({ ...entry })) };
  }

  /** The herdr-core session follows the Core and workspace this device belongs to. Call before `link()`. */
  setScope(origin: string, workspaceId: string): void {
    if (this.scope.origin === origin && this.scope.workspaceId === workspaceId) return;
    this.scope = { origin, workspaceId };
    if (this.hc && this.hcScope) {
      const next = this.scopeFor();
      if (next.session !== this.hcScope.session) this.dropHc();
    }
  }

  // -- the link to Core ----------------------------------------------------------

  /** Core accepted the device: report every session and start watching terminals. */
  link(link: BridgeLink): void {
    if (this.detached) return;
    this.link_ = link;
    this.seq = 0;
    this.resync();
    void this.warm();
    // The hook listener comes up with the link, so terminals that survived a client restart keep forwarding.
    void this.ensureHooks();
  }

  /** The socket dropped. Streams and watches die with it (Core re-opens what it needs); scanning and herdr-core carry on. */
  unlink(): void {
    this.link_ = null;
    this.streams.closeAll("link_lost");
    this.closeWatches();
    this.hooks?.linkLost();
  }

  /** Core asked for the whole list again, or the link was just re-established. */
  resync(): void {
    if (this.detached) return;
    if (!this.discoveryStarted) {
      this.discoveryStarted = true;
      void this.discovery.start().catch((error) => this.log("warn", `discovery failed: ${String(error)}`));
    } else {
      this.discovery.resync();
    }
  }

  /** Closes the bridge for good: streams, watches, scanning and the herdr-core connection. Terminals keep running. */
  async detach(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    this.link_ = null;
    this.streams.closeAll("detached");
    this.closeWatches();
    this.discovery.stop();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.refreshTimer = this.expiryTimer = this.graceTimer = null;
    for (const timer of this.fallbackTimers.values()) clearTimeout(timer);
    this.fallbackTimers.clear();
    for (const reader of this.codexTails.values()) reader.close();
    this.codexTails.clear();
    const hooks = this.hooks;
    this.hooks = null;
    if (hooks) this.track(hooks.close());
    for (const claim of this.pending.splice(0)) claim.waiter?.(null);
    this.dropHc();
    await Promise.race([Promise.allSettled(this.tasks), new Promise((resolve) => setTimeout(resolve, 2000).unref?.())]);
    this.store.close();
  }

  // -- messages from Core ----------------------------------------------------------

  /** A parsed `cli.*` JSON message from Core. Never throws. */
  handle(raw: unknown): void {
    if (this.detached) return;
    const message = parseCoreCliMessage(raw);
    if (!message) {
      const loose = raw as { type?: unknown; opId?: unknown };
      if (loose && loose.type === "cli.op" && typeof loose.opId === "string") this.sendReply(loose.opId, { ok: false, error: { code: "invalid" } });
      else this.log("warn", "dropped an invalid cli message from Core");
      return;
    }
    switch (message.type) {
      case "cli.resync":
        this.resync();
        return;
      case "cli.op":
        this.track(this.runOp(message));
        return;
      case "cli.term.open":
        this.track(this.openStream(message));
        return;
      case "cli.term.resize":
        this.streams.resize(message.sid, message.cols, message.rows);
        return;
      case "cli.term.credit":
        this.streams.credit(message.sid, message.bytes);
        return;
      case "cli.term.close":
        this.streams.close(message.sid);
        return;
    }
  }

  /** A binary DCP frame from Core: terminal input. */
  binary(frame: Uint8Array): void {
    if (this.detached) return;
    if (!decodeTermFrame(frame)) {
      this.log("warn", "dropped an invalid terminal frame from Core");
      return;
    }
    this.streams.input(frame);
  }

  // -- test and status helpers ---------------------------------------------------------

  /** Sessions as last computed. */
  sessions(): CliSessionWire[] {
    return this.discovery.snapshot();
  }

  /** Scans now and reports the difference at once. */
  refreshSessions(): Promise<void> {
    return this.discovery.refresh({ flush: true });
  }

  streamCount(): number {
    return this.streams.count;
  }

  // -- internals: plumbing --------------------------------------------------------------

  private log(level: "debug" | "info" | "warn" | "error", message: string): void {
    try {
      this.options.log?.(level, message);
    } catch {
      // logging must not break the bridge
    }
  }

  private track<T>(promise: Promise<T>): void {
    const task = promise.catch((error) => this.log("error", `unexpected failure: ${String(error)}`));
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  private sendJson(message: DeviceCliMessage): boolean {
    return this.link_?.json(message) ?? false;
  }

  private sendReply(opId: string, reply: StoredReply): void {
    this.sendJson({
      type: "cli.reply",
      opId,
      ok: reply.ok,
      ...(reply.ok ? { result: reply.result ?? {} } : { error: reply.error as { code: CliErrorCode; message?: string } }),
    });
  }

  private onDiscovery(diff: SessionsDiff): void {
    if (this.link_) {
      this.sendJson({ type: "cli.sessions", full: diff.full, upserts: diff.upserts, removes: diff.removes, seq: ++this.seq });
    }
    this.tryClaims();
    this.track(this.startWaitingWatches());
    this.observeTurns(diff);
  }

  // -- internals: turn ends ---------------------------------------------------------------------

  /** Claude: a nex_bot session that was running and stays idle reports a turn end, in case no Stop hook did.
   * Codex: the session file tells (see `syncCodexTails`). */
  private observeTurns(diff: SessionsDiff): void {
    for (const ref of diff.removes) this.dropObserved(ref);
    const mine = this.nexbotTerminals();
    for (const row of diff.upserts) {
      if (row.engine !== "claude") continue;
      const ref = cliRef("claude", row.nativeId);
      const before = this.states.get(ref);
      this.states.set(ref, row.state);
      if (row.state === "running") this.cancelFallback(ref);
      else if (before === "running" && row.state === "idle" && mine.has(ref)) this.armFallback(ref);
      else if (row.state === "stopped") this.cancelFallback(ref);
    }
    this.syncCodexTails(mine);
  }

  private dropObserved(ref: string): void {
    this.states.delete(ref);
    this.cancelFallback(ref);
    this.codexTails.get(ref)?.close();
    this.codexTails.delete(ref);
  }

  private cancelFallback(ref: string): void {
    const timer = this.fallbackTimers.get(ref);
    if (timer) clearTimeout(timer);
    this.fallbackTimers.delete(ref);
  }

  private armFallback(ref: CliSessionRef): void {
    if (this.detached || this.fallbackTimers.has(ref)) return;
    const timer = setTimeout(() => {
      this.fallbackTimers.delete(ref);
      if (this.detached || this.discovery.get(ref)?.state !== "idle") return;
      this.turns.report(ref, "end", "status");
    }, this.options.turnFallbackMs ?? 3000);
    timer.unref?.();
    this.fallbackTimers.set(ref, timer);
  }

  /** Follows the rollout of every Codex session in a nex_bot terminal for its turn ends and aborts. */
  private syncCodexTails(mine: ReadonlyMap<string, string>): void {
    for (const [ref, reader] of Array.from(this.codexTails)) {
      if (mine.has(ref)) continue;
      reader.close();
      this.codexTails.delete(ref);
    }
    for (const ref of mine.keys()) {
      if (!ref.startsWith("codex:") || this.codexTails.has(ref)) continue;
      const file = this.discovery.transcriptFor(ref);
      if (!file) continue;
      const reader = new TranscriptReader({
        path: file,
        engine: "codex",
        onItems: (items) => {
          for (const item of items) {
            if (item.kind !== "turn" || item.phase === "started") continue;
            this.turns.report(ref as CliSessionRef, item.phase === "aborted" ? "interrupted" : "end", "codex", { endedAt: item.ts });
          }
        },
        ...(this.options.readerPollMs === undefined ? {} : { pollMs: this.options.readerPollMs }),
      });
      this.codexTails.set(ref, reader);
      this.track(
        reader.start().then(
          () => undefined,
          (error) => {
            this.log("warn", `following ${ref} for turn ends failed: ${String(error)}`);
            if (this.codexTails.get(ref) === reader) this.codexTails.delete(ref);
            reader.close();
          },
        ),
      );
    }
  }

  // -- internals: Claude hooks ------------------------------------------------------------------

  /** The hook listener, started on first use. Null when hooks are off, there is no plugin, or the listener cannot start. */
  private ensureHooks(): Promise<HookServer | null> {
    if (this.detached) return Promise.resolve(null);
    if (this.hooks) return Promise.resolve(this.hooks);
    this.hooksStarting ??= (async () => {
      try {
        if (this.pluginDir === undefined) this.pluginDir = this.options.pluginDir === undefined ? locateHookPlugin(this.options.env ? { env: this.options.env } : {}) : this.options.pluginDir;
        if (!this.pluginDir) return null;
        const server = new HookServer({
          dir: this.options.dir,
          emit: (message) => this.sendJson(message),
          turns: this.turns,
          active: () => this.link_ !== null && !this.detached,
          isLive: (ref) => this.nexbotTerminals().has(ref),
          platform: this.platform,
          ...(this.options.hookSocketDir ? { socketDir: this.options.hookSocketDir } : {}),
          ...(this.options.hookTtlMs ? { ttlMs: this.options.hookTtlMs } : {}),
          log: (level, message) => this.log(level, message),
        });
        await server.start();
        if (this.detached) {
          await server.close();
          return null;
        }
        this.hooks = server;
        return server;
      } catch (error) {
        this.log("warn", `the Claude hooks are off: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      } finally {
        this.hooksStarting = null;
      }
    })();
    return this.hooksStarting;
  }

  /** What `planLaunch` needs to hook a Claude terminal of this session; undefined when hooks are unavailable. */
  private async hookLaunch(nativeId: string): Promise<{ pluginDir: string; node: string; pipe: string; token: string } | undefined> {
    const server = await this.ensureHooks();
    if (!server || !this.pluginDir) return undefined;
    const ref = cliRef("claude", nativeId);
    return { pluginDir: this.pluginDir, node: this.options.hookNode ?? process.execPath, pipe: server.pipe, token: server.tokenFor(ref) };
  }

  // -- internals: herdr-core ---------------------------------------------------------------

  private binaryPath(): string | null {
    if (this.options.binary !== undefined) return this.options.binary;
    return locateHerdrCore(this.options.env ? { env: this.options.env } : {});
  }

  private scopeFor(): HcScope {
    const hash = createHash("sha256").update(`${this.scope.origin}\n${this.scope.workspaceId}`).digest("hex").slice(0, 8);
    const win = this.platform === "win32";
    return {
      session: `nexbot-${hash}`,
      socket: win ? `\\\\.\\pipe\\nexbot-hc-${hash}` : path.join(os.tmpdir(), `nexbot-hc-${hash}.sock`),
      // a backslash path on Windows: herdr-core derives paths from its own, and forward slashes break them
      binary: (() => {
        const binary = this.binaryPath();
        return binary ? path.resolve(binary) : null;
      })(),
    };
  }

  private getHc(): HcLike | null {
    if (this.hc) return this.hc;
    const scope = this.scopeFor();
    const configured = this.options.hc;
    if (!configured && !scope.binary) return null;
    this.hcScope = scope;
    if (typeof configured === "function") this.hc = configured(scope);
    else if (configured) this.hc = configured;
    else {
      this.hc = new HerdrCore({
        binary: scope.binary as string,
        session: scope.session,
        socket: scope.socket,
        log: (level, message) => this.log(level, `herdr-core: ${message}`),
      }) as unknown as HcLike;
    }
    this.hcWired = false;
    return this.hc;
  }

  private dropHc(): void {
    const hc = this.hc;
    this.hc = null;
    this.hcWired = false;
    this.warming = null;
    this.hcStatus = "starting";
    try {
      hc?.close();
    } catch {
      // closing a broken connection
    }
  }

  /** The connected herdr-core client, or an OpFailure with the reason. */
  private async requireHc(): Promise<HcLike> {
    const hc = this.getHc();
    if (!hc) throw new OpFailure("hc_unavailable");
    try {
      await hc.ensureStarted();
    } catch (error) {
      this.hcStatus = "error";
      this.hcError = error instanceof Error ? error.message : String(error);
      const code = hcErrorCode(error);
      throw new OpFailure(code === "unknown" ? "hc_unavailable" : code, CLI_ERROR_TEXT[code === "unknown" ? "hc_unavailable" : code]);
    }
    this.hcStatus = "ready";
    this.hcError = "";
    if (!this.hcWired) this.wireHc(hc);
    return hc;
  }

  private wireHc(hc: HcLike): void {
    this.hcWired = true;
    hc.on("snapshot", (snapshot) => this.applyTerminals(snapshot.terminals));
    hc.on("event", (event) => {
      if (TERMINAL_CHANGES.has(event.type)) this.scheduleRefresh();
    });
    hc.on("state", (state) => {
      if (state.status === "ready") {
        this.hcStatus = "ready";
        this.hcError = "";
      } else if (state.status === "unavailable" || state.status === "incompatible") {
        this.hcStatus = "error";
        this.hcError = state.lastError?.message ?? "";
      }
    });
    void hc.subscribe({ labels: { ...HC_LABELS } }).catch((error) => this.log("warn", `subscribing to terminals failed: ${String(error)}`));
  }

  /** Brings herdr-core up in the background and learns which terminals are ours. */
  private warm(): Promise<void> {
    this.warming ??= (async () => {
      try {
        await this.requireHc();
        await this.refreshTerminals();
      } catch (error) {
        this.log("warn", `herdr-core is not ready: ${error instanceof Error ? error.message : String(error)}`);
        this.warming = null;
      }
    })();
    return this.warming;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer || this.detached) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.track(this.refreshTerminals());
    }, 50);
    this.refreshTimer.unref?.();
  }

  /** A terminal that is not listed yet may still be registering; look again once its grace is over. */
  private scheduleGraceCheck(ms: number): void {
    if (this.graceTimer || this.detached) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.track(this.refreshTerminals());
    }, ms);
    this.graceTimer.unref?.();
  }

  private async refreshTerminals(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        const hc = this.getHc();
        if (!hc || this.detached) return;
        const list = await hc.list({ labels: { ...HC_LABELS } });
        this.applyTerminals(list.terminals);
      } while (this.refreshAgain);
    } catch (error) {
      this.log("debug", `listing terminals failed: ${String(error)}`);
    } finally {
      this.refreshing = false;
    }
  }

  /** The live nex_bot terminals herdr-core reports: rebuilds the map, notes the ones that ended. */
  private applyTerminals(terminals: HcTerminal[]): void {
    if (this.detached) return;
    const live = new Set<string>();
    const now = Date.now();
    for (const terminal of terminals) {
      if (terminal.state !== "live") continue;
      const labels = terminal.labels ?? {};
      if (labels.nexbot !== "1") continue;
      const engine = labels["nexbot.engine"];
      if (engine !== "claude" && engine !== "codex") continue;
      live.add(terminal.address);
      let nativeId: string | null = labels["nexbot.native"] ?? null;
      const known = this.terminals.get(terminal.address);
      if (!nativeId || nativeId === PENDING_NATIVE_ID) {
        const stored = this.store.terminal(terminal.address)?.nativeId;
        nativeId = known?.nativeId ?? (stored && stored !== PENDING_NATIVE_ID ? stored : null);
      }
      const info: TerminalInfo = { address: terminal.address, engine, nativeId, cwd: terminal.cwd, registeredAt: known?.registeredAt ?? 0, seen: true };
      this.terminals.set(terminal.address, info);
      if (!this.store.terminal(terminal.address)) {
        this.store.upsertTerminal({ address: terminal.address, engine, nativeId: nativeId ?? PENDING_NATIVE_ID, cwd: terminal.cwd });
      }
    }
    for (const [address, info] of Array.from(this.terminals)) {
      if (live.has(address)) continue;
      if (!info.seen && now - info.registeredAt < REGISTER_GRACE_MS) {
        this.scheduleGraceCheck(REGISTER_GRACE_MS - (now - info.registeredAt) + 50);
        continue;
      }
      this.terminals.delete(address);
      this.store.endTerminal(address);
    }
    for (const row of this.store.openTerminals()) {
      if (!live.has(row.address) && !this.terminals.has(row.address)) this.store.endTerminal(row.address);
    }
    this.discovery.reapply({ flush: true });
    this.tryClaims();
  }

  private nexbotTerminals(): Map<string, string> {
    const map = new Map<string, string>();
    for (const info of this.terminals.values()) {
      if (!info.nativeId) continue;
      try {
        map.set(cliRef(info.engine, info.nativeId), info.address);
      } catch {
        // a native id that is no valid ref is not a session we can show
      }
    }
    return map;
  }

  private addressFor(ref: string): string | null {
    return this.nexbotTerminals().get(ref) ?? null;
  }

  private terminalEnded(address: string, exitCode: number | undefined): void {
    this.store.endTerminal(address, exitCode ?? null);
    this.terminals.delete(address);
    this.discovery.reapply({ flush: true });
    this.scheduleRefresh();
  }

  // -- internals: Codex session matching (plan 3.5) -------------------------------------------

  private tryClaims(): void {
    if (this.pending.length === 0) return;
    const now = Date.now();
    const limit = this.options.codexClaimMs ?? 10 * 60_000;
    const mapped = new Set(this.nexbotTerminals().keys());
    const rows = this.discovery.snapshot().filter((row) => row.engine === "codex");
    let changed = false;
    for (const claim of [...this.pending].sort((a, b) => a.launchedAt - b.launchedAt)) {
      if (!this.terminals.has(claim.address)) {
        this.removePending(claim, null);
        continue;
      }
      if (now - claim.launchedAt > limit) {
        this.removePending(claim, null);
        continue;
      }
      const cwd = normalizeDir(claim.cwd, this.platform);
      const candidates = rows
        .filter((row) => {
          const ref = cliRef("codex", row.nativeId);
          if (mapped.has(ref) || claim.known.has(ref)) return false;
          if (row.liveIn === "desktop" || row.liveIn === "nexbot") return false;
          if (row.lastActivityAt < claim.launchedAt - 2000) return false;
          return normalizeDir(row.cwd, this.platform) === cwd;
        })
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
      const chosen = candidates[0];
      if (!chosen) continue;
      const ref = cliRef("codex", chosen.nativeId);
      const info = this.terminals.get(claim.address);
      if (info) info.nativeId = chosen.nativeId;
      this.store.setNativeId(claim.address, chosen.nativeId);
      mapped.add(ref);
      this.removePending(claim, ref);
      changed = true;
    }
    if (changed) this.discovery.reapply({ flush: true });
  }

  private removePending(claim: PendingClaim, ref: CliSessionRef | null): void {
    const index = this.pending.indexOf(claim);
    if (index >= 0) this.pending.splice(index, 1);
    claim.waiter?.(ref);
  }

  private waitClaim(claim: PendingClaim, ms: number): Promise<CliSessionRef | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        claim.waiter = undefined;
        resolve(null);
      }, Math.max(0, ms));
      timer.unref?.();
      claim.waiter = (ref) => {
        clearTimeout(timer);
        claim.waiter = undefined;
        resolve(ref);
      };
      this.tryClaims();
      if (!this.pending.includes(claim)) {
        // claimed (or dropped) during the first look; the waiter ran already
      }
    });
  }

  // -- internals: watching transcripts -----------------------------------------------------------

  private closeWatches(): void {
    for (const watch of this.watches.values()) watch.reader?.close();
    this.watches.clear();
  }

  private sendItems(ref: CliSessionRef, items: CliItem[], options: { reset?: boolean; more?: boolean } = {}): void {
    if (!this.link_) return;
    const messages: CliItem[][] = [];
    let batch: CliItem[] = [];
    let bytes = 0;
    for (const item of items) {
      const size = JSON.stringify(item).length;
      if (batch.length > 0 && (batch.length >= MAX_ITEMS_PER_MESSAGE || bytes + size > ITEMS_MESSAGE_BYTES)) {
        messages.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(item);
      bytes += size;
    }
    if (batch.length > 0 || options.reset) messages.push(batch);
    messages.forEach((chunk, index) => {
      this.sendJson({
        type: "cli.items",
        ref,
        items: chunk,
        ...(options.reset && index === 0 ? { reset: true } : {}),
        ...(options.more && index === 0 ? { more: true } : {}),
      });
    });
  }

  private async startWatch(watch: Watch): Promise<void> {
    if (watch.reader) return;
    const file = this.discovery.transcriptFor(watch.ref);
    if (!file) return;
    const reader = new TranscriptReader({
      path: file,
      engine: watch.engine,
      onItems: (items) => this.sendItems(watch.ref, items),
      onReset: (page) => this.sendItems(watch.ref, page.items, { reset: true, more: page.more }),
      ...(this.options.readerPollMs === undefined ? {} : { pollMs: this.options.readerPollMs }),
    });
    watch.reader = reader;
    const page = await reader.start();
    if (this.watches.get(watch.ref) !== watch) {
      reader.close();
      return;
    }
    this.sendItems(watch.ref, page.items, { reset: true, more: page.more });
  }

  private async startWaitingWatches(): Promise<void> {
    for (const watch of Array.from(this.watches.values())) {
      if (!watch.reader) await this.startWatch(watch).catch((error) => this.log("warn", `watch failed: ${String(error)}`));
    }
  }

  // -- internals: operations --------------------------------------------------------------------

  private async runOp(message: Extract<CoreCliMessage, { type: "cli.op" }>): Promise<void> {
    const { opId } = message;
    const running = this.inflight.get(opId);
    if (running) {
      this.sendReply(opId, await running);
      return;
    }
    const work = this.execute(message);
    this.inflight.set(opId, work);
    try {
      this.sendReply(opId, await work);
    } finally {
      this.inflight.delete(opId);
    }
  }

  private async execute(message: Extract<CoreCliMessage, { type: "cli.op" }>): Promise<StoredReply> {
    const { opId, op } = message;
    const mutating = CLI_OP_MUTATING.has(op);
    if (mutating) {
      const entry = this.store.beginOp(opId, op);
      if (entry.state === "done") return entry.reply;
      if (entry.state === "running") return { ok: false, error: { code: "unknown", message: CLI_ERROR_TEXT.unknown } };
    }
    let reply: StoredReply;
    try {
      const budget = Math.max(1000, Math.min(message.deadlineMs, CLI_OP_TIMEOUT_MS[op]) - 300);
      const result = await withDeadline(this.perform(message, budget), budget);
      const checked = parseCliOpResult(op, result);
      if (!checked) throw new OpFailure("unknown", "the device produced an unusable result");
      reply = { ok: true, result: checked as Record<string, unknown> };
      if (JSON.stringify(reply).length > REPLY_RESULT_LIMIT) reply = { ok: false, error: { code: "too_large", message: CLI_ERROR_TEXT.too_large } };
    } catch (error) {
      reply = { ok: false, error: this.failure(error) };
      if (!(error instanceof OpFailure) && !(error instanceof DeadlineError)) this.log("warn", `${op} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (mutating) this.store.finishOp(opId, reply);
    return reply;
  }

  private failure(error: unknown): { code: CliErrorCode; message: string } {
    if (error instanceof OpFailure) return { code: error.code, message: error.message };
    if (error instanceof DeadlineError) return { code: "unknown", message: CLI_ERROR_TEXT.unknown };
    if (error instanceof LaunchError) {
      const code: CliErrorCode = error.kind === "invalid_cwd" ? "cwd_missing" : error.kind === "cli_not_found" ? "cli_missing" : "invalid";
      return { code, message: CLI_ERROR_TEXT[code] };
    }
    if (error instanceof OpenLocalError) return { code: error.code, message: error.message.slice(0, 200) };
    const code = hcErrorCode(error);
    return { code, message: CLI_ERROR_TEXT[code] };
  }

  private async perform(message: Extract<CoreCliMessage, { type: "cli.op" }>, budget: number): Promise<unknown> {
    const args = message.args as CliOpArgs[CliOp];
    switch (message.op) {
      case "read":
        return this.opRead(args as CliOpArgs["read"]);
      case "watch":
        return this.opWatch(args as CliOpArgs["watch"]);
      case "unwatch":
        return this.opUnwatch(args as CliOpArgs["unwatch"]);
      case "start":
        return this.opStart(args as CliOpArgs["start"], budget);
      case "continue":
        return this.exclusive((args as CliOpArgs["continue"]).ref, () => this.opContinue(args as CliOpArgs["continue"], budget));
      case "send":
        return this.exclusive((args as CliOpArgs["send"]).ref, () => this.opSend(args as CliOpArgs["send"]));
      case "interrupt":
        return this.exclusive((args as CliOpArgs["interrupt"]).ref, () => this.opInterrupt(args as CliOpArgs["interrupt"]));
      case "open_local":
        return this.exclusive((args as CliOpArgs["open_local"]).ref, () => this.opOpenLocal(args as CliOpArgs["open_local"]));
      case "answer":
        return this.opAnswer(args as CliOpArgs["answer"]);
      default:
        throw new OpFailure("invalid", "this operation is not available on this computer yet");
    }
  }

  private async exclusive<T>(ref: string, work: () => Promise<T>): Promise<T> {
    if (this.busyRefs.has(ref)) throw new OpFailure("busy");
    this.busyRefs.add(ref);
    try {
      return await work();
    } finally {
      this.busyRefs.delete(ref);
    }
  }

  private session(ref: CliSessionRef): CliSessionWire {
    const row = this.discovery.get(ref);
    if (!row) throw new OpFailure("not_found");
    return row;
  }

  private async opRead(args: CliOpArgs["read"]): Promise<{ items: CliItem[]; more: boolean }> {
    const row = this.session(args.ref);
    const file = this.discovery.transcriptFor(args.ref);
    if (!file) return { items: [], more: false };
    const limit = args.limit ?? PAGE_SIZE;
    const live = this.watches.get(args.ref)?.reader;
    if (live) return live.page({ before: args.before, limit });
    const reader = new TranscriptReader({ path: file, engine: row.engine, watch: false });
    try {
      return await reader.page({ before: args.before, limit });
    } finally {
      reader.close();
    }
  }

  private async opWatch(args: CliOpArgs["watch"]): Promise<Record<string, never>> {
    const row = this.session(args.ref);
    const existing = this.watches.get(args.ref);
    if (existing?.reader) {
      // Core asks again after a reconnect: send the newest page once more
      const page = await existing.reader.page({ limit: PAGE_SIZE });
      this.sendItems(args.ref, page.items, { reset: true, more: page.more });
      return {};
    }
    const watch: Watch = existing ?? { ref: args.ref, engine: row.engine, reader: null };
    this.watches.set(args.ref, watch);
    await this.startWatch(watch);
    return {};
  }

  private opUnwatch(args: CliOpArgs["unwatch"]): Record<string, never> {
    const watch = this.watches.get(args.ref);
    watch?.reader?.close();
    this.watches.delete(args.ref);
    return {};
  }

  private async cliPath(engine: CliEngine): Promise<string> {
    const find = this.options.resolveCli ?? ((name: CliEngine) => resolveCli(name, { platform: this.platform, ...(this.options.env ? { env: this.options.env } : {}) }));
    let file = await find(engine);
    if (!file && !this.options.resolveCli) {
      clearCliCache();
      file = await find(engine);
    }
    if (!file) throw new OpFailure("cli_missing");
    return file;
  }

  private launchEnvironment(engine: CliEngine, configDir: string | undefined): Record<string, string> {
    const homedir = this.options.homedir ?? os.homedir();
    const env = launchEnv(engine, { platform: this.platform, homedir, ...(this.options.env ? { env: this.options.env } : {}) });
    if (configDir) {
      const variable = engine === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
      const fallback = path.join(homedir, engine === "claude" ? ".claude" : ".codex");
      if (normalizeDir(configDir, this.platform) !== normalizeDir(fallback, this.platform)) env[variable] = configDir;
    }
    return env;
  }

  /** Runs the planned terminal; a taken name gets one retry with a fresh one. */
  private async runTerminal(
    hc: HcLike,
    engine: CliEngine,
    plan: { argv: string[]; cwd: string; env: Record<string, string>; name: string; labels: Record<string, string> },
    size: { cols: number; rows: number },
  ): Promise<HcTerminal> {
    const params: HcRunParams = { argv: plan.argv, cwd: plan.cwd, env: plan.env, name: plan.name, labels: plan.labels, size, keep: false };
    try {
      return await hc.run(params);
    } catch (error) {
      if ((error as { kind?: string }).kind !== "name_taken") throw error;
      return hc.run({ ...params, name: terminalName(engine, randomBytes(4).toString("hex")) });
    }
  }

  private register(terminal: HcTerminal, engine: CliEngine, nativeId: string | null, cwd: string): TerminalInfo {
    const info: TerminalInfo = { address: terminal.address, engine, nativeId, cwd, registeredAt: Date.now(), seen: false };
    this.terminals.set(terminal.address, info);
    this.store.upsertTerminal({ address: terminal.address, engine, nativeId: nativeId ?? PENDING_NATIVE_ID, cwd });
    return info;
  }

  /** Waits (bounded) until the new session appears in the list, so Core knows it before the reply. */
  private async awaitRow(ref: CliSessionRef, budget: number): Promise<void> {
    const end = Date.now() + Math.max(0, Math.min(this.options.rowWaitMs ?? 5000, budget));
    this.discovery.reapply({ flush: true });
    while (!this.discovery.get(ref) && Date.now() < end && !this.detached) {
      await this.discovery.refresh({ flush: true });
      if (this.discovery.get(ref)) break;
      await sleep(Math.min(500, Math.max(0, end - Date.now())));
    }
  }

  private async opStart(args: CliOpArgs["start"], budget: number): Promise<{ ref: CliSessionRef; terminal: string }> {
    const hc = await this.requireHc();
    const executable = await this.cliPath(args.engine);
    const size = clampTermSize(args.cols, args.rows);
    const claude = args.engine === "claude";
    const nativeId = claude ? randomUUID() : undefined;
    const known = new Set<string>();
    if (!claude) {
      await this.discovery.refresh();
      for (const row of this.discovery.snapshot()) if (row.engine === "codex") known.add(cliRef("codex", row.nativeId));
    }
    const hooks = nativeId ? await this.hookLaunch(nativeId) : undefined;
    const plan = await planLaunch(
      { engine: args.engine, mode: "new", nativeId, key: randomBytes(4).toString("hex"), cwd: args.cwd, executable, ...(hooks ? { hooks } : {}) },
      { platform: this.platform, ...(this.options.env ? { env: this.options.env } : {}), ...(this.options.homedir ? { homedir: this.options.homedir } : {}) },
    );
    const launchedAt = Date.now();
    const terminal = await this.runTerminal(hc, args.engine, plan, size);
    this.register(terminal, args.engine, nativeId ?? null, plan.cwd);
    this.discovery.reapply({ flush: true });
    if (nativeId) {
      const ref = cliRef("claude", nativeId);
      await this.awaitRow(ref, budget - 1000);
      return { ref, terminal: terminal.address };
    }
    const claim: PendingClaim = { address: terminal.address, cwd: plan.cwd, launchedAt, known };
    this.pending.push(claim);
    this.armExpiry();
    const ref = await this.waitClaim(claim, Math.min(20_000, Math.max(0, budget - 3000)));
    if (ref) return { ref, terminal: terminal.address };
    // No session file yet: the terminal runs and is claimed once the file shows up.
    return { ref: cliRef("codex", `pending-${randomBytes(4).toString("hex")}`), terminal: terminal.address };
  }

  private armExpiry(): void {
    if (this.expiryTimer || this.detached) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.tryClaims();
      if (this.pending.length > 0) this.armExpiry();
    }, 15_000);
    this.expiryTimer.unref?.();
  }

  private async opContinue(args: CliOpArgs["continue"], budget: number): Promise<{ ref: CliSessionRef; terminal: string }> {
    const parsed = parseCliRef(args.ref);
    if (!parsed) throw new OpFailure("invalid");
    this.session(args.ref);
    const hc = await this.requireHc();
    await this.refreshTerminals();
    const mapped = this.addressFor(args.ref);
    if (mapped) return { ref: args.ref, terminal: mapped };

    // One more look right before launching: single writer (plan 3.5).
    await this.discovery.refresh({ flush: true });
    const row = this.session(args.ref);
    const writer = this.otherWriter(row);
    if (writer === "yes") throw new OpFailure("open_elsewhere");

    const executable = await this.cliPath(parsed.engine);
    const size = clampTermSize(undefined, undefined);
    const hooks = parsed.engine === "claude" ? await this.hookLaunch(parsed.nativeId) : undefined;
    const plan = await planLaunch(
      { engine: parsed.engine, mode: "resume", nativeId: parsed.nativeId, key: parsed.nativeId, cwd: row.cwd, executable, ...(hooks ? { hooks } : {}) },
      { platform: this.platform, ...(this.options.env ? { env: this.options.env } : {}), ...(this.options.homedir ? { homedir: this.options.homedir } : {}) },
    );
    plan.env = { ...plan.env, ...this.launchEnvironment(parsed.engine, row.configDir) };
    const terminal = await this.runTerminal(hc, parsed.engine, plan, clampTermSize(args.cols ?? size.cols, args.rows ?? size.rows));
    this.register(terminal, parsed.engine, parsed.nativeId, plan.cwd);
    if (parsed.engine === "codex" && writer === "unknown") await this.checkEarlyExit(hc, terminal.address);
    await this.awaitRow(args.ref, budget - 1000);
    this.discovery.reapply({ flush: true });
    return { ref: args.ref, terminal: terminal.address };
  }

  /** Whether another process writes this session. The scan just ran: a running or idle row has a live
   * process (Claude) or a writer lock or fresh write (Codex); a stopped Codex row may still be written when the
   * CLI keeps no lock files, which only the early-exit check can tell. */
  private otherWriter(row: CliSessionWire): "yes" | "no" | "unknown" {
    if (row.state !== "stopped") return "yes";
    return row.engine === "codex" && row.writerUnknown === true ? "unknown" : "no";
  }

  /** Codex gives no lock file to check: a terminal that dies at once with a "writer" complaint means someone else has the session. */
  private async checkEarlyExit(hc: HcLike, address: string): Promise<void> {
    const end = Date.now() + (this.options.settleMs ?? 5000);
    while (Date.now() < end) {
      let finished = false;
      try {
        finished = (await hc.get(address)).state !== "live";
      } catch (error) {
        finished = hcErrorCode(error) === "stopped";
      }
      if (finished) {
        let screen = "";
        try {
          screen = (await hc.read(address, { lines: 40 })).text;
        } catch {
          // the screen of a finished terminal may be gone
        }
        this.terminals.delete(address);
        this.store.endTerminal(address);
        this.discovery.reapply({ flush: true });
        if (/writer|already (in use|open|running)|another (process|instance)|locked|占用|正在使用/i.test(screen)) throw new OpFailure("open_elsewhere");
        throw new OpFailure("unknown", "the session ended right after it started");
      }
      await sleep(250);
    }
  }

  private terminalOf(ref: CliSessionRef): string {
    const address = this.addressFor(ref);
    if (address) return address;
    const row = this.discovery.get(ref);
    if (!row) throw new OpFailure("not_found");
    throw new OpFailure(row.state === "stopped" ? "stopped" : "not_in_terminal");
  }

  private async opSend(args: CliOpArgs["send"]): Promise<{ turn: number; started: boolean }> {
    if (args.text.length === 0) throw new OpFailure("invalid");
    if (utf8ByteLength(args.text) > MAX_SEND_TEXT) throw new OpFailure("too_large");
    const address = this.terminalOf(args.ref);
    const hc = await this.requireHc();
    try {
      const result = await hc.sendGuarded({ terminal: address, text: args.text });
      return { turn: Number.isSafeInteger(result.turn) && result.turn >= 0 ? result.turn : 0, started: result.started === true };
    } catch (error) {
      if ((error as { kind?: string }).kind === "hc_draft") throw new OpFailure("busy", "电脑上有人正在输入");
      if (hcErrorCode(error) === "stopped") this.scheduleRefresh();
      throw error;
    }
  }

  private async opInterrupt(args: CliOpArgs["interrupt"]): Promise<{ outcome: string }> {
    const address = this.terminalOf(args.ref);
    const hc = await this.requireHc();
    const result = await hc.interrupt(address, { timeout: 5 });
    return { outcome: String(result.outcome ?? "unknown").slice(0, 100) };
  }

  private async opOpenLocal(args: CliOpArgs["open_local"]): Promise<Record<string, never>> {
    const address = this.terminalOf(args.ref);
    const scope = this.hcScope ?? this.scopeFor();
    if (!scope.binary) throw new OpFailure("hc_unavailable");
    await openLocal(
      {
        address,
        binary: scope.binary,
        session: scope.session,
        socket: scope.socket,
        dir: this.options.dir,
        platform: this.platform,
        ...(this.options.hasWindowsTerminal === undefined ? {} : { hasWindowsTerminal: this.options.hasWindowsTerminal }),
      },
      this.options.launcher,
    );
    return {};
  }

  /** Core relays the answer to a pending request; it goes to the hook that waits for it. */
  private async opAnswer(args: CliOpArgs["answer"]): Promise<{ outcome: string }> {
    const server = this.hooks ?? (await this.ensureHooks());
    if (!server) throw new OpFailure("not_found");
    try {
      return { outcome: server.answer(args) };
    } catch (error) {
      if (error instanceof HookError) throw new OpFailure(error.code, error.code === "not_found" ? "request is closed" : undefined);
      throw error;
    }
  }

  // -- internals: streams ---------------------------------------------------------------------

  private async openStream(message: Extract<CoreCliMessage, { type: "cli.term.open" }>): Promise<void> {
    const address = this.addressFor(message.ref);
    if (!address && !this.discovery.get(message.ref)) {
      this.sendJson({ type: "cli.term.error", sid: message.sid, code: "not_found" });
      return;
    }
    await this.streams.open({ sid: message.sid, ref: message.ref, address, cols: message.cols, rows: message.rows, observe: message.observe });
  }
}

class DeadlineError extends Error {}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError("operation deadline passed")), ms);
    timer.unref?.();
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

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
import { mkdir, open, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CLI_ATTACH_MAX_BYTES,
  CLI_ERROR_TEXT,
  CLI_FEATURES,
  CLI_LIMITS,
  CLI_OP_MUTATING,
  CLI_OP_TIMEOUT_MS,
  HERDR_CORE_VERSION,
  MAX_ITEMS_PER_MESSAGE,
  MAX_SEND_TEXT,
  PAGE_SIZE,
  base64DecodedLength,
  clampTermSize,
  cliModelEfforts,
  cliRef,
  isCliEngine,
  parseCliOpResult,
  parseCliRef,
  parseCoreCliMessage,
  resolveCliEffort,
  utf8ByteLength,
  type CliAgentsCapability,
  type CliEngine,
  type CliErrorCode,
  type CliItem,
  type CliLaunchOptions,
  type CliOp,
  type CliOpArgs,
  type CliOpResult,
  type CliPermissionMode,
  type CliSessionRef,
  type CliSessionWire,
  type CoreCliMessage,
  type DeviceCliMessage,
} from "../../../shared/cli-agents.ts";
import { decodeTermFrame } from "../../../shared/cli-agent-frames.ts";
import { AgyError, AgyRuntime } from "./agy.ts";
import { agyConfigDir, type agyWriters } from "./agy-native.ts";
import { CodexDaemons, DaemonError, prepareCodexThread, proxyConnector, updateCodexThreadNames, type CodexDaemonOptions } from "./codex-daemon.ts";
import { CodexDesktopQueue } from "./codex-desktop-queue.ts";
import { canConsumeCodexQueue, tryManagedCodexQueue } from "./codex-native-queue.ts";
import { codexEmptyComposer, codexReceipt } from "./codex-first-input.ts";
import { DeviceGit, RepoRoots } from "./device-git.ts";
import { allHarnesses, harnessConfigEnv, harnessFor, type HarnessDriver, type HarnessWatchSource } from "./harness.ts";
import { createDefaultHarnessDrivers } from "./harness-drivers.ts";
import { HookError, HookServer, TurnTracker, locateHookPlugin, platformPlugin } from "./hooks.ts";
import { ScreenPromptError, ScreenPrompts, type ScreenTerminal } from "./screen-prompts.ts";
import { InboxError } from "./inbox.ts";
import { clipUnits } from "./items.ts";
import { SessionDiscovery, type SessionDiscoveryOptions, type SessionsDiff } from "./discovery.ts";
import {
  HerdrCore,
  hcSocketPath,
  locateHerdrCore,
  stageHerdrCoreForRuntime,
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
import { LaunchError, PENDING_NATIVE_ID, clearCliCache, cliVersion, codexHasNoDaemonFlag, launchEnv, planLaunch, resolveCli, terminalName, validateCwd } from "./launch.ts";
import { CliLocalStore, type StoredReply } from "./local-store.ts";
import { compressImagePreview, maxImageSourceBytes } from "../image-preview.ts";
import { TranscriptReader } from "./reader.ts";
import { searchSessions, type SearchSource } from "./search.ts";
import { cliModels } from "./models.ts";
import { ensureDir, listDirs } from "./dirs.ts";
import { TermStreams, hcErrorCode, type TermStream } from "./streams.ts";
import type { ZcodeHostChannel, ZcodeLaunchSpec } from "./zcode.ts";
import { ZcodeError, ZcodeRuntime } from "./zcode-runtime.ts";

/** What the bridge needs from herdr-core. `HerdrCore` is one; tests pass a fake. */
export interface HcLike {
  ensureStarted(): Promise<void>;
  close(): void;
  state(): HcState;
  run(params: HcRunParams): Promise<HcTerminal>;
  list(params?: { all?: boolean; labels?: Record<string, string> }): Promise<HcListResult>;
  get(terminal: string): Promise<HcTerminal>;
  read(terminal: string, params?: { lines?: number }): Promise<{ text: string }>;
  /** presses keys (`enter`, `esc`, `1`...); answers approval dialogs read off the screen */
  keys?(terminal: string, keys: string[]): Promise<unknown>;
  /** `send` that fails with kind `hc_draft` instead of merging into a local draft */
  sendGuarded(params: HcSendParams, options?: { beforeSend?: () => Promise<void> }): Promise<HcSendResult>;
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
  /** ZCode database homes; defaults to ~/.zcode/cli */
  zcodeHomes?: string[];
  /** Isolated Antigravity CLI profile, used by the release fixture. */
  agyDir?: string;
  agyDesktopDir?: string;
  agyWriters?: typeof agyWriters;
  /** The ZCode host channel this device has, if any. */
  zcodeHost?: ZcodeHostChannel | null;
  /** Override ZCode app-server launch resolution (for tests and isolated fixtures). */
  zcodeLaunch?: () => Promise<ZcodeLaunchSpec | null>;
  discovery?: Partial<SessionDiscoveryOptions>;
  resolveCli?: (engine: CliEngine) => Promise<string | null>;
  cliVersion?: (file: string) => Promise<string | null>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  /** How long a new Codex terminal may wait for its session file. Default 10 minutes. */
  codexClaimMs?: number;
  prepareCodexThread?: typeof prepareCodexThread;
  /** Maximum time to observe the resumed composer's first usable frame / a native receipt. */
  codexInputReadyMs?: number;
  codexReceiptMs?: number;
  codexHasNoDaemonFlag?: typeof codexHasNoDaemonFlag;
  managedCodexQueue?: typeof tryManagedCodexQueue;
  codexDesktopQueue?: Pick<CodexDesktopQueue, "refresh" | "supports" | "send">;
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
  /** Joining a Codex app-server daemon that a TUI shares. Tests pass a connector and `detect`; by default the
   * connection is `codex app-server proxy`, tried only where a control socket exists. Never starts a daemon. */
  codexDaemon?: Partial<Pick<CodexDaemonOptions, "connect" | "detect" | "ttlMs" | "rpcTimeoutMs" | "retryMs" | "listEveryMs">>;
  /** How long a message to a Claude inbox may take to show up in the transcript. Default 6 s. */
  inboxConfirmMs?: number;
  /** Where `attach` writes files. Default: `<os.tmpdir()>/nexbot-attachments`. */
  attachDir?: string;
  /** How often the screens of nex_bot's terminals are checked for approval dialogs no hook reported. Default 1.5 s; 0 turns it off. */
  screenPromptMs?: number;
  /** How long such a dialog must stay before it becomes a card (tests pass 0). */
  screenPromptGraceMs?: number;
  /** Optional extra or override harness runtime drivers (for extensions or tests). */
  drivers?: readonly HarnessDriver[];
  /** Wall-clock budget of one `search`. Default 8 s (the op itself has 10). */
  searchBudgetMs?: number;
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
  /** Shared across list refreshes; a fresh bridge conservatively rechecks a labelled terminal. */
  firstCodexInput?: { confirmed: boolean };
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
  /** a Codex App chat that lives only in the App's database: polled instead of tailed */
  app?: { timer: NodeJS.Timeout | null; marker: string; busy: boolean };
}

const HC_LABELS = { nexbot: "1" } as const;
const FIRST_CODEX_INPUT = "nexbot.codex-first-input";
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
  private readonly agy: AgyRuntime;
  private readonly zcode: ZcodeRuntime;
  private readonly discovery: SessionDiscovery;
  private readonly streams: TermStreams;
  private readonly watches = new Map<string, Watch>();
  private readonly terminals = new Map<string, TerminalInfo>();
  private readonly pending: PendingClaim[] = [];
  private readonly inflight = new Map<string, Promise<StoredReply>>();
  private readonly activeStarts = new Map<string, Promise<CliOpResult["start"]>>();
  private readonly busyRefs = new Set<string>();
  private readonly tasks = new Set<Promise<unknown>>();
  private engines: Array<{ engine: CliEngine; version: string | null }> = [];
  private agyNeedsUpdate = false;
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
  private readonly codexDaemons: CodexDaemons;
  private readonly codexDesktopQueue: Pick<CodexDesktopQueue, "refresh" | "supports" | "send"> | undefined;
  private readonly screens: ScreenPrompts;
  private screenTimer: NodeJS.Timeout | null = null;
  private readonly git: DeviceGit;
  private readonly drivers: Map<CliEngine, HarnessDriver>;

  constructor(private readonly options: CliAgentBridgeOptions) {
    this.platform = options.platform ?? process.platform;
    this.store = new CliLocalStore(path.join(options.dir, "cli-agents.db"));
    this.turns = new TurnTracker((message) => this.sendJson(message));
    this.git = new DeviceGit({ platform: this.platform, ...(options.env ? { env: options.env } : {}) });
    const agyDir = options.agyDir ?? agyConfigDir(options.env, options.homedir);
    const defaultGeminiDir = path.join(options.homedir ?? os.homedir(), ".gemini");
    const desktopDir = options.agyDesktopDir ?? (!options.claudeDirs && !options.agyDir && agyDir === path.join(defaultGeminiDir, "antigravity-cli")
      ? path.join(defaultGeminiDir, "antigravity") : undefined);
    this.agy = new AgyRuntime({
      dir: agyDir, desktopDir, platform: this.platform,
      writers: options.agyWriters,
      env: options.agyDir ? { ...(options.env ?? process.env), ANTIGRAVITY_CLI_CONFIG_DIR: agyDir } : options.env ?? process.env,
      executable: () => this.cliPath("agy"),
      origin: () => this.scope.origin,
      changed: () => this.discovery.reapply({ flush: true }),
      emit: (message) => { this.sendJson(message); },
      ended: (id, turn, reason, error) => {
        this.sendJson({
          type: "cli.turn", ref: cliRef("agy", id), turn, reason, endedAt: Date.now(),
          ...(error ? { error: clipUnits(error, CLI_LIMITS.turnError) } : {}),
        });
      },
    });
    this.zcode = new ZcodeRuntime({
      homes: options.zcodeHomes,
      platform: this.platform,
      env: options.env ?? process.env,
      homedir: options.homedir,
      host: options.zcodeHost,
      resolveCli: (engine) => this.findCli(engine),
      resolveLaunch: options.zcodeLaunch,
      origin: () => this.scope.origin,
      changed: () => this.discovery.reapply({ flush: true }),
      emit: (message) => { this.sendJson(message); },
      ended: (id, turn, reason, error) => {
        this.sendJson({
          type: "cli.turn", ref: cliRef("zcode", id), turn, reason, endedAt: Date.now(),
          ...(error ? { error: clipUnits(error, CLI_LIMITS.turnError) } : {}),
        });
      },
    });
    this.codexDaemons = new CodexDaemons({
      connect: proxyConnector({ codexPath: () => this.findCli("codex"), ...(options.env ? { env: options.env } : {}), platform: this.platform }),
      emit: (message) => this.sendJson(message),
      onLost: () => this.discovery.reapply({ flush: true }),
      log: (level, message) => this.log(level, `codex daemon: ${message}`),
      ...options.codexDaemon,
    });
    this.codexDesktopQueue = options.codexDesktopQueue ?? (options.codexHomes ? undefined : new CodexDesktopQueue({ platform: this.platform, env: options.env, homedir: options.homedir }));
    this.screens = new ScreenPrompts({
      terminals: () => this.screenTerminals(),
      reported: (ref) => (this.hooks?.pendingFor(ref) ?? 0) > 0 || (ref.startsWith("codex:") && this.codexDaemons.hasPendingFor(ref.slice(ref.indexOf(":") + 1))),
      maybeWaiting: (terminal) => this.maybeWaiting(terminal),
      read: async (address) => (await this.requireHc()).read(address, { lines: 60 }).then((result) => result.text),
      press: async (address, key) => {
        const hc = await this.requireHc();
        if (!hc.keys) throw new OpFailure("not_found");
        await hc.keys(address, [key]);
      },
      emit: (message) => this.sendJson(message),
      linked: () => this.link_ !== null && !this.detached,
      ...(options.screenPromptGraceMs === undefined ? {} : { graceMs: () => options.screenPromptGraceMs as number }),
      log: (message) => this.log("debug", message),
    });
    this.discovery = new SessionDiscovery({
      ...(options.claudeDirs ? { claudeDirs: options.claudeDirs } : {}),
      ...(options.codexHomes ? { codexHomes: options.codexHomes } : {}),
      codex: { updateNames: (home, names) => updateCodexThreadNames(
        { codexPath: () => this.findCli("codex"), platform: this.platform, env: this.options.env },
        home, names, () => this.link_ !== null && !this.detached,
      ) },
      agy: this.agy,
      // the real machine only when the Claude directories are the default ones: tests that name their own stay hermetic
      ...(options.claudeDirs ? {} : { repoRoots: new RepoRoots({ platform: this.platform, ...(options.homedir ? { home: options.homedir } : {}) }) }),
      codexDaemon: { threads: (home) => this.codexDaemons.threads(home), refresh: (home) => this.codexDaemons.refresh(home) },
      ...(this.codexDesktopQueue ? { codexDesktopQueue: this.codexDesktopQueue } : {}),
      ...options.discovery,
      extraSources: [this.zcode, ...(options.discovery?.extraSources ?? [])],
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
    this.drivers = createDefaultHarnessDrivers({
      platform: this.platform,
      env: this.options.env,
      homedir: this.options.homedir,
      discovery: this.discovery,
      agy: this.agy,
      zcode: this.zcode,
      codexDaemons: this.codexDaemons,
      codexDesktopQueue: this.codexDesktopQueue,
      zcodeHomes: this.options.zcodeHomes,
      zcodeHost: this.options.zcodeHost,
      inboxConfirmMs: this.options.inboxConfirmMs,
      shouldProbeAgy: !this.options.claudeDirs || !!this.options.agyDir,
      shouldProbeZcode: !this.options.claudeDirs || !!this.options.zcodeHomes || !!this.options.zcodeLaunch,
      fail: (code, message) => new OpFailure(code, message),
      probeCli: (engine) => this.probeCli(engine),
      findCli: (engine) => this.findCli(engine),
      addressFor: (ref) => this.addressFor(ref),
      firstCodexGate: (address) => this.terminals.get(address)?.firstCodexInput,
      awaitRow: (ref, ms) => this.awaitRow(ref, ms),
      scheduleRefresh: () => this.scheduleRefresh(),
      setAgyNeedsUpdate: (value) => { this.agyNeedsUpdate = value; },
    });
    for (const driver of options.drivers ?? []) this.drivers.set(driver.id, driver);
  }

  private driver(engine: CliEngine): HarnessDriver | undefined {
    return this.drivers.get(engine);
  }

  private async probeCli(engine: CliEngine): Promise<{ available: boolean; version: string | null }> {
    const find = this.options.resolveCli ?? ((name: CliEngine) => resolveCli(name, { platform: this.platform, ...(this.options.env ? { env: this.options.env } : {}) }));
    const version = this.options.cliVersion ?? ((file: string) => cliVersion(file, { platform: this.platform, timeoutMs: 3000, ...(this.options.env ? { env: this.options.env } : {}) }));
    const file = await find(engine);
    if (!file) return { available: false, version: null };
    return { available: true, version: await version(file).catch(() => null) };
  }

  // -- what the device tells Core about itself ---------------------------------

  /** Finds the installed CLIs via registered harness adapters and drivers. Never throws. */
  prepare(): Promise<void> {
    this.prepared ??= (async () => {
      const found: Array<{ engine: CliEngine; version: string | null }> = [];
      await Promise.all(
        allHarnesses().map(async (adapter) => {
          try {
            const custom = this.driver(adapter.id)?.probe;
            const probed = custom
              ? await custom()
              : adapter.features.probe === "cli"
                ? await this.probeCli(adapter.id)
                : { available: false, version: null };
            if (probed.available) found.push({ engine: adapter.id, version: probed.version });
          } catch (error) {
            this.log("warn", `looking for ${adapter.id} failed: ${String(error)}`);
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
      forkEngines: this.engines.map((entry) => entry.engine).filter((engine) => harnessFor(engine)?.features.fork === true),
      features: [...CLI_FEATURES],
      ...(this.agyNeedsUpdate ? { agyNeedsUpdate: true } : {}),
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
    // Core dropped its copies of open approvals with the old link
    for (const driver of this.drivers.values()) driver.relink?.();
    // The hook listener comes up with the link, so terminals that survived a client restart keep forwarding;
    // prompts that came while the link was down are announced now.
    void this.ensureHooks().then((hooks) => hooks?.relink());
    this.screens.relink();
    this.armScreens();
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
    if (this.screenTimer) clearInterval(this.screenTimer);
    this.screenTimer = null;
    this.screens.clear();
    for (const reader of this.codexTails.values()) reader.close();
    this.codexTails.clear();
    const hooks = this.hooks;
    this.hooks = null;
    if (hooks) this.track(hooks.close());
    for (const claim of this.pending.splice(0)) claim.waiter?.(null);
    for (const driver of this.drivers.values()) {
      const closing = driver.close?.();
      if (closing) this.track(closing);
    }
    this.discovery.closeZcode();
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
      if (!harnessFor(row.engine)?.features.statusTurnFallback) continue;
      const ref = cliRef(row.engine, row.nativeId);
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
      const parsed = parseCliRef(ref);
      if (!parsed || !harnessFor(parsed.engine)?.features.transcriptTurnTails || this.codexTails.has(ref)) continue;
      const file = this.discovery.transcriptFor(ref);
      if (!file) continue;
      const reader = new TranscriptReader({
        path: file,
        engine: parsed.engine,
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

  // -- internals: approval dialogs on the screen ------------------------------------------------

  /** Starts looking at the screens of nex_bot's terminals for dialogs no hook or daemon reported. */
  private armScreens(): void {
    const every = this.options.screenPromptMs ?? 1500;
    if (this.screenTimer || this.detached || every <= 0) return;
    this.screenTimer = setInterval(() => {
      // nothing to look at until herdr-core runs a terminal of ours
      if (this.detached || !this.hc || this.terminals.size === 0) return;
      this.track(this.screens.scan());
    }, every);
    this.screenTimer.unref?.();
  }

  private screenTerminals(): ScreenTerminal[] {
    const out: ScreenTerminal[] = [];
    for (const info of this.terminals.values()) {
      if (!info.nativeId || !harnessFor(info.engine)?.features.screenPrompts) continue;
      try {
        out.push({ ref: cliRef(info.engine, info.nativeId), engine: info.engine, address: info.address });
      } catch {
        // not a session we can show
      }
    }
    return out;
  }

  /** The CLI says it waits (Claude's status file) or herdr-core sees the agent blocked on the user. */
  private async maybeWaiting(terminal: ScreenTerminal): Promise<boolean> {
    if (this.discovery.get(terminal.ref)?.state === "waiting") return true;
    const hc = this.hc;
    if (!hc) return false;
    try {
      return (await hc.get(terminal.address)).status === "blocked";
    } catch {
      return false;
    }
  }

  // -- internals: Claude hooks ------------------------------------------------------------------

  /** The hook listener, started on first use. Null when hooks are off, there is no plugin, or the listener cannot start. */
  private ensureHooks(): Promise<HookServer | null> {
    if (this.detached) return Promise.resolve(null);
    if (this.hooks) return Promise.resolve(this.hooks);
    this.hooksStarting ??= (async () => {
      try {
        if (this.pluginDir === undefined) {
          const located = this.options.pluginDir === undefined ? locateHookPlugin(this.options.env ? { env: this.options.env } : {}) : this.options.pluginDir;
          // Windows terminals get a copy whose hooks run in PowerShell (see platformPlugin)
          this.pluginDir = located ? platformPlugin(located, this.options.dir, this.platform) : located;
        }
        if (!this.pluginDir) return null;
        const server = new HookServer({
          dir: this.options.dir,
          emit: (message) => this.sendJson(message),
          turns: this.turns,
          active: () => !this.detached,
          linked: () => this.link_ !== null && !this.detached,
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
    const found = locateHerdrCore(this.options.env ? { env: this.options.env } : {});
    if (!found) return null;
    return stageHerdrCoreForRuntime(found, { platform: this.platform, env: this.options.env });
  }

  private scopeFor(): HcScope {
    const hash = createHash("sha256").update(`${this.scope.origin}\n${this.scope.workspaceId}`).digest("hex").slice(0, 8);
    return {
      session: `nexbot-${hash}`,
      socket: hcSocketPath({ hash, dataDir: this.options.dir, platform: this.platform, tmpdir: os.tmpdir() }),
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
        // the host's own environment (on macOS the login shell's), not this process's minimal one
        ...(this.options.env ? { env: this.options.env } : {}),
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
      if (!isCliEngine(engine)) continue;
      live.add(terminal.address);
      let nativeId: string | null = labels["nexbot.native"] ?? null;
      const known = this.terminals.get(terminal.address);
      if (!nativeId || nativeId === PENDING_NATIVE_ID) {
        const stored = this.store.terminal(terminal.address)?.nativeId;
        nativeId = known?.nativeId ?? (stored && stored !== PENDING_NATIVE_ID ? stored : null);
      }
      const info: TerminalInfo = { address: terminal.address, engine, nativeId, cwd: terminal.cwd, registeredAt: known?.registeredAt ?? 0, seen: true,
        ...(labels[FIRST_CODEX_INPUT] === "1" ? { firstCodexInput: known?.firstCodexInput ?? { confirmed: false } } : {}),
      };
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

  private closeWatch(watch: Watch): void {
    watch.reader?.close();
    if (watch.app?.timer) clearInterval(watch.app.timer);
    watch.app = undefined;
  }

  private closeWatches(): void {
    for (const watch of this.watches.values()) this.closeWatch(watch);
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
        ...(options.reset && index + 1 < messages.length ? { continues: true } : {}),
        ...(options.more && index === 0 ? { more: true } : {}),
      });
    });
  }

  /** A chat that exists only in the Codex App's database has no file to tail: its newest page is sent again whenever the database says it changed. */
  private async startAppWatch(watch: Watch, source: { chat: { threadId: string }; db: { marker(id: string): Promise<string>; page(id: string, o?: { before?: string; limit?: number }): Promise<{ items: CliItem[]; more: boolean }> } }): Promise<void> {
    const state: NonNullable<Watch["app"]> = { timer: null, marker: "", busy: false };
    watch.app = state;
    const { chat, db } = source;
    state.marker = await db.marker(chat.threadId);
    const page = await db.page(chat.threadId, { limit: PAGE_SIZE });
    if (watch.app !== state || this.watches.get(watch.ref) !== watch) return;
    this.sendItems(watch.ref, page.items, { reset: true, more: page.more });
    state.timer = setInterval(() => {
      if (state.busy) return;
      state.busy = true;
      this.track(
        (async () => {
          try {
            const marker = await db.marker(chat.threadId);
            if (watch.app !== state || marker === state.marker) return;
            state.marker = marker;
            const latest = await db.page(chat.threadId, { limit: PAGE_SIZE });
            if (watch.app === state) this.sendItems(watch.ref, latest.items, { reset: true, more: latest.more });
          } catch (error) {
            this.log("debug", `reading the App chat failed: ${String(error)}`);
          } finally {
            state.busy = false;
          }
        })(),
      );
    }, this.options.readerPollMs ?? 1000);
    state.timer.unref?.();
  }

  private watchSourceFor(ref: CliSessionRef, row: CliSessionWire): HarnessWatchSource | null {
    return this.driver(row.engine)?.watchSource?.(ref, row) ?? null;
  }

  private async startWatch(watch: Watch): Promise<void> {
    if (watch.reader || watch.app) return;
    const row = this.discovery.get(watch.ref);
    const driver = this.driver(watch.engine);
    if (row && driver?.read && driver.watchSource) {
      const source = driver.watchSource(watch.ref, row);
      if (source) {
        await this.startAppWatch(watch, source);
        return;
      }
    }
    const file = this.discovery.transcriptFor(watch.ref);
    if (!file) {
      const source = row ? this.watchSourceFor(watch.ref, row) : null;
      if (source) await this.startAppWatch(watch, source);
      return;
    }
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
      if (!watch.reader && !watch.app) await this.startWatch(watch).catch((error) => this.log("warn", `watch failed: ${String(error)}`));
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
    if (error instanceof OpFailure || error instanceof AgyError || error instanceof ZcodeError) return { code: error.code, message: clipUnits(error.message, CLI_LIMITS.message) };
    if (error instanceof DeadlineError) return { code: "unknown", message: CLI_ERROR_TEXT.unknown };
    if (error instanceof LaunchError) {
      const code: CliErrorCode = error.kind === "invalid_cwd" ? "cwd_missing" : error.kind === "cli_not_found" ? "cli_missing" : "invalid";
      return { code, message: CLI_ERROR_TEXT[code] };
    }
    if (error instanceof InboxError || error instanceof DaemonError) return { code: error.code, message: error.message.slice(0, 200) };
    const code = hcErrorCode(error);
    return { code, message: CLI_ERROR_TEXT[code] };
  }

  private async perform(message: Extract<CoreCliMessage, { type: "cli.op" }>, budget: number): Promise<unknown> {
    const args = message.args as CliOpArgs[CliOp];
    switch (message.op) {
      case "read":
        return this.opRead(args as CliOpArgs["read"]);
      case "history_image":
        return this.opHistoryImage(args as CliOpArgs["history_image"]);
      case "watch":
        return this.opWatch(args as CliOpArgs["watch"]);
      case "unwatch":
        return this.opUnwatch(args as CliOpArgs["unwatch"]);
      case "start":
        return this.opStart(args as CliOpArgs["start"], budget);
      case "continue":
        return this.exclusive((args as CliOpArgs["continue"]).ref, () => this.opContinue(args as CliOpArgs["continue"], budget));
      case "send":
        return this.exclusive((args as CliOpArgs["send"]).ref, () => this.opSend(args as CliOpArgs["send"], Date.now() + budget));
      case "steer":
        return this.exclusive((args as CliOpArgs["steer"]).ref, () => this.opSteer(args as CliOpArgs["steer"], Date.now() + budget));
      case "interrupt":
        return this.exclusive((args as CliOpArgs["interrupt"]).ref, () => this.opInterrupt(args as CliOpArgs["interrupt"]));
      case "answer":
        return this.opAnswer(args as CliOpArgs["answer"]);
      case "git":
        return this.opGit(args as CliOpArgs["git"]);
      case "search":
        return this.opSearch(args as CliOpArgs["search"], budget);
      case "attach":
        return this.opAttach(args as CliOpArgs["attach"]);
      case "skills": {
        const query = args as CliOpArgs["skills"];
        const session = query.ref ? this.session(query.ref) : undefined;
        const cwd = session?.cwd || query.cwd || this.options.homedir || os.homedir();
        const skills = await this.driver(query.engine)?.skills?.(session, cwd);
        if (!skills) throw new OpFailure("invalid", "此工具不支持选择技能");
        return skills;
      }
      case "models": {
        const engine = (args as CliOpArgs["models"]).engine;
        const custom = this.driver(engine)?.models;
        if (custom) return custom();
        return cliModels(engine, { platform: this.platform, ...(this.options.env ? { env: this.options.env } : {}), ...(this.options.homedir ? { homedir: this.options.homedir } : {}) });
      }
      case "dirs":
        return listDirs((args as CliOpArgs["dirs"]).path, { platform: this.platform, ...(this.options.homedir ? { homedir: this.options.homedir } : {}) });
      case "branches":
        return this.git.branches((args as CliOpArgs["branches"]).cwd);
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

  private async opHistoryImage({ ref, itemId, locator }: CliOpArgs["history_image"]) {
    const row = this.session(ref);
    const file = this.discovery.transcriptFor(ref);
    const live = this.watches.get(ref)?.reader;
    const reader = file ? live ?? new TranscriptReader({ path: file, engine: row.engine, watch: false }) : undefined;
    const chat = !reader ? this.watchSourceFor(ref, row) : null;
    try {
      const source = reader ? await reader.imageSource(itemId, locator)
        : await chat?.db.imageSource?.(chat.chat.threadId, itemId, locator);
      if (!source) throw new OpFailure("not_found");
      let bytes: Buffer;
      if (source.kind === "inline") {
        if (source.value.length > Math.ceil(maxImageSourceBytes / 3) * 4) throw new OpFailure("too_large");
        bytes = Buffer.from(source.value, "base64");
      } else {
        // Reject UNC/device names before any OS call (including Windows network authentication).
        const name = source.value;
        if (/^[\\/]{2}/.test(name) || Array.from(name).some(char => char.charCodeAt(0) < 32) || !/\.(?:png|jpe?g|webp)$/i.test(name) || /^[a-z]+:(?![\\/])/i.test(name)) throw new OpFailure("invalid");
        const target = path.resolve(row.cwd, name);
        if (/^[\\/]{2}/.test(target)) throw new OpFailure("invalid");
        if (source.kind === "marker" || source.kind === "markdown") {
          // Text links may resolve only within this workspace or this session's image directory.
          const roots = source.kind === "marker" ? [path.resolve(row.configDir, "image-cache", row.nativeId)]
            : [row.cwd, path.resolve(row.configDir, "generated_images", row.nativeId)].filter(Boolean);
          const inside = (candidate: string) => roots.some(root => {
            const rel = path.relative(root, candidate);
            return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
          });
          if (!inside(target) || !inside(await realpath(target))) throw new OpFailure("invalid");
        }
        const handle = await open(target, "r");
        try {
          const info = await handle.stat();
          if (!info.isFile() || !info.size) throw new OpFailure("not_found");
          if (info.size > maxImageSourceBytes) throw new OpFailure("too_large");
          bytes = Buffer.alloc(info.size);
          let pos = 0;
          while (pos < bytes.length) {
            const { bytesRead } = await handle.read(bytes, pos, bytes.length - pos, pos);
            if (!bytesRead) throw new OpFailure("not_found");
            pos += bytesRead;
          }
        } finally { await handle.close(); }
      }
      const preview = await compressImagePreview(bytes).catch(() => { throw new OpFailure("invalid", "图片压缩失败"); });
      return { data: preview.toString("base64") };
    } catch (error) {
      if (error instanceof OpFailure) throw error;
      throw new OpFailure("not_found");
    } finally { if (reader && reader !== live) reader.close(); }
  }

  private async opRead(args: CliOpArgs["read"]): Promise<{ items: CliItem[]; more: boolean }> {
    const row = this.session(args.ref);
    const limit = args.limit ?? PAGE_SIZE;
    const custom = await this.driver(row.engine)?.read?.(args.ref, row, args.before, limit);
    if (custom) return custom;
    const file = this.discovery.transcriptFor(args.ref);
    if (!file) {
      const source = this.watchSourceFor(args.ref, row);
      if (source) return source.db.page(source.chat.threadId, { ...(args.before ? { before: args.before } : {}), limit });
      return { items: [], more: false };
    }
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
    if (existing?.reader || existing?.app) {
      // Core asks again after a reconnect: send the newest page once more
      const page = await this.opRead({ ref: args.ref, limit: PAGE_SIZE });
      if (this.watches.get(args.ref) !== existing) return {};
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
    if (watch) this.closeWatch(watch);
    this.watches.delete(args.ref);
    return {};
  }

  /** The installed CLI, or null. No retry and no cache reset: callers that can live without it use this. */
  private async findCli(engine: CliEngine): Promise<string | null> {
    const find = this.options.resolveCli ?? ((name: CliEngine) => resolveCli(name, { platform: this.platform, ...(this.options.env ? { env: this.options.env } : {}) }));
    try {
      return await find(engine);
    } catch {
      return null;
    }
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
    return { ...env, ...harnessConfigEnv(engine, configDir, homedir, this.platform) };
  }

  private async launchOptions(engine: CliEngine, args: CliLaunchOptions, configDir?: string, sessionModel?: string, fallback?: CliPermissionMode) {
    let effort = args.effort;
    if (harnessFor(engine)?.features.modelPicker) {
      const env = { ...(this.options.env ?? process.env), ...this.launchEnvironment(engine, configDir) };
      const catalog = await cliModels(engine, { platform: this.platform, env, homedir: this.options.homedir });
      const model = args.model ?? sessionModel ?? catalog.current ?? "";
      effort = resolveCliEffort(engine, cliModelEfforts(engine, catalog.models, model), effort);
    }
    return { ...launchOptionsOf(args, fallback), ...(effort === undefined ? {} : { effort }) };
  }

  /** Runs the planned terminal; a taken name gets one retry with a fresh one. */
  private async runTerminal(
    hc: HcLike,
    engine: CliEngine,
    plan: { argv: string[]; cwd: string; env: Record<string, string>; name: string; labels: Record<string, string> },
    size: { cols: number; rows: number },
  ): Promise<HcTerminal> {
    // Resumed threads can have an older CLI version in their rollout than the terminal that now owns them.
    const version = engine === "codex" ? /^codex-cli (\d+\.\d+\.\d+)$/.exec(this.engines.find((e) => e.engine === engine)?.version ?? "")?.[1] : undefined;
    const labels = engine === "codex" ? { ...plan.labels,
      ...(version ? { "nexbot.codex-version": version } : {}),
      ...(plan.env.CODEX_HOME ? { "nexbot.codex-home": plan.env.CODEX_HOME } : {}),
    } : plan.labels;
    const params: HcRunParams = { argv: plan.argv, cwd: plan.cwd, env: plan.env, name: plan.name, labels, size, keep: false };
    try {
      return await hc.run(params);
    } catch (error) {
      if ((error as { kind?: string }).kind !== "name_taken") throw error;
      return hc.run({ ...params, name: terminalName(engine, randomBytes(4).toString("hex")) });
    }
  }

  private register(terminal: HcTerminal, engine: CliEngine, nativeId: string | null, cwd: string): TerminalInfo {
    const info: TerminalInfo = { address: terminal.address, engine, nativeId, cwd, registeredAt: Date.now(), seen: false,
      ...(terminal.labels[FIRST_CODEX_INPUT] === "1" ? { firstCodexInput: { confirmed: false } } : {}),
    };
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

  /** The session a `start` forks, checked before anything is launched. A fork runs where the parent
   * does (the CLI finds a transcript by its project directory) and, unlike `continue`, may run while
   * the parent is open elsewhere: it only reads the parent's history. */
  private forkSource(args: CliOpArgs["start"]): { nativeId: string; row: CliSessionWire } | null {
    if (!args.forkFrom) return null;
    const parent = parseCliRef(args.forkFrom);
    if (!parent || parent.engine !== args.engine) throw new OpFailure("invalid");
    // ZCode and non-forking harnesses have no fork flag; a blank session in its place would look like a fork that lost its context
    if (!harnessFor(args.engine)?.features.fork) throw new OpFailure("invalid", "此入口不支持分叉");
    if (args.worktree) throw new OpFailure("invalid", "分叉不能同时新建工作树");
    const row = this.session(args.forkFrom);
    if (!this.discovery.transcriptFor(args.forkFrom)) throw new OpFailure("invalid", "此会话没有本地记录，无法分叉");
    return { nativeId: parent.nativeId, row };
  }

  private async opStart(args: CliOpArgs["start"], budget: number): Promise<CliOpResult["start"]> {
    const requestId = args.worktree?.requestId;
    if (!requestId) return this.runStart(args, budget);
    const inflight = this.activeStarts.get(requestId);
    if (inflight) return inflight;
    const storedKey = `start-req:${requestId}`;
    const cached = this.store.opEntry(storedKey);
    if (cached?.state === "done" && cached.reply.ok && cached.reply.result) {
      const parsed = parseCliOpResult("start", cached.reply.result);
      if (
        parsed &&
        (!parsed.ref.startsWith("agy:") || this.agy.rows().some((row) => cliRef("agy", row.nativeId) === parsed.ref)) &&
        (!parsed.ref.startsWith("zcode:") || this.zcode.rows().some((row) => cliRef("zcode", row.nativeId) === parsed.ref))
      ) {
        return parsed;
      }
    }
    const task = this.runStart(args, budget).then((result) => {
      this.store.beginOp(storedKey, "start");
      this.store.finishOp(storedKey, { ok: true, result: result as Record<string, unknown> });
      return result;
    }).finally(() => {
      if (this.activeStarts.get(requestId) === task) this.activeStarts.delete(requestId);
    });
    this.activeStarts.set(requestId, task);
    return task;
  }

  private async runStart(args: CliOpArgs["start"], budget: number): Promise<CliOpResult["start"]> {
    refuseUnsupportedLaunchOptions(args.engine, args);
    const fork = this.forkSource(args);
    if (args.branch && (fork || args.worktree || args.createDir)) {
      throw new OpFailure("invalid", "切换分支不能与分叉、新建目录或新建工作树同时使用");
    }
    if (args.createDir) {
      // a folder typed in the picker that did not exist yet; a worktree needs an existing repository
      if (fork || args.worktree) throw new OpFailure("invalid", "新建目录不能同时分叉或新建工作树");
      try { await ensureDir(args.cwd); } catch (error) { throw new OpFailure("invalid", "无法创建目录：" + String((error as NodeJS.ErrnoException).code ?? "error")); }
    }
    const customStart = this.driver(args.engine)?.start;
    if (customStart) {
      let cwd = args.cwd;
      if (args.worktree) {
        const built = await this.git.worktree(cwd, args.worktree.branch, args.worktree.requestId, {
          platform: this.platform,
          ...(args.worktree.baseBranch ? { baseBranch: args.worktree.baseBranch } : {}),
        });
        if (built.source === "failed" || !built.worktree) throw new OpFailure("invalid", built.error ?? "无法创建工作树");
        cwd = built.worktree;
      }
      cwd = await validateCwd(cwd, { platform: this.platform, env: this.options.env });
      if (args.branch) {
        const switched = await this.git.switchBranch(cwd, args.branch);
        if (!switched.ok) throw new OpFailure("invalid", switched.error);
      }
      return customStart(args, cwd, budget);
    }
    if (args.branch) {
      const checkedCwd = await validateCwd(args.cwd, { platform: this.platform, env: this.options.env });
      const switched = await this.git.switchBranch(checkedCwd, args.branch);
      if (!switched.ok) throw new OpFailure("invalid", switched.error);
    }
    const size = clampTermSize(args.cols, args.rows);
    const features = harnessFor(args.engine)?.features;
    const preassigned = features?.hooks === true;
    let nativeId: string | undefined = preassigned ? randomUUID() : undefined;
    const newCodex = args.engine === "codex" && !fork;
    const known = new Set<string>();
    // A worktree start builds the tree here first; the requestId dedups so a
    // retried request reuses the tree it already created. Checking out a large
    // repository takes seconds, so the terminal, the CLI and the hooks get ready meanwhile.
    const tree = args.worktree
      ? this.git.worktree(args.cwd, args.worktree.branch, args.worktree.requestId, {
          platform: this.platform,
          ...(args.worktree.baseBranch ? { baseBranch: args.worktree.baseBranch } : {}),
        })
      : null;
    const [hc, executable, hooks, launchOptions] = await Promise.all([
      this.requireHc(),
      this.cliPath(args.engine),
      nativeId ? this.hookLaunch(nativeId) : Promise.resolve(undefined),
      this.launchOptions(args.engine, args, fork?.row.configDir, fork?.row.model, "full"),
      preassigned || newCodex ? Promise.resolve() : this.discovery.refresh().then(() => {
        for (const row of this.discovery.snapshot()) if (row.engine === args.engine) known.add(cliRef(args.engine, row.nativeId));
      }),
    ]);
    let cwd = fork ? fork.row.cwd : args.cwd;
    if (tree) {
      const built = await tree;
      if (built.source === "failed" || !built.worktree) throw new OpFailure("invalid", built.error ?? "无法创建工作树");
      cwd = built.worktree;
    }
    const launchContext = { platform: this.platform, env: this.options.env, homedir: this.options.homedir };
    let noDaemon = false;
    let codexHome: string | undefined;
    if (newCodex) {
      cwd = await validateCwd(cwd, launchContext);
      codexHome = this.launchEnvironment("codex", undefined).CODEX_HOME ?? path.join(this.options.homedir ?? os.homedir(), ".codex");
      [nativeId, noDaemon] = await Promise.all([
        (this.options.prepareCodexThread ?? prepareCodexThread)({ executable, home: codexHome, cwd }, launchContext),
        (this.options.codexHasNoDaemonFlag ?? codexHasNoDaemonFlag)(executable, launchContext),
      ]);
    }
    const plan = await planLaunch(
      {
        engine: args.engine,
        mode: fork ? "fork" : newCodex ? "resume" : "new",
        nativeId,
        ...(fork ? { forkFrom: fork.nativeId } : {}),
        key: randomBytes(4).toString("hex"),
        cwd,
        executable,
        ...(hooks ? { hooks } : {}),
        ...launchOptions,
      },
      { platform: this.platform, ...(this.options.env ? { env: this.options.env } : {}), ...(this.options.homedir ? { homedir: this.options.homedir } : {}) },
    );
    if (newCodex) plan.labels[FIRST_CODEX_INPUT] = "1";
    if (noDaemon) plan.argv.push("--no-daemon");
    if (codexHome) plan.env.CODEX_HOME = codexHome;
    // the fork reads the parent from the config home the parent lives in
    if (fork) plan.env = { ...plan.env, ...this.launchEnvironment(args.engine, fork.row.configDir) };
    const launchedAt = Date.now();
    const terminal = await this.runTerminal(hc, args.engine, plan, size);
    this.register(terminal, args.engine, nativeId ?? null, plan.cwd);
    this.discovery.reapply({ flush: true });
    if (nativeId) {
      const ref = cliRef(args.engine, nativeId);
      await this.awaitRow(ref, budget - 1000);
      return { ref, terminal: terminal.address, cwd: plan.cwd };
    }
    const claim: PendingClaim = { address: terminal.address, cwd: plan.cwd, launchedAt, known };
    this.pending.push(claim);
    this.armExpiry();
    const ref = await this.waitClaim(claim, Math.min(20_000, Math.max(0, budget - 3000)));
    if (ref) return { ref, terminal: terminal.address, cwd: plan.cwd };
    // No session file yet: the terminal runs and is claimed once the file shows up.
    return { ref: cliRef("codex", `pending-${randomBytes(4).toString("hex")}`), terminal: terminal.address, cwd: plan.cwd };
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

  private async opContinue(args: CliOpArgs["continue"], budget: number): Promise<CliOpResult["continue"]> {
    const parsed = parseCliRef(args.ref);
    if (!parsed) throw new OpFailure("invalid");
    refuseUnsupportedLaunchOptions(parsed.engine, args);
    const existing = this.session(args.ref);
    const customContinue = await this.driver(parsed.engine)?.continueSession?.(args, existing, budget);
    if (customContinue) return customContinue;
    const hc = await this.requireHc();
    await this.refreshTerminals();
    const mapped = this.addressFor(args.ref);
    // already running in our terminal: the CLI keeps the model it runs with
    if (mapped) return { ref: args.ref, terminal: mapped };

    // One more look right before launching: single writer (plan 3.5).
    await this.discovery.refresh({ flush: true });
    const row = this.session(args.ref);
    const writer = this.otherWriter(row);
    if (writer === "yes") throw new OpFailure("open_elsewhere");

    const features = harnessFor(parsed.engine)?.features;
    const size = clampTermSize(undefined, undefined);
    const [executable, hooks, launchOptions, extraEnv] = await Promise.all([
      this.cliPath(parsed.engine),
      features?.hooks ? this.hookLaunch(parsed.nativeId) : Promise.resolve(undefined),
      this.launchOptions(parsed.engine, args, row.configDir, row.model),
      this.driver(parsed.engine)?.extraEnv?.() ?? Promise.resolve({}),
    ]);
    const plan = await planLaunch(
      { engine: parsed.engine, mode: "resume", nativeId: parsed.nativeId, key: parsed.nativeId, cwd: row.cwd, executable, ...(hooks ? { hooks } : {}), ...launchOptions },
      { platform: this.platform, ...(this.options.env ? { env: this.options.env } : {}), ...(this.options.homedir ? { homedir: this.options.homedir } : {}) },
    );
    plan.env = { ...plan.env, ...this.launchEnvironment(parsed.engine, row.configDir), ...extraEnv };
    const terminal = await this.runTerminal(hc, parsed.engine, plan, clampTermSize(args.cols ?? size.cols, args.rows ?? size.rows));
    this.register(terminal, parsed.engine, parsed.nativeId, plan.cwd);
    if (features?.unknownWriterCheck && writer === "unknown") await this.checkEarlyExit(hc, terminal.address);
    await this.awaitRow(args.ref, budget - 1000);
    this.discovery.reapply({ flush: true });
    return { ref: args.ref, terminal: terminal.address };
  }

  /** Whether another process writes this session. The scan just ran: a running or idle row has a live
   * process or writer lock; a stopped row whose harness lacks locks may still have another writer. */
  private otherWriter(row: CliSessionWire): "yes" | "no" | "unknown" {
    if (row.state !== "stopped") return "yes";
    return harnessFor(row.engine)?.features.unknownWriterCheck && row.writerUnknown === true ? "unknown" : "no";
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

  /** A session outside nex_bot's terminals that its harness driver can still write to. */
  private async sendOutside(args: CliOpArgs["send"], row: CliSessionWire, steer = false): Promise<CliOpResult["send"]> {
    const sent = await this.driver(row.engine)?.sendOutside?.(args, row, steer);
    if (sent) return sent;
    throw new OpFailure("not_in_terminal");
  }

  /** A saved blank thread is discoverable well before its resumed TUI can consume a paste.
   * Only the TUI submits the message. No probe keystrokes, daemon fallback or second Enter. */
  private async firstCodexSend(args: CliOpArgs["send"], address: string, gate: { confirmed: boolean }, deadline: number): Promise<CliOpResult["send"]> {
    const readyBy = Math.min(deadline - 350, Date.now() + (this.options.codexInputReadyMs ?? 30_000));
    const confirmMs = this.options.codexReceiptMs ?? 4000;
    const link = this.link_;
    const notReady = () => new OpFailure("read_only", "消息未发送。请打开 Codex 终端，处理启动提示或草稿，看到空输入框后重试。");
    let receipt: Awaited<ReturnType<typeof codexReceipt>> = null;
    let attempted = false;
    let expired = false;
    const submit = async () => {
      const hc = await this.requireHc();
      const check = () => {
        if (expired || Date.now() >= readyBy) throw notReady();
        if (this.detached || this.link_ !== link || this.hc !== hc || this.terminals.get(address)?.firstCodexInput !== gate) throw new OpFailure("stopped");
      };
      return hc.sendGuarded({ terminal: address, text: args.text }, { beforeSend: async () => {
        check();
        let previous: string | null = null;
        for (;;) {
          check();
          const [terminal, screen] = await Promise.all([hc.get(address), hc.read(address, { lines: 0 })]);
          check();
          if (terminal.state !== "live" || terminal.labels["nexbot.native"] !== parseCliRef(args.ref)?.nativeId) throw new OpFailure("stopped");
          const { status } = terminal;
          const state = status && typeof status === "object" && "state" in status ? status.state : status;
          const busy = state === "blocked" || state === "working" || this.discovery.get(args.ref)?.state === "waiting";
          const frame = busy ? null : codexEmptyComposer(screen.text, terminal.cols);
          if (frame && frame === previous) break;
          if (frame && !receipt) receipt = await codexReceipt(this.discovery.transcriptFor(args.ref));
          previous = frame;
          await sleep(Math.min(200, Math.max(1, readyBy - Date.now())));
        }
        // Recheck at the mutation boundary, even if a read / connection finished after the op expired.
        check();
        attempted = true;
      } });
    };
    const sending = submit();
    try {
      // Also bound an unresponsive terminal.read or side connection. If no write began,
      // prevent its pending callback from submitting after the failure reply.
      const result = await withDeadline(sending, Math.max(1, Math.min(deadline - 150, readyBy + 6500) - Date.now()));
      const delivery = await receiptForSend();
      if (delivery === "confirmed") gate.confirmed = true;
      return { turn: Number.isSafeInteger(result.turn) && result.turn >= 0 ? result.turn : 0, started: delivery === "confirmed", delivery };
    } catch (error) {
      if (error instanceof OpFailure) throw error;
      if (!attempted) throw hcErrorCode(error) === "stopped" ? new OpFailure("stopped") : notReady();
      // Once the RPC may have pasted, even a timeout that looks like a draft must not enter
      // the workbench's automatic busy retry path.
      throw new OpFailure("unknown", "无法确认 Codex 是否收到消息。请先检查终端和会话记录，不要重复发送。");
    } finally {
      expired = true;
      // If the RPC timed out during preflight, allow outstanding read-only work to clean up.
      void sending.catch(() => {}).finally(() => receipt?.close().catch(() => {}));
    }

    async function receiptForSend(): Promise<"confirmed" | "unconfirmed"> {
      return receipt && await receipt.confirmed(args.text, Math.min(deadline - 150, Date.now() + confirmMs)).catch(() => false) ? "confirmed" : "unconfirmed";
    }
  }

  private async enqueueManagedCodex(args: CliOpArgs["send"], address: string, deadline: number): Promise<boolean> {
    const link = this.link_;
    const row = this.discovery.get(args.ref);
    if (!row || row.engine !== "codex") return false;
    const hc = await this.requireHc();
    const terminal = await hc.get(address);
    const version = terminal.labels["nexbot.codex-version"] ?? row.cliVersion;
    if (!version || !canConsumeCodexQueue(version)) return false;
    // PATH can point to a different installation after the desktop app restarts.
    const file = terminal.argv[0];
    const paths = this.platform === "win32" ? path.win32 : path.posix;
    if (!file || !paths.isAbsolute(file) || !/^codex(?:\.exe)?$/i.test(paths.basename(file))) return false;
    const boundHome = terminal.labels["nexbot.codex-home"];
    if (boundHome && normalizeDir(boundHome, this.platform) !== normalizeDir(row.configDir, this.platform)) throw new OpFailure("stopped", "Codex 会话目录已变化");
    const validate = (current: HcTerminal) => {
      const known = this.terminals.get(address);
      const native = current.labels["nexbot.native"];
      if (!link || this.link_ !== link || this.detached || this.hc !== hc || current.state !== "live" || current.pid !== terminal.pid ||
        current.labels.nexbot !== "1" || current.labels["nexbot.engine"] !== "codex" || known?.nativeId !== row.nativeId ||
        (native !== row.nativeId && native !== PENDING_NATIVE_ID) || current.argv[0] !== terminal.argv[0] || this.discovery.get(args.ref)?.configDir !== row.configDir) throw new OpFailure("stopped");
      if (Date.now() >= deadline - 200) throw new OpFailure("busy");
    };
    validate(terminal);
    const queued = await (this.options.managedCodexQueue ?? tryManagedCodexQueue)({
      file, version, home: row.configDir, threadId: row.nativeId, cwd: terminal.cwd, platform: this.platform, env: this.options.env, text: args.text,
    }, async () => {
      validate(await hc.get(address));
      return Math.max(1, Math.min(8_000, deadline - 150 - Date.now()));
    });
    if (!queued) validate(await hc.get(address));
    return queued;
  }

  private async opSend(args: CliOpArgs["send"], deadline: number, steer = false): Promise<CliOpResult["send"]> {
    if (args.text.length === 0) throw new OpFailure("invalid");
    if (utf8ByteLength(args.text) > MAX_SEND_TEXT) throw new OpFailure("too_large");
    if (!this.addressFor(args.ref)) {
      const row = this.discovery.get(args.ref);
      if (row) {
        const sent = await this.driver(row.engine)?.sendOutside?.(args, row);
        if (sent) return sent;
        if (row.sendVia === "inbox" || row.sendVia === "daemon" || row.sendVia === "host") return this.sendOutside(args, row);
      }
    }
    const address = this.terminalOf(args.ref);
    // Slash commands belong to the TUI; queueing one would send the literal command to the model.
    if (!steer && args.ref.startsWith("codex:") && !/^\/[\w-]+(?:\s|$)/.test(args.text.trimStart()) && await this.enqueueManagedCodex(args, address, deadline)) {
      return { turn: 0, started: false, delivery: "unconfirmed", nativeQueued: true };
    }
    const gate = this.terminals.get(address)?.firstCodexInput;
    if (gate && !gate.confirmed) return this.firstCodexSend(args, address, gate, deadline);
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

  /** Guidance into a turn that is already running: delegates engine-specific
   * channels (ACP, daemon, inbox, host) to the harness driver, else types into
   * the live managed terminal. */
  private async opSteer(args: CliOpArgs["steer"], deadline: number): Promise<CliOpResult["steer"]> {
    if (args.text.length === 0) throw new OpFailure("invalid");
    if (utf8ByteLength(args.text) > MAX_SEND_TEXT) throw new OpFailure("too_large");
    const row = this.discovery.get(args.ref);
    const managedAddress = this.addressFor(args.ref);
    if (row) {
      const steered = await this.driver(row.engine)?.steer?.(args, row, managedAddress, deadline);
      if (steered) return steered;
    }
    if (managedAddress) {
      const result = await this.opSend(args, deadline, true);
      return { accepted: true, started: result.started, ...(result.delivery ? { delivery: result.delivery } : {}) };
    }
    throw new OpFailure(row?.state === "running" || row?.state === "waiting" ? "invalid" : "turn_changed");
  }

  private async opInterrupt(args: CliOpArgs["interrupt"]): Promise<{ outcome: string }> {
    const address = this.addressFor(args.ref);
    if (!address) {
      const row = this.discovery.get(args.ref);
      if (row) {
        const outcome = await this.driver(row.engine)?.interruptOutside?.(args, row);
        if (outcome) return outcome;
        throw new OpFailure(row.state === "stopped" ? "stopped" : "not_in_terminal");
      }
      throw new OpFailure("not_found");
    }
    const hc = await this.requireHc();
    const result = await hc.interrupt(address, { timeout: 5 });
    return { outcome: String(result.outcome ?? "unknown").slice(0, 100) };
  }

  /** The Git snapshot of the session's repository, gathered here. */
  private async opGit(args: CliOpArgs["git"]): Promise<unknown> {
    const row = this.session(args.ref);
    if (args.action === "worktree") return this.git.worktree(row.cwd, args.branch, args.requestId, { platform: this.platform });
    return this.git.info(row.cwd);
  }

  /** Every listed session, newest first, hidden and archived ones included: the
   * transcript file where there is one, else the Codex App or ZCode database. */
  private async opSearch(args: CliOpArgs["search"], budget: number): Promise<{ hits: Array<{ ref: CliSessionRef; snippet: string }> }> {
    const sources: SearchSource[] = [];
    for (const row of this.discovery.snapshot().sort((a, b) => b.lastActivityAt - a.lastActivityAt)) {
      let ref: CliSessionRef;
      try {
        ref = cliRef(row.engine, row.nativeId);
      } catch {
        continue;
      }
      const file = this.discovery.transcriptFor(ref);
      if (file) {
        sources.push({ ref, engine: row.engine, file });
        continue;
      }
      const chat = this.watchSourceFor(ref, row);
      if (chat) sources.push({ ref, engine: row.engine, items: () => allItems(chat.db, chat.chat.threadId) });
    }
    const hits = await searchSessions(sources, args.query, {
      ...(args.limit === undefined ? {} : { limit: args.limit }),
      budgetMs: Math.max(500, Math.min(this.options.searchBudgetMs ?? 8000, budget - 500)),
    });
    return { hits };
  }

  /** Writes one file the user attached to a session where the CLI can read it:
   * `<tmp>/nexbot-attachments/<engine>-<nativeId>/<8 hex>-<safe name>`. */
  private async opAttach(args: CliOpArgs["attach"]): Promise<{ path: string }> {
    const parsed = parseCliRef(args.ref);
    if (!parsed) throw new OpFailure("invalid");
    this.session(args.ref);
    const size = base64DecodedLength(args.data);
    if (size < 0) throw new OpFailure("invalid");
    if (size > CLI_ATTACH_MAX_BYTES) throw new OpFailure("too_large", "附件不能超过 8 MB");
    const dir = path.join(this.options.attachDir ?? path.join(os.tmpdir(), "nexbot-attachments"), `${parsed.engine}-${parsed.nativeId}`);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${randomBytes(4).toString("hex")}-${safeFileName(args.name)}`);
    await writeFile(file, Buffer.from(args.data, "base64"), { flag: "wx", mode: 0o600 });
    return { path: path.resolve(file) };
  }

  /** Core relays the answer to a pending request; delegates to the owning harness driver, screen prompt, or hook server. */
  private async opAnswer(args: CliOpArgs["answer"]): Promise<{ outcome: string }> {
    for (const driver of this.drivers.values()) {
      if (driver.hasRequest?.(args.id) && driver.answerRequest) return driver.answerRequest(args);
    }
    if (this.screens.owns(args.id)) {
      try {
        return { outcome: await this.screens.answer(args) };
      } catch (error) {
        if (error instanceof ScreenPromptError) throw new OpFailure(error.code, error.code === "not_found" ? "request is closed" : undefined);
        throw error;
      }
    }
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

/** Harnesses without modelPicker refuse model or effort flags instead of silently dropping them. */
function refuseUnsupportedLaunchOptions(engine: CliEngine, args: { model?: string; effort?: string }): void {
  const adapter = harnessFor(engine);
  if (adapter && !adapter.features.modelPicker && (args.model !== undefined || args.effort !== undefined)) {
    throw new OpFailure("invalid", `${adapter.label} 不支持选择模型和推理强度`);
  }
}

/** The launch options of an op. A new session (`start`) runs with full access unless the user chose
 * "ask"; a continued one keeps the CLI's own settings unless the user chose otherwise. */
function launchOptionsOf(args: CliLaunchOptions, fallback?: CliPermissionMode): CliLaunchOptions {
  const permissions = args.permissions ?? fallback;
  return {
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.effort !== undefined ? { effort: args.effort } : {}),
    ...(permissions !== undefined ? { permissions } : {}),
  };
}

/** Up to SEARCH_DB_ITEMS items of a database chat, oldest first. The Codex App
 * database reads the whole chat per page anyway and hands it over at once; ZCode
 * caps a page, so it is read a page at a time. */
const SEARCH_DB_ITEMS = 5000;
async function allItems(db: { page(id: string, o?: { before?: string; limit?: number }): Promise<{ items: CliItem[]; more: boolean }> }, threadId: string): Promise<CliItem[]> {
  const pages: CliItem[][] = [];
  let before: string | undefined;
  let count = 0;
  for (let round = 0; round < 200 && count < SEARCH_DB_ITEMS; round += 1) {
    const page = await db.page(threadId, { ...(before ? { before } : {}), limit: SEARCH_DB_ITEMS - count });
    count += page.items.length;
    pages.unshift(page.items);
    if (!page.more || page.items.length === 0 || page.items[0].id === before) break;
    before = page.items[0].id;
  }
  return pages.flat();
}

/** A file name that is safe on every platform: letters, digits, `.`, `_` and `-`
 * only, no leading dot, at most 100 characters with the extension kept. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  let safe = base.normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/_+/g, "_").replace(/^[._]+/, "").replace(/[._]+$/, "");
  if (safe.length > 100) {
    const dot = safe.lastIndexOf(".");
    const ext = dot > 0 && safe.length - dot <= 16 ? safe.slice(dot) : "";
    safe = safe.slice(0, 100 - ext.length) + ext;
  }
  return safe || "file";
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

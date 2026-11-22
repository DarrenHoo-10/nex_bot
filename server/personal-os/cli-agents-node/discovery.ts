// Session discovery for the Agent bridge (plan 3.3, "merge and report"):
// runs the Claude and Codex scans on their timers, merges the results into one
// list, diffs it against what was last reported and emits `{upserts, removes}`
// at most every SESSIONS_COALESCE_MS.
import {
  MAX_SESSIONS,
  SCAN_HISTORY_MS,
  SCAN_LIVE_MS,
  SESSIONS_COALESCE_MS,
  cliRef,
  type CliSessionRef,
  type CliSessionWire,
} from "../../../shared/cli-agents.ts";
import {
  claudeConfigDirs,
  mergeClaude,
  scanHistory,
  scanLive,
  type ClaudeHistoryEntry,
  type LiveClaudeSession,
  type ScanLiveOptions,
} from "./claude.ts";
import { ClaudeDesktopSessions, claudeDesktopRoots, desktopAlwaysListed, EMPTY_DESKTOP_INDEX, type DesktopIndex } from "./claude-desktop.ts";
import { CodexScanner, codexHomes, type CodexScannerOptions } from "./codex.ts";
import type { CodexAppDb } from "./codex-app-db.ts";
import type { RepoRootLookup } from "./device-git.ts";
import type { AppChat, LocalSession, SendRoute } from "./items.ts";
import { ZcodeScanner, type ZcodeScannerOptions } from "./zcode.ts";

export interface SessionsDiff {
  /** true for the first report and after resync(): `upserts` is every session and `removes` is empty */
  full: boolean;
  upserts: CliSessionWire[];
  removes: CliSessionRef[];
}

export interface SessionDiscoveryOptions {
  /** defaults to ~/.claude plus CLAUDE_CONFIG_DIR; tests pass temp directories */
  claudeDirs?: string[];
  /** defaults to ~/.codex plus CODEX_HOME */
  codexHomes?: string[];
  /** defaults to ~/.zcode/cli; tests pass temp directories */
  zcodeHomes?: string[];
  zcode?: ZcodeScannerOptions;
  /** Claude desktop app data folders (the sessions' archive and fork state). Defaults to the
   * platform's own folders when `claudeDirs` is not overridden, and to none otherwise. */
  claudeDesktopRoots?: string[];
  /** resolves each session's `repoRoot` with git; opt-in like the ZCode homes, so tests that
   * spell out their sources never spawn git */
  repoRoots?: RepoRootLookup;
  /** sessions that run in a nex_bot terminal: ref to herdr-core terminal address */
  nexbotTerminals?: () => ReadonlyMap<string, string>;
  /** Codex threads loaded in a shared app-server daemon, per CODEX_HOME: `threads` is the last known
   * set (undefined: no daemon), `refresh` asks the daemon again. Never starts one. */
  codexDaemon?: {
    threads(home: string): ReadonlySet<string> | undefined;
    refresh(home: string): Promise<void>;
  };
  onChange?: (diff: SessionsDiff) => void;
  onError?: (error: unknown) => void;
  liveMs?: number;
  historyMs?: number;
  coalesceMs?: number;
  now?: () => number;
  claudeLive?: ScanLiveOptions;
  codex?: CodexScannerOptions;
}

type Row = LocalSession;

export class SessionDiscovery {
  private readonly claudeDirs: string[];
  private readonly scanners: CodexScanner[];
  private readonly zcodes: ZcodeScanner[];
  private readonly options: SessionDiscoveryOptions;
  private readonly desktop: ClaudeDesktopSessions | null;
  /** the desktop app's sidebar index (sessions, earlier transcripts, deletions), from the last history scan */
  private desktopIndex: DesktopIndex = EMPTY_DESKTOP_INDEX;

  private readonly live = new Map<string, LiveClaudeSession[]>();
  private readonly history = new Map<string, ClaudeHistoryEntry[]>();
  private readonly codex = new Map<string, Row[]>();
  private readonly zcodeRows = new Map<string, Row[]>();
  private rows = new Map<string, Row>();
  /** wire JSON of the last reported rows, by ref */
  private reported = new Map<string, string>();

  private liveTimer: NodeJS.Timeout | null = null;
  private historyTimer: NodeJS.Timeout | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private lastEmitAt = Number.NEGATIVE_INFINITY;
  private emittedOnce = false;
  private forceFull = false;
  private stopped = true;
  private scanned = false;
  private liveBusy: Promise<void> | null = null;
  private historyBusy: Promise<void> | null = null;
  /** live session ids whose transcript was already looked for out of schedule */
  private readonly looked = new Set<string>();

  constructor(options: SessionDiscoveryOptions = {}) {
    this.options = options;
    this.claudeDirs = options.claudeDirs ?? claudeConfigDirs();
    this.scanners = (options.codexHomes ?? codexHomes()).map((home) => new CodexScanner(home, options.codex));
    // opt-in, resolved by the bridge: tests that spell out their other sources
    // stay hermetic instead of picking up the developer's own ZCode database
    this.zcodes = (options.zcodeHomes ?? []).map((home) => new ZcodeScanner(home, options.zcode));
    const desktopRoots = options.claudeDesktopRoots ?? (options.claudeDirs ? [] : claudeDesktopRoots());
    this.desktop = desktopRoots.length > 0 ? new ClaudeDesktopSessions(desktopRoots) : null;
  }

  /** Runs one full round, reports it, then keeps scanning on the timers. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.refresh({ flush: true });
    if (this.stopped) return;
    this.liveTimer = setInterval(() => void this.scanLiveRound(), this.options.liveMs ?? SCAN_LIVE_MS);
    this.historyTimer = setInterval(() => void this.scanHistoryRound(), this.options.historyMs ?? SCAN_HISTORY_MS);
    this.liveTimer.unref();
    this.historyTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.liveTimer) clearInterval(this.liveTimer);
    if (this.historyTimer) clearInterval(this.historyTimer);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.liveTimer = this.historyTimer = this.emitTimer = null;
  }

  /** Every session as the wire rows Core receives, newest activity first. */
  snapshot(): CliSessionWire[] {
    return [...this.rows.values()].map(toWire);
  }

  /** One session as the wire row, or null when it is not in the list. */
  get(ref: string): CliSessionWire | null {
    const row = this.rows.get(ref);
    return row ? toWire(row) : null;
  }

  /** Recomputes the list from the scans already done (the nex_bot terminal map
   * changed) and reports the difference, at once with `flush`. */
  reapply(options: { flush?: boolean } = {}): void {
    // before the first scan finished there is nothing to report: an empty full list would wipe Core's copy
    if (this.stopped || !this.scanned) return;
    this.recompute();
    this.schedule(options.flush === true);
  }

  /** The session file on this computer, or null when there is none. */
  transcriptFor(ref: string): string | null {
    const row = this.rows.get(ref);
    return row && row.transcript ? row.transcript : null;
  }

  /** How a message reaches a session outside nex_bot's terminals (device only), or null. */
  routeFor(ref: string): SendRoute | null {
    return this.rows.get(ref)?.route ?? null;
  }

  /** The App-database chat behind a row that has no session file, or null. */
  appChatFor(ref: string): { chat: AppChat; db: CodexAppDb } | null {
    const chat = this.rows.get(ref)?.appChat;
    if (!chat) return null;
    const scanner = this.scanners.find((candidate) => candidate.home === chat.home);
    return scanner ? { chat, db: scanner.appDb } : null;
  }

  /** The ZCode database behind a row with no session file, polled like an App chat. */
  zcodeChatFor(ref: string): { chat: { threadId: string }; db: ZcodeScanner["db"] } | null {
    const row = this.rows.get(ref);
    if (!row || row.engine !== "zcode") return null;
    const scanner = this.zcodes.find((candidate) => candidate.home === row.configDir);
    return scanner ? { chat: { threadId: row.nativeId }, db: scanner.db } : null;
  }

  /** Stops the ZCode database handles. */
  closeZcode(): void {
    for (const scanner of this.zcodes) scanner.close();
  }

  /** The next report is a full one (after the link to Core was re-established). */
  resync(): void {
    this.forceFull = true;
    this.schedule(true);
  }

  /** Runs the live and history scans now. With `flush` the diff is reported
   * immediately instead of on the coalescing timer. */
  async refresh(options: { flush?: boolean } = {}): Promise<void> {
    // live first: the history scan must also find the transcripts of the live sessions
    await this.scanLiveRound(false);
    await this.scanHistoryRound(false);
    await this.warmRoots();
    this.scanned = true;
    this.recompute();
    this.schedule(options.flush === true);
  }

  // -------------------------------------------------------------------------

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private fail(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // a failing error handler must not stop scanning
    }
  }

  private scanLiveRound(report = true): Promise<void> {
    if (this.liveBusy) return this.liveBusy;
    const run = (async () => {
      await Promise.all([
        ...this.claudeDirs.map(async (dir) => {
          try {
            this.live.set(dir, await scanLive(dir, this.options.claudeLive));
          } catch (error) {
            this.fail(error);
          }
        }),
        ...this.scanners.map(async (scanner) => {
          try {
            // which threads the shared daemon has loaded; a failing daemon only means "none"
            await this.options.codexDaemon?.refresh(scanner.home).catch((error) => this.fail(error));
            this.codex.set(scanner.home, await scanner.scan({ now: this.now() }));
          } catch (error) {
            this.fail(error);
          }
        }),
        ...this.zcodes.map(async (scanner) => {
          try {
            this.zcodeRows.set(scanner.home, await scanner.scan());
          } catch (error) {
            this.fail(error);
          }
        }),
      ]);
      if (report && !this.stopped && this.unresolvedLive()) await this.scanHistoryRound(false);
      if (report && !this.stopped) {
        await this.warmRoots();
        if (this.stopped) return;
        this.recompute();
        this.schedule(false);
      }
    })().finally(() => {
      this.liveBusy = null;
    });
    this.liveBusy = run;
    return run;
  }

  /** A live session whose transcript the last history scan did not include. */
  private unresolvedLive(): boolean {
    let found = false;
    const stillLive = new Set<string>();
    for (const [dir, lives] of this.live) {
      const known = new Set((this.history.get(dir) ?? []).map((e) => e.sessionId));
      for (const l of lives) {
        const key = `${dir}\0${l.sessionId}`;
        stillLive.add(key);
        if (known.has(l.sessionId)) this.looked.delete(key);
        else if (!this.looked.has(key)) {
          this.looked.add(key);
          found = true;
        }
      }
    }
    for (const key of this.looked) if (!stillLive.has(key)) this.looked.delete(key);
    return found;
  }

  private scanHistoryRound(report = true): Promise<void> {
    if (this.historyBusy) return this.historyBusy;
    const run = (async () => {
      // the sidebar index first: every session it lists is read whatever its age
      try {
        if (this.desktop) this.desktopIndex = await this.desktop.scan();
      } catch (error) {
        this.fail(error);
      }
      const sidebar = desktopAlwaysListed(this.desktopIndex);
      await Promise.all(
        this.claudeDirs.map(async (dir) => {
          try {
            const include = [...(this.live.get(dir) ?? []).map((l) => l.sessionId), ...sidebar];
            this.history.set(dir, await scanHistory(dir, { now: this.now(), include }));
          } catch (error) {
            this.fail(error);
          }
        }),
      );
      if (report && !this.stopped) {
        await this.warmRoots();
        if (this.stopped) return;
        this.recompute();
        this.schedule(false);
      }
    })().finally(() => {
      this.historyBusy = null;
    });
    this.historyBusy = run;
    return run;
  }

  /** Asks git for the repository root of every directory the scans found, before the list is built. */
  private async warmRoots(): Promise<void> {
    const roots = this.options.repoRoots;
    if (!roots) return;
    const cwds = new Set<string>();
    for (const lives of this.live.values()) for (const l of lives) cwds.add(l.cwd);
    for (const entries of this.history.values()) for (const e of entries) if (e.cwd) cwds.add(e.cwd);
    for (const rows of this.codex.values()) for (const r of rows) cwds.add(r.cwd);
    for (const rows of this.zcodeRows.values()) for (const r of rows) cwds.add(r.cwd);
    try {
      await roots.warm(cwds);
    } catch (error) {
      this.fail(error);
    }
  }

  private recompute(): void {
    const merged = new Map<string, Row>();
    const add = (row: Row): void => {
      let ref: string;
      try {
        ref = cliRef(row.engine, row.nativeId);
      } catch {
        return;
      }
      const existing = merged.get(ref);
      if (!existing || row.lastActivityAt > existing.lastActivityAt) merged.set(ref, row);
    };
    for (const dir of this.claudeDirs) {
      for (const row of mergeClaude(dir, this.live.get(dir) ?? [], this.history.get(dir) ?? [], { desktop: this.desktopIndex, now: this.now() })) add(row);
    }
    for (const rows of this.codex.values()) for (const row of rows) add(row);
    for (const rows of this.zcodeRows.values()) for (const row of rows) add(row);

    // the project each session belongs to (rows are copied: the scanners keep the originals in their caches)
    const roots = this.options.repoRoots;
    if (roots) {
      for (const [ref, row] of merged) {
        const repoRoot = roots.peek(row.cwd);
        if (repoRoot) merged.set(ref, { ...row, repoRoot });
      }
    }

    let terminals: ReadonlyMap<string, string> | undefined;
    try {
      terminals = this.options.nexbotTerminals?.();
    } catch (error) {
      this.fail(error);
    }
    // Codex threads loaded in the shared app-server daemon can be written to through it
    const daemon = this.options.codexDaemon;
    if (daemon) {
      for (const [ref, row] of merged) {
        if (row.engine !== "codex") continue;
        let loaded: ReadonlySet<string> | undefined;
        try {
          loaded = daemon.threads(row.configDir);
        } catch (error) {
          this.fail(error);
        }
        if (!loaded?.has(row.nativeId)) continue;
        const next: Row = { ...row, sendVia: "daemon", route: { via: "daemon", home: row.configDir, threadId: row.nativeId } };
        if (next.state === "stopped") next.state = "idle";
        delete next.writerUnknown;
        merged.set(ref, next);
      }
    }
    if (terminals) {
      for (const [ref, row] of merged) {
        const address = terminals.get(ref);
        if (!address) continue;
        const next: Row = { ...row, liveIn: "nexbot", terminal: address, sendVia: "terminal" };
        delete next.route;
        // a session in a live nex_bot terminal is not stopped, whatever its files say
        if (next.state === "stopped") next.state = "idle";
        delete next.writerUnknown;
        merged.set(ref, next);
      }
    }

    // newest first; sessions with a live process are never dropped by the cap
    const sorted = [...merged.entries()].sort((a, b) => b[1].lastActivityAt - a[1].lastActivityAt);
    const active = sorted.filter(([, row]) => row.state !== "stopped");
    const stopped = sorted.filter(([, row]) => row.state === "stopped").slice(0, Math.max(0, MAX_SESSIONS - active.length));
    const kept = new Map([...active, ...stopped].sort((a, b) => b[1].lastActivityAt - a[1].lastActivityAt).slice(0, MAX_SESSIONS));
    // a fork parent is only reported when it is in the list the report carries, so the
    // reference always resolves (the cap, an archive or a window edge may have dropped it)
    for (const [ref, row] of kept) {
      const forkOk = row.forkOf === undefined || (row.forkOf !== row.nativeId && kept.has(`${row.engine}:${row.forkOf}`));
      const sideOk = row.sideOf === undefined || (row.sideOf !== row.nativeId && kept.has(`${row.engine}:${row.sideOf}`));
      if (forkOk && sideOk) continue;
      const next: Row = { ...row };
      if (!forkOk) delete next.forkOf;
      if (!sideOk) delete next.sideOf;
      kept.set(ref, next);
    }
    this.rows = kept;
  }

  /** Emits now, or arranges one emission so that reports are at least
   * coalesceMs apart; changes in between are folded into that one report. */
  private schedule(immediate: boolean): void {
    if (this.stopped && !immediate) return;
    if (this.emitTimer) {
      if (!immediate) return;
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    const wait = immediate ? 0 : Math.max(0, this.lastEmitAt + (this.options.coalesceMs ?? SESSIONS_COALESCE_MS) - Date.now());
    if (wait === 0) {
      this.emit();
      return;
    }
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit();
    }, wait);
    this.emitTimer.unref();
  }

  private emit(): void {
    const full = !this.emittedOnce || this.forceFull;
    const current = new Map<string, string>();
    const upserts: CliSessionWire[] = [];
    for (const [ref, row] of this.rows) {
      const wire = toWire(row);
      const json = JSON.stringify(wire);
      current.set(ref, json);
      if (full || this.reported.get(ref) !== json) upserts.push(wire);
    }
    const removes: CliSessionRef[] = [];
    if (!full) for (const ref of this.reported.keys()) if (!current.has(ref)) removes.push(ref as CliSessionRef);
    if (!full && upserts.length === 0 && removes.length === 0) return;
    this.reported = current;
    this.emittedOnce = true;
    this.forceFull = false;
    this.lastEmitAt = Date.now();
    try {
      this.options.onChange?.({ full, upserts, removes });
    } catch (error) {
      this.fail(error);
    }
  }
}

/** The wire row: fixed key order, no transcript path, no undefined keys. */
function toWire(row: Row): CliSessionWire {
  const wire: CliSessionWire = {
    engine: row.engine,
    nativeId: row.nativeId,
    configDir: row.configDir,
    cwd: row.cwd,
    title: row.title,
    state: row.state,
    lastActivityAt: row.lastActivityAt,
  };
  if (row.gitBranch !== undefined) wire.gitBranch = row.gitBranch;
  if (row.waitingFor !== undefined) wire.waitingFor = row.waitingFor;
  if (row.liveIn !== undefined) wire.liveIn = row.liveIn;
  if (row.terminal !== undefined) wire.terminal = row.terminal;
  if (row.sendVia !== undefined) wire.sendVia = row.sendVia;
  if (row.repoRoot !== undefined) wire.repoRoot = row.repoRoot;
  if (row.forkOf !== undefined) wire.forkOf = row.forkOf;
  if (row.sideOf !== undefined) wire.sideOf = row.sideOf;
  if (row.model !== undefined) wire.model = row.model;
  if (row.cliVersion !== undefined) wire.cliVersion = row.cliVersion;
  if (row.context !== undefined) wire.context = { ...row.context };
  if (row.writerUnknown !== undefined) wire.writerUnknown = row.writerUnknown;
  return wire;
}

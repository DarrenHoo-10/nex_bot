// Harness adapters and extensible contracts (workbench plan section 2).
//
// Each CLI harness is described in one registry (`HarnessAdapter`):
//   1. capabilities (`caps`) and declarative feature flags (`features`)
//   2. transcript record mapping strategy (`transcript`, shared by reader & search)
//   3. runtime execution hooks (`HarnessDriver`, plugged into CliAgentBridge)
//   4. pluggable session discovery sources (`HarnessSessionSource`)
//
// Adding a new harness only requires registering its adapter (plus optional
// launch/model/driver strategies when it diverges from the default terminal +
// JSONL template); Core, TranscriptReader, searchSessions and the UI stay
// engine-agnostic.
import path from "node:path";
import type {
  CliEngine,
  CliItem,
  CliModelCatalog,
  CliOpArgs,
  CliOpResult,
  CliSendVia,
  CliSessionRef,
  CliSessionWire,
  SkillOption,
} from "../../../shared/cli-agents.ts";
import { agyRecordItems } from "./agy-native.ts";
import {
  claudeRecordToItems,
  codexRecordToItems,
  type ItemContext,
  type LocalSession,
  type MappedRecord,
  type TranscriptImage,
} from "./items.ts";

/** What one harness says about one of its sessions. The device reports this
 * per session; the UI renders from it and the workbench queue relies on the
 * steer/interrupt answers. */
export interface HarnessSessionCaps {
  /** how a message reaches the session right now; undefined: read-only */
  sendVia?: CliSendVia;
  /** guidance into the running turn is possible */
  steer: boolean;
  /** the current turn can be stopped */
  interrupt: boolean;
  /** the session runs in a nex_bot terminal this page can attach to */
  terminal: boolean;
  /** the device can create a real fork with inherited context */
  fork: "native" | "copy" | "none";
}

/** Declarative policy flags consumed by CliAgentBridge and SessionDiscovery so
 * engine checks stay centralized instead of branching on engine ids. */
export interface HarnessFeatures {
  /** How the executor discovers whether the harness is installed on this machine. */
  readonly probe: "cli" | "directory";
  /** Supports native session forking (`start` with `forkFrom`). */
  readonly fork: boolean;
  /** Supports selecting model/effort on launch or resume. */
  readonly modelPicker: boolean;
  /** Scans managed terminal screens for interactive approval prompts. */
  readonly screenPrompts: boolean;
  /** Infers turn end when a managed session transitions running -> idle. */
  readonly statusTurnFallback: boolean;
  /** Follows the transcript file for explicit turn end/abort markers. */
  readonly transcriptTurnTails: boolean;
  /** Supports hook plugins injected into managed terminals. */
  readonly hooks: boolean;
  /** Checks early terminal exit when another writer cannot be verified from locks. */
  readonly unknownWriterCheck: boolean;
  /** Env variable used to pass a non-default session config directory. */
  readonly configDirEnv?: {
    readonly variable: string;
    readonly defaultSubdir: string;
    /** Export configDir whenever present, even if it matches the default location. */
    readonly alwaysExport?: boolean;
  };
}

/** Per-harness transcript parsing strategy shared by TranscriptReader and searchSessions. */
export interface HarnessTranscriptStrategy {
  /** Maps one parsed JSONL record to zero or more wire-safe CliItems. */
  mapRecord(record: unknown, ctx: ItemContext): MappedRecord;
  /** Optional byte marker that upgrades a transcript file to an alternate format (e.g. Codex v2). */
  readonly alternateFormatMark?: Buffer;
  /** Retry image resolution without alternateFormat when the primary format yields no items. */
  readonly retryImageWithoutAlternateFormat?: boolean;
  /** Rewrite relative/local Markdown image links into private history locators. */
  readonly rewriteLocalImages?: boolean;
  /** Collapse duplicate compaction notices emitted by adjacent sources within 30 s. */
  readonly dedupeCompactionNotices?: boolean;
  /** Allow raw-line substring prefiltering by item id when locating pagination cursors. */
  readonly idPrefilter?: boolean;
  /** Optional search-optimized record mapper (defaults to `mapRecord(record, ctx).items`). */
  searchRecord?(record: unknown, ctx: ItemContext): CliItem[];
}

export interface HarnessAdapter {
  readonly id: CliEngine;
  readonly label: string;
  readonly features: HarnessFeatures;
  readonly transcript?: HarnessTranscriptStrategy;
  caps(session: CliSessionWire): HarnessSessionCaps;
}

/** Pluggable discovery source for non-default or future harnesses. */
export interface HarnessSessionSource {
  readonly id: CliEngine;
  scan(): Promise<void>;
  rows(): LocalSession[];
  close?(): void;
}

/** Common paging/image contract shared by non-file session stores (ACP, Codex App DB, ZCode DB). */
export interface PageableChat {
  marker(id: string): Promise<string>;
  page(id: string, options?: { before?: string; limit?: number }): Promise<{ items: CliItem[]; more: boolean }>;
  imageSource?(id: string, itemId: string, locator: string): Promise<TranscriptImage | undefined> | TranscriptImage | undefined;
}

export interface HarnessWatchSource {
  chat: { threadId: string };
  db: PageableChat;
}

/** Runtime execution strategy plugged into CliAgentBridge. Every hook is
 * optional: omitting one falls back to the shared herdr-core terminal and
 * TranscriptReader template, so standard CLI harnesses need minimal code. */
export interface HarnessDriver {
  readonly id: CliEngine;
  /** Custom installation probe during `prepare()`; omitted => standard CLI binary probe. */
  probe?(): Promise<{ available: boolean; version: string | null }>;
  /** Custom non-file source for live watch, history image resolution, and search. */
  watchSource?(ref: CliSessionRef, row: CliSessionWire): HarnessWatchSource | null;
  /** Custom transcript page reader (returns null to fall through to file/watchSource). */
  read?(ref: CliSessionRef, row: CliSessionWire, before: string | undefined, limit: number): Promise<{ items: CliItem[]; more: boolean } | null>;
  /** Custom session start after shared worktree/idempotency/cwd checks. */
  start?(args: CliOpArgs["start"], cwd: string, budget: number): Promise<CliOpResult["start"]>;
  /** Custom session continue (returns null to fall through to default terminal resume). */
  continueSession?(args: CliOpArgs["continue"], row: CliSessionWire, budget: number): Promise<CliOpResult["continue"] | null>;
  /** Send to a session running outside nex_bot's managed terminals. */
  sendOutside?(args: CliOpArgs["send"], row: CliSessionWire, steer?: boolean): Promise<CliOpResult["send"] | null>;
  /** Engine-specific steering (before falling back to managed terminal send). */
  steer?(args: CliOpArgs["steer"], row: CliSessionWire, managedAddress: string | null, deadline: number): Promise<CliOpResult["steer"] | null>;
  /** Interrupt a session running outside nex_bot's managed terminals. */
  interruptOutside?(args: CliOpArgs["interrupt"], row: CliSessionWire): Promise<{ outcome: string } | null>;
  /** Custom model catalog provider (falls back to `cliModels(id, ...)`). */
  models?(): Promise<CliModelCatalog>;
  /** Skill catalog provider (returns null when unsupported). */
  skills?(session: CliSessionWire | undefined, cwd: string): Promise<{ skills: SkillOption[] } | null>;
  /** Extra environment variables merged when spawning this harness in a terminal. */
  extraEnv?(): Promise<Record<string, string>>;
  /** Pending approval/question request routing owned by this driver. */
  hasRequest?(id: string): boolean;
  answerRequest?(args: CliOpArgs["answer"]): Promise<{ outcome: string }>;
  /** Natively archive or restore (unarchive) a session on disk / via daemon. */
  archive?(ref: CliSessionRef, row: CliSessionWire, archived: boolean): Promise<void>;
  /** Permanently delete a native session on disk / via daemon. */
  deleteSession?(ref: CliSessionRef, row: CliSessionWire): Promise<void>;
  /** Called when the Core link comes back so open driver requests are re-announced. */
  relink?(): void;
  /** Called when CliAgentBridge detaches. */
  close?(): Promise<void> | void;
}

/** A session inside one of nex_bot's own herdr-core terminals: everything
 * works, because the terminal is ours. */
const terminalCaps = (session: CliSessionWire): HarnessSessionCaps =>
  session.terminal ? { sendVia: "terminal", steer: true, interrupt: true, terminal: true, fork: "copy" } : none();

const none = (): HarnessSessionCaps => ({ steer: false, interrupt: false, terminal: false, fork: "none" });

const CODEX_V2_MARK = Buffer.from('"item_completed"');

const claude: HarnessAdapter = {
  id: "claude",
  label: "Claude Code",
  features: {
    probe: "cli",
    fork: true,
    modelPicker: true,
    screenPrompts: true,
    statusTurnFallback: true,
    transcriptTurnTails: false,
    hooks: true,
    unknownWriterCheck: false,
    configDirEnv: { variable: "CLAUDE_CONFIG_DIR", defaultSubdir: ".claude" },
  },
  transcript: {
    mapRecord: (record, ctx) => claudeRecordToItems(record, ctx),
    rewriteLocalImages: true,
    dedupeCompactionNotices: true,
    idPrefilter: true,
  },
  caps(session) {
    if (session.terminal) return terminalCaps(session);
    // Claude’s inbox takes “send now” for steering and stopping.
    if (session.sendVia === "inbox") return { sendVia: "inbox", steer: true, interrupt: true, terminal: false, fork: "copy" };
    return none();
  },
};

const codex: HarnessAdapter = {
  id: "codex",
  label: "Codex",
  features: {
    probe: "cli",
    fork: true,
    modelPicker: true,
    screenPrompts: true,
    statusTurnFallback: false,
    transcriptTurnTails: true,
    hooks: false,
    unknownWriterCheck: true,
    configDirEnv: { variable: "CODEX_HOME", defaultSubdir: ".codex" },
  },
  transcript: {
    mapRecord: (record, ctx) => codexRecordToItems(record, ctx),
    alternateFormatMark: CODEX_V2_MARK,
    retryImageWithoutAlternateFormat: true,
    rewriteLocalImages: true,
    dedupeCompactionNotices: true,
    idPrefilter: true,
    searchRecord(record, ctx) {
      // v1 files carry text in response_item records, v2 files in event_msg item_completed
      const v2 = typeof record === "object" && record !== null && (record as { type?: unknown }).type === "event_msg";
      return codexRecordToItems(record, { ...ctx, codexV2: v2 }).items;
    },
  },
  caps(session) {
    if (session.terminal) return terminalCaps(session);
    // a thread loaded in a shared app-server daemon takes messages and steers
    // the running turn; there is no interrupt path through the daemon
    if (session.sendVia === "daemon") return { sendVia: "daemon", steer: true, interrupt: false, terminal: false, fork: "copy" };
    if (session.sendVia === "inbox") return { sendVia: "inbox", steer: false, interrupt: false, terminal: false, fork: "copy" };
    return none();
  },
};

const zcode: HarnessAdapter = {
  id: "zcode",
  label: "ZCode",
  features: {
    probe: "directory",
    fork: false,
    modelPicker: true,
    screenPrompts: false,
    statusTurnFallback: false,
    transcriptTurnTails: false,
    hooks: false,
    unknownWriterCheck: false,
  },
  caps(session) {
    if (session.terminal) return terminalCaps(session);
    // a session the device's host channel has attached takes messages, guidance
    // and interrupts; without an attached host the sessions stay read-only
    if (session.sendVia === "host") return { sendVia: "host", steer: true, interrupt: true, terminal: false, fork: "none" };
    return none();
  },
};

const agy: HarnessAdapter = {
  id: "agy",
  label: "Antigravity CLI",
  features: {
    probe: "cli",
    fork: false,
    modelPicker: true,
    screenPrompts: false,
    statusTurnFallback: true,
    transcriptTurnTails: false,
    hooks: false,
    unknownWriterCheck: false,
    configDirEnv: { variable: "ANTIGRAVITY_CLI_CONFIG_DIR", defaultSubdir: path.join(".gemini", "antigravity-cli"), alwaysExport: true },
  },
  transcript: {
    mapRecord: (record, ctx) => ({ items: agyRecordItems(record, ctx.fallbackTs) }),
    rewriteLocalImages: false,
    dedupeCompactionNotices: false,
    idPrefilter: false,
  },
  caps(session) {
    if (session.terminal) return { ...terminalCaps(session), fork: "none" };
    if (session.sendVia === "acp") return { sendVia: "acp", steer: true, interrupt: true, terminal: false, fork: "none" };
    return none();
  },
};

const BUILTIN_ADAPTERS: readonly HarnessAdapter[] = [claude, codex, zcode, agy];

/** Extensible registry of harness adapters; tests and plugins may instantiate
 * isolated registries or register overrides with a clean disposer. */
export class HarnessRegistry {
  private readonly adapters = new Map<string, HarnessAdapter>();

  constructor(initial: readonly HarnessAdapter[] = BUILTIN_ADAPTERS) {
    for (const adapter of initial) this.adapters.set(adapter.id, adapter);
  }

  get(engine: CliEngine | string): HarnessAdapter | null {
    return this.adapters.get(engine) ?? null;
  }

  all(): readonly HarnessAdapter[] {
    return [...this.adapters.values()];
  }

  register(adapter: HarnessAdapter): () => void {
    const previous = this.adapters.get(adapter.id);
    this.adapters.set(adapter.id, adapter);
    return () => {
      if (this.adapters.get(adapter.id) !== adapter) return;
      if (previous) this.adapters.set(adapter.id, previous);
      else this.adapters.delete(adapter.id);
    };
  }
}

const defaultRegistry = new HarnessRegistry();

export function createHarnessRegistry(initial: readonly HarnessAdapter[] = BUILTIN_ADAPTERS): HarnessRegistry {
  return new HarnessRegistry(initial);
}

export function registerHarness(adapter: HarnessAdapter): () => void {
  return defaultRegistry.register(adapter);
}

export function harnessFor(engine: CliEngine): HarnessAdapter | null {
  return defaultRegistry.get(engine);
}

export function allHarnesses(): readonly HarnessAdapter[] {
  return defaultRegistry.all();
}

const normalizeDir = (dir: string, platform: NodeJS.Platform): string => {
  const resolved = (platform === "win32" ? path.win32 : path.posix).resolve(dir).replace(/[\\/]+$/, "");
  return platform === "win32" ? resolved.toLowerCase() : resolved;
};

/** Computes the engine-specific configDir environment override from the harness descriptor. */
export function harnessConfigEnv(
  engine: CliEngine,
  configDir: string | undefined,
  homedir: string,
  platform: NodeJS.Platform,
  registry: HarnessRegistry = defaultRegistry,
): Record<string, string> {
  const spec = registry.get(engine)?.features.configDirEnv;
  if (!spec || !configDir) return {};
  if (spec.alwaysExport) return { [spec.variable]: configDir };
  const fallback = (platform === "win32" ? path.win32 : path.posix).join(homedir, spec.defaultSubdir);
  return normalizeDir(configDir, platform) !== normalizeDir(fallback, platform) ? { [spec.variable]: configDir } : {};
}

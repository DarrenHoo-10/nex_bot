// Shared contract for Agent mode ("cli-agent"): the session rows, items,
// device protocol (DCP `cli.*`), browser WebSocket messages, limits and the
// strict parsers every side runs on whatever arrives off the wire. Pure
// TypeScript with no Node-only APIs, so Core, the device and the web client
// import the same file. Every parse* function returns null on any invalid
// input and never throws; objects are rebuilt field by field, so unknown
// extra keys are dropped and nothing from the wire is aliased.
//
// Design: docs/design/agent-mode.md. Plan: docs/plans/2026-11-15-agent-mode-implementation.md.

// ---------------------------------------------------------------------------
// Constants

export const CLI_AGENTS_PROTOCOL_VERSION = 1;
export const HERDR_CORE_VERSION = "0.1.21";

/** One item's text-ish limits. Byte limits are applied by the device with
 * truncateUtf8; the parsers cap the same numbers as UTF-16 units, which is
 * never stricter than a byte cap the device already honoured. */
export const MAX_SEND_TEXT = 32 * 1024;
export const TOOL_OUTPUT_MAX = 64 * 1024;
export const SUMMARY_MAX = 2 * 1024;
/** user and assistant text; larger replies are cut by the device */
export const ITEM_TEXT_MAX = 256 * 1024;
export const PAGE_SIZE = 40;
export const CORE_ITEM_CACHE = 300;
export const MAX_ITEMS_PER_MESSAGE = 200;

export const TERM_DEFAULT = { cols: 120, rows: 36 } as const;
export const TERM_LIMITS = { minCols: 20, maxCols: 500, minRows: 5, maxRows: 200 } as const;
export const TERM_HISTORY = 2000;

export const STREAM_INITIAL_CREDIT = 256 * 1024;
export const CORE_STREAM_BUFFER_MAX = 1024 * 1024;
export const FRAME_PAYLOAD_MAX = 64 * 1024;
export const CREDIT_CHUNK = 32 * 1024;

export const WS_PING_MS = 20_000;
export const WS_PONG_TIMEOUT_MS = 45_000;

export const SCAN_LIVE_MS = 2000;
export const SCAN_HISTORY_MS = 15_000;
export const HISTORY_DAYS = 14;
export const MAX_SESSIONS = 300;
export const SESSIONS_COALESCE_MS = 500;

/** Size caps the parsers enforce on session rows and messages. */
export const CLI_LIMITS = {
  title: 300,
  cwd: 4096,
  configDir: 4096,
  gitBranch: 300,
  waitingFor: 300,
  terminal: 512,
  model: 200,
  cliVersion: 100,
  nativeId: 200,
  deviceId: 128,
  itemId: 200,
  toolName: 200,
  noticeText: 4096,
  imagePath: 4096,
  images: 20,
  opId: 64,
  req: 64,
  reason: 200,
  message: 1000,
  deviceName: 200,
  devices: 200,
  /** rows in a browser `list` across all of the user's devices */
  listSessions: 5000,
  deadlineMs: 120_000,
  /** pending permission / question requests (cli.request) */
  requestId: 128,
  requestTool: 200,
  requestOptions: 20,
  requestOption: 200,
  requestQuestions: 8,
  requestQuestion: 1000,
  requestDescription: 1000,
  /** the tool's arguments as shown on a permission card */
  requestDetail: 4000,
  requestAnswer: 4096,
  /** error text a cli.turn carries (it may name a usage-limit reset time) */
  turnError: 1000,
  answerMessage: 2000,
  requestsPerSession: 50,
} as const;

// ---------------------------------------------------------------------------
// Basic vocabulary

export type CliEngine = "claude" | "codex" | "zcode";
export type CliSessionState = "running" | "waiting" | "idle" | "stopped";
export type CliLiveIn = "nexbot" | "terminal" | "desktop" | "background";

export const CLI_ENGINES: readonly CliEngine[] = ["claude", "codex", "zcode"];
export const CLI_SESSION_STATES: readonly CliSessionState[] = ["running", "waiting", "idle", "stopped"];
export const CLI_LIVE_IN: readonly CliLiveIn[] = ["nexbot", "terminal", "desktop", "background"];

/** How the device can put a message into a session: its nex_bot terminal, the
 * inbox of a Claude session running on the computer, a Codex app-server daemon
 * the device joined, or the ZCode host the device attached to. Absent: the
 * session cannot be written to. */
export type CliSendVia = "terminal" | "inbox" | "daemon" | "host";
export const CLI_SEND_VIA: readonly CliSendVia[] = ["terminal", "inbox", "daemon", "host"];

/** How the user wants a composed message delivered (workbench plan section 3):
 * straight into the session, held in the outbox until the turn ends, or fed to
 * the running turn as guidance. */
export type CliDeliveryAction = "send" | "queue" | "steer";
export const CLI_DELIVERY_ACTIONS: readonly CliDeliveryAction[] = ["send", "queue", "steer"];

/** What a device knows about a sent message: `confirmed` means it was seen in
 * the session, `unconfirmed` that it was handed over but never seen. */
export type CliDelivery = "confirmed" | "unconfirmed";
export const CLI_DELIVERY: readonly CliDelivery[] = ["confirmed", "unconfirmed"];

export function isCliEngine(value: unknown): value is CliEngine {
  return value === "claude" || value === "codex" || value === "zcode";
}

/** Session id on the device link: `<engine>:<nativeId>`. The device never
 * composes a deviceId; Core's key is `<deviceId>:<ref>`. */
export type CliSessionRef = `${CliEngine}:${string}`;
export type CliSessionKey = `${string}:${CliEngine}:${string}`;

// A native id ends up in `--resume <id>` and in file names, so it is a plain
// token that starts alphanumeric. Device ids are Core-generated tokens.
const NATIVE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._=-]*$/;
const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isCliNativeId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= CLI_LIMITS.nativeId && NATIVE_ID_RE.test(value);
}

export function isCliDeviceId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= CLI_LIMITS.deviceId && DEVICE_ID_RE.test(value);
}

/** Builds a ref. Throws a TypeError on an invalid engine or native id: both
 * come from our own scanners, so a bad one is a bug, not input. */
export function cliRef(engine: CliEngine, nativeId: string): CliSessionRef {
  if (!isCliEngine(engine)) throw new TypeError("invalid cli engine");
  if (!isCliNativeId(nativeId)) throw new TypeError("invalid cli native id");
  return `${engine}:${nativeId}`;
}

export function parseCliRef(value: unknown): { engine: CliEngine; nativeId: string } | null {
  if (typeof value !== "string" || value.length > CLI_LIMITS.nativeId + 8) return null;
  const parts = value.split(":");
  if (parts.length !== 2) return null;
  const [engine, nativeId] = parts;
  if (!isCliEngine(engine) || !isCliNativeId(nativeId)) return null;
  return { engine, nativeId };
}

export function isCliRef(value: unknown): value is CliSessionRef {
  return parseCliRef(value) !== null;
}

/** Throws a TypeError when the device id or ref is invalid. */
export function cliKey(deviceId: string, ref: CliSessionRef | string): CliSessionKey {
  if (!isCliDeviceId(deviceId)) throw new TypeError("invalid cli device id");
  if (!isCliRef(ref)) throw new TypeError("invalid cli ref");
  return `${deviceId}:${ref}`;
}

export function parseCliKey(
  value: unknown,
): { deviceId: string; engine: CliEngine; nativeId: string; ref: CliSessionRef } | null {
  if (typeof value !== "string" || value.length > CLI_LIMITS.deviceId + CLI_LIMITS.nativeId + 16) return null;
  const parts = value.split(":");
  if (parts.length !== 3) return null;
  const [deviceId, engine, nativeId] = parts;
  if (!isCliDeviceId(deviceId) || !isCliEngine(engine) || !isCliNativeId(nativeId)) return null;
  return { deviceId, engine, nativeId, ref: `${engine}:${nativeId}` };
}

export function isCliKey(value: unknown): value is CliSessionKey {
  return parseCliKey(value) !== null;
}

// ---------------------------------------------------------------------------
// Sessions

/** What a device sends for one session. Never a local file path. */
/** How full a session's context is: the tokens its last request carried, and the window when known. */
export interface CliContextUsage { used: number; window?: number }

export interface CliSessionWire {
  engine: CliEngine;
  nativeId: string;
  configDir: string;
  cwd: string;
  title: string;
  gitBranch?: string;
  state: CliSessionState;
  waitingFor?: string;
  liveIn?: CliLiveIn;
  /** herdr-core terminal address, present when the session runs in a nex_bot terminal */
  terminal?: string;
  /** how a message can reach the session; set by the device */
  sendVia?: CliSendVia;
  /** absolute path of the repository's main worktree for `cwd`, as the device
   * sees it (a linked worktree reports its main checkout); absent outside git */
  repoRoot?: string;
  /** nativeId of another session of the same device and engine this one was
   * forked or continued from; only set when that session is in the device's list */
  forkOf?: string;
  /** nativeId of the session (same device and engine) this one is a side chat of
   * (a /btw question in the desktop app): shown in that session's side tabs, not as a row */
  sideOf?: string;
  model?: string;
  cliVersion?: string;
  /** what the last request of the session carried; absent until the CLI wrote one down */
  context?: CliContextUsage;
  /** epoch ms */
  lastActivityAt: number;
  /** Codex only: who writes the session file could not be determined */
  writerUnknown?: boolean;
}

/** What Core sends to browsers. */
export interface CliSessionView extends CliSessionWire {
  key: CliSessionKey;
  deviceId: string;
  hidden: boolean;
  online: boolean;
}

// ---------------------------------------------------------------------------
// Items (plan 3.4)

export type CliToolStatus = "running" | "ok" | "error";
export type CliNoticeLevel = "info" | "error";
export type CliTurnPhase = "started" | "ended" | "aborted";

export type CliItem =
  | { kind: "user"; id: string; ts: number; text: string; images?: string[]; queued?: boolean }
  | { kind: "assistant"; id: string; ts: number; text: string }
  | { kind: "thinking"; id: string; ts: number; text: string }
  | {
      kind: "tool";
      id: string;
      ts: number;
      name: string;
      input: string;
      status: CliToolStatus;
      output?: string;
    }
  | { kind: "notice"; id: string; ts: number; level: CliNoticeLevel; text: string }
  | { kind: "turn"; id: string; ts: number; phase: CliTurnPhase };

// ---------------------------------------------------------------------------
// Turn ends and pending requests (design sections 8 and 9)

/** Assistant blocks after an open turn boundary are still streaming. Older
 * transcript formats can lack markers, so a later user message also closes it. */
export function completedCliReplies(items: readonly CliItem[], active: boolean): Set<string> {
  const complete = new Set<string>();
  let closed = !active;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "assistant" && closed) complete.add(item.id);
    if (item.kind === "user") closed = true;
    if (item.kind === "turn") closed = item.phase !== "aborted";
  }
  return complete;
}

export type CliTurnReason = "end" | "error" | "interrupted";
export const CLI_TURN_REASONS: readonly CliTurnReason[] = ["end", "error", "interrupted"];

export type CliRequestKind = "permission" | "question";
export const CLI_REQUEST_KINDS: readonly CliRequestKind[] = ["permission", "question"];

/** Who closed a request: the CLI in the terminal, the CLI's own timeout,
 * nex_bot's answer, or the session went away. */
export type CliRequestResolvedBy = "terminal" | "timeout" | "nexbot" | "gone";
export const CLI_REQUEST_RESOLVED_BY: readonly CliRequestResolvedBy[] = ["terminal", "timeout", "nexbot", "gone"];

export interface CliRequestQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** What a device sends for a pending request. */
export interface CliRequestWire {
  ref: CliSessionRef;
  id: string;
  kind: CliRequestKind;
  tool: string;
  summary: string;
  /** the tool's arguments in full (clipped to CLI_LIMITS.requestDetail) */
  detail?: string;
  options?: string[];
  questions?: CliRequestQuestion[];
  /** the device can allow this kind of call for the rest of the session (answer with `always`) */
  always?: boolean;
  /** epoch ms */
  expiresAt: number;
}

/** What Core sends to browsers. */
export interface CliRequestView {
  id: string;
  key: CliSessionKey;
  kind: CliRequestKind;
  tool: string;
  summary: string;
  detail?: string;
  options?: string[];
  questions?: CliRequestQuestion[];
  always?: boolean;
  /** epoch ms */
  createdAt: number;
  expiresAt: number;
}

export type CliAnswerDecision = "allow" | "deny";

// ---------------------------------------------------------------------------
// Errors (plan 4.6)

export type CliErrorCode =
  | "disabled"
  | "paused"
  | "hc_unavailable"
  | "hc_version"
  | "cli_missing"
  | "cwd_missing"
  | "not_found"
  | "not_in_terminal"
  | "stopped"
  | "open_elsewhere"
  | "read_only"
  | "too_large"
  | "invalid"
  | "busy"
  | "turn_changed"
  | "conflict"
  | "device_offline"
  | "unknown";

export const CLI_ERROR_CODES: readonly CliErrorCode[] = [
  "disabled",
  "paused",
  "hc_unavailable",
  "hc_version",
  "cli_missing",
  "cwd_missing",
  "not_found",
  "not_in_terminal",
  "stopped",
  "open_elsewhere",
  "read_only",
  "too_large",
  "invalid",
  "busy",
  "turn_changed",
  "conflict",
  "device_offline",
  "unknown",
];

export const CLI_ERROR_TEXT: Record<CliErrorCode, string> = {
  disabled: "Agent 会话已关闭",
  paused: "本机控制已暂停",
  hc_unavailable: "终端组件不可用",
  hc_version: "终端组件版本不符",
  cli_missing: "找不到 Claude 或 Codex",
  cwd_missing: "工作目录不存在",
  not_found: "会话不存在",
  not_in_terminal: "会话不在 nex_bot 终端里",
  stopped: "会话已停止",
  open_elsewhere: "这个会话正在电脑上运行",
  read_only: "只看，不能输入",
  too_large: "内容太长",
  invalid: "参数不合法",
  busy: "上一个操作还没完成",
  turn_changed: "目标轮次已经结束",
  conflict: "内容已被另一端修改，请刷新后重试",
  device_offline: "电脑离线",
  unknown: "结果未知",
};

export function isCliErrorCode(value: unknown): value is CliErrorCode {
  return typeof value === "string" && (CLI_ERROR_CODES as readonly string[]).includes(value);
}

export interface CliError {
  code: CliErrorCode;
  message?: string;
}

// ---------------------------------------------------------------------------
// Capability (hello.cliAgents)

/** What an executor can do beyond the first protocol: content search (`search`),
 * model and effort at launch (`model`/`effort` on `start` and `continue`),
 * attachments written to the computer (`attach`) and the models its CLIs offer
 * (`models`). Older executors send none. */
/** `dirs`: list a computer's folders, and `createDir` on `start` makes a missing folder first. */
export type CliFeature = "search" | "launchOptions" | "attach" | "models" | "dirs" | "permissions";
/** `permissions`: the executor takes CliLaunchOptions.permissions and starts new sessions with full access unless told "ask". */
export const CLI_FEATURES: readonly CliFeature[] = ["search", "launchOptions", "attach", "models", "dirs", "permissions"];

/** What the page shows when the computer's executor lacks a feature. */
export const CLI_OUTDATED_TEXT = "电脑端版本过旧，升级后可用";

export interface CliAgentsCapability {
  version: 1;
  engines: CliEngine[];
  terminal: { name: "herdr-core"; version: string; ready: boolean; error?: string };
  /** engines whose `start` honours `forkFrom`; absent on executors that predate
   * forks, which would otherwise ignore the field and start a blank session */
  forkEngines?: CliEngine[];
  /** absent on executors that predate them; Core refuses the feature there */
  features?: CliFeature[];
}

export function hasCliFeature(capability: CliAgentsCapability | null | undefined, feature: CliFeature): boolean {
  return capability?.features?.includes(feature) === true;
}

// ---------------------------------------------------------------------------
// Launch options: model and reasoning effort (Claude Code 2.1 `--model` /
// `--effort`, Codex 0.163 `-m` / `-c model_reasoning_effort=`)

/** Effort levels each CLI accepts; ZCode has no such switch. */
export const CLI_EFFORTS: Record<CliEngine, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  zcode: [],
};

/** Suggestions for the model picker; any name matching CLI_MODEL_RE is accepted. */
export const CLI_MODELS: Record<CliEngine, readonly { id: string; label: string }[]> = {
  claude: [
    { id: "fable", label: "Fable" },
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
  ],
  codex: ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"].map((id) => ({ id, label: id })),
  zcode: [],
};

// an alias or full model name (`opus[1m]`, `gpt-6.2-sol`, a gateway's `auto/claude-opus-5-5[1m]`);
// it starts alphanumeric so it can never read as a flag, and carries nothing a shell or cmd.exe interprets
export const CLI_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/\-[\]]{0,99}$/;

/** One row of a CLI's own model picker, as the computer reads it from the CLI's settings. */
export interface CliModelOption {
  /** what `--model` / `-m` takes */
  id: string;
  label: string;
  description?: string;
  /** effort levels this model takes; absent when the CLI does not say (every level of the engine is offered) */
  efforts?: string[];
}

/** What the `models` op answers: the CLI's picker rows in its order, and what it starts with when nothing is chosen. */
export interface CliModelCatalog {
  models: CliModelOption[];
  /** the model the CLI's settings choose (`model` in settings.json / config.toml) */
  current?: string;
  /** the effort the CLI's settings choose */
  currentEffort?: string;
}

export const CLI_MODEL_LIMITS = { models: 200, label: 120, description: 200 } as const;

export function isCliModel(value: unknown): value is string {
  return typeof value === "string" && CLI_MODEL_RE.test(value);
}

export function isCliEffort(engine: CliEngine, value: unknown): value is string {
  return typeof value === "string" && (CLI_EFFORTS[engine] ?? []).includes(value);
}

/** How a launched CLI asks before it acts. "full": Claude `--dangerously-skip-permissions`, Codex
 * `--dangerously-bypass-approvals-and-sandbox` (nothing is asked). "ask": the CLI's own settings, so
 * prompts reach the request cards. A new session (start) defaults to "full", a continued one to "ask". */
export type CliPermissionMode = "full" | "ask";
export const CLI_PERMISSION_MODES: readonly CliPermissionMode[] = ["full", "ask"];

export interface CliLaunchOptions {
  model?: string;
  effort?: string;
  /** only sent to executors that list the `permissions` feature */
  permissions?: CliPermissionMode;
}

// ---------------------------------------------------------------------------
// Search and attachments

export const CLI_SEARCH = { queryMax: 200, defaultLimit: 50, maxLimit: 100, snippetMax: 120 } as const;

/** Decoded bytes of one attachment. Base64 makes it ~11.2 MB on the device link,
 * whose frames the executor accepts up to CLI_LINK_FRAME_MAX. */
export const CLI_ATTACH_MAX_BYTES = 8 * 1024 * 1024;
export const CLI_ATTACH_NAME_MAX = 200;
const ATTACH_BASE64_MAX = Math.ceil(CLI_ATTACH_MAX_BYTES / 3) * 4;
/** The largest message the executor takes from Core: one attachment plus its envelope. */
export const CLI_LINK_FRAME_MAX = 12 * 1024 * 1024;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Bytes a base64 string decodes to, or -1 when it is not canonical padded base64. */
export function base64DecodedLength(value: string): number {
  if (value.length % 4 !== 0 || !BASE64_RE.test(value)) return -1;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export interface CliDeviceView {
  id: string;
  name: string;
  online: boolean;
  cliAgents: CliAgentsCapability | null;
}

// ---------------------------------------------------------------------------
// Operations (plan 4.2 / 4.4)

export const CLI_OPS = [
  "read",
  "watch",
  "unwatch",
  "start",
  "continue",
  "send",
  "steer",
  "interrupt",
  "open_local",
  "answer",
  "git",
  "search",
  "attach",
  "models",
  "dirs",
] as const;
export type CliOp = (typeof CLI_OPS)[number];

export function isCliOp(value: unknown): value is CliOp {
  return typeof value === "string" && (CLI_OPS as readonly string[]).includes(value);
}

export interface CliOpArgs {
  /** `before` is an item id; the page ends right before that item */
  read: { ref: CliSessionRef; before?: string; limit?: number };
  watch: { ref: CliSessionRef };
  unwatch: { ref: CliSessionRef };
  start: {
    engine: CliEngine;
    cwd: string;
    cols?: number;
    rows?: number;
    /** create an independent worktree of the repository at `cwd` first, then
     * run the CLI inside it; the device dedups by requestId */
    worktree?: { branch: string; requestId: string };
    /** a real context fork of this session (same device and engine as `engine`):
     * the CLI resumes it into a new session id instead of starting blank. A device
     * that does not list the engine in `capability.forkEngines` must not be sent it. */
    forkFrom?: CliSessionRef;
    /** make `cwd` (and missing parents) first; only sent to executors that list `dirs` */
    createDir?: boolean;
    /** launch options; only sent to executors that list `launchOptions` */
    model?: string;
    effort?: string;
    /** only sent to executors that list `permissions`; absent means full access for a new session */
    permissions?: CliPermissionMode;
  };
  /** `permissions` absent: the CLI keeps its own settings */
  continue: { ref: CliSessionRef; cols?: number; rows?: number; model?: string; effort?: string; permissions?: CliPermissionMode };
  send: { ref: CliSessionRef; text: string };
  /** guidance into a turn that is already running; the device only accepts it
   * while the session has an active turn (workbench plan section 3) */
  steer: { ref: CliSessionRef; text: string };
  interrupt: { ref: CliSessionRef };
  open_local: { ref: CliSessionRef };
  /** answers the pending request `id`; `answers` maps a question to its chosen label(s);
   * `always` (with allow, only for a request that offered it) also allows such calls for the rest of the session */
  answer: { id: string; decision: CliAnswerDecision; answers?: Record<string, string>; message?: string; always?: boolean };
  /** a Git query or worktree creation for the session's repository on the device */
  git: { ref: CliSessionRef; action: "info" } | { ref: CliSessionRef; action: "worktree"; branch: string; requestId: string };
  /** every listed session's user and assistant text, newest sessions first */
  search: { query: string; limit?: number };
  /** writes a file next to the session's other attachments; `data` is base64 */
  attach: { ref: CliSessionRef; name: string; data: string };
  /** the model picker rows of one CLI on the computer */
  models: { engine: CliEngine };
  /** the sub-folders of an absolute folder; "" lists the roots (drives and the home folder) */
  dirs: { path: string };
}

export interface CliSearchHit {
  ref: CliSessionRef;
  snippet: string;
}

/** What a device answers for `git` (workbench plan section 3: Git lives on the
 * device that owns the repository). `source` says how much the answer knows. */
export interface CliGitInfo {
  source: "worktree" | "folder" | "none" | "failed";
  /** the repository root the device resolved */
  project?: string;
  /** the working tree the session runs in */
  worktree?: string;
  branch?: string;
  head?: string;
  /** changed files, porcelain names relative to the worktree */
  files?: string[];
  added?: number;
  removed?: number;
  /** set when source is "failed": the short reason, no absolute paths */
  error?: string;
}

export interface CliOpResult {
  read: { items: CliItem[]; more: boolean };
  watch: Record<string, never>;
  unwatch: Record<string, never>;
  start: { ref: CliSessionRef; terminal: string; cwd?: string };
  continue: { ref: CliSessionRef; terminal: string };
  send: { turn: number; started: boolean; delivery?: CliDelivery; waiting?: boolean };
  steer: { accepted: boolean };
  interrupt: { outcome: string };
  open_local: Record<string, never>;
  answer: { outcome: string };
  git: CliGitInfo;
  search: { hits: CliSearchHit[] };
  attach: { path: string };
  models: CliModelCatalog;
  dirs: CliDirListing;
}

export const CLI_OP_TIMEOUT_MS: Record<CliOp, number> = {
  read: 15_000,
  watch: 5000,
  unwatch: 5000,
  start: 30_000,
  continue: 30_000,
  send: 70_000,
  steer: 70_000,
  interrupt: 10_000,
  open_local: 10_000,
  answer: 10_000,
  git: 20_000,
  // the device stops scanning well before this (its own budget is ~8 s)
  search: 10_000,
  attach: 20_000,
  models: 8000,
  dirs: 8000,
};

/** Operations that change state: never re-sent after a timeout or a drop.
 * `attach` is not one: each call writes a new uniquely named file and touches no
 * session, and keeping it out keeps the file bytes out of the op record and lets
 * several files of one session upload at once. */
export const CLI_OP_MUTATING: ReadonlySet<CliOp> = new Set<CliOp>([
  "start",
  "continue",
  "send",
  "steer",
  "interrupt",
  "open_local",
  "answer",
]);

// ---------------------------------------------------------------------------
// Workbench sessions and the outbox queue (workbench plan sections 3 and 4)

/** A logical workbench session sits above the native session keys it has been
 * bound to over its life: it survives a resume that changed the key, carries
 * the user's display name and the tree relation. Old data has no row until the
 * workbench touches the session; such a session reads as a root `main`. */
export type CliWorkbenchKind = "main" | "fork" | "side";

export interface CliWorkbenchSessionView {
  id: string;
  /** the native session key this row currently points at; null while detached */
  sessionKey: CliSessionKey | null;
  deviceId: string | null;
  engine: CliEngine | null;
  cwd: string;
  parentId: string | null;
  kind: CliWorkbenchKind;
  /** what the user named it; empty when the harness title is shown */
  title: string;
  archived: boolean;
  deleted: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** One outbox entry as the browsers see it. Text is included: the queue list
 * shows what will be sent. Status follows the plan's pending → claimed →
 * sent/failed/withdrawn/uncertain flow; `confirmed` is the device's own receipt. */
export type CliQueueStatus = "pending" | "claimed" | "sent" | "confirmed" | "failed" | "withdrawn" | "uncertain";
export const CLI_QUEUE_STATUSES: readonly CliQueueStatus[] = [
  "pending", "claimed", "sent", "confirmed", "failed", "withdrawn", "uncertain",
];

export interface CliQueueEntryView {
  id: string;
  seq: number;
  text: string;
  status: CliQueueStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
  /** the transcript message this entry revises (edit-and-resend) */
  revisesMessageId?: string;
  errorCode?: CliErrorCode;
}

export interface CliQueueView {
  workbenchId: string;
  /** the native key dispatches go to right now */
  sessionKey: CliSessionKey;
  paused: boolean;
  /** `stopped` after the user stopped the session, `uncertain` while an
   * unconfirmed dispatch blocks the head, `device_offline` while offline */
  pauseReason?: string;
  entries: CliQueueEntryView[];
}

// ---------------------------------------------------------------------------
// Device -> Core (DCP)

export type DeviceCliMessage =
  | { type: "cli.sessions"; full: boolean; upserts: CliSessionWire[]; removes: CliSessionRef[]; seq: number }
  | { type: "cli.items"; ref: CliSessionRef; items: CliItem[]; reset?: boolean; more?: boolean }
  | { type: "cli.turn"; ref: CliSessionRef; turn: number; endedAt: number; reason: CliTurnReason; error?: string }
  | ({ type: "cli.request" } & CliRequestWire)
  | { type: "cli.request.resolved"; id: string; by: CliRequestResolvedBy }
  | { type: "cli.reply"; opId: string; ok: boolean; result?: Record<string, unknown>; error?: CliError }
  | { type: "cli.term.opened"; sid: number; cols: number; rows: number; observe: boolean }
  | { type: "cli.term.size"; sid: number; cols: number; rows: number }
  | { type: "cli.term.closed"; sid: number; reason: string; exitCode?: number }
  | { type: "cli.term.error"; sid: number; code: CliErrorCode };

/** Core -> device. `deadlineMs` is how long the device has, counted from receipt. */
export type CoreCliMessage =
  | { [K in CliOp]: { type: "cli.op"; opId: string; op: K; args: CliOpArgs[K]; deadlineMs: number } }[CliOp]
  | { type: "cli.term.open"; sid: number; ref: CliSessionRef; cols: number; rows: number; observe: boolean }
  | { type: "cli.term.resize"; sid: number; cols: number; rows: number }
  | { type: "cli.term.credit"; sid: number; bytes: number }
  | { type: "cli.term.close"; sid: number }
  | { type: "cli.resync" };

// ---------------------------------------------------------------------------
// Browser <-> Core WebSocket (plan 5.5)

export type ClientMessage =
  | { type: "sub.list" }
  | { type: "sub.session"; key: CliSessionKey; known?: string[] }
  | { type: "unsub.session"; key: CliSessionKey }
  | { type: "term.open"; req: string; key: CliSessionKey; cols: number; rows: number; observe: boolean }
  | { type: "term.resize"; sid: number; cols: number; rows: number }
  | { type: "term.credit"; sid: number; bytes: number }
  | { type: "term.close"; sid: number }
  | { type: "ping" };

export type ServerMessage =
  | { type: "list"; devices: CliDeviceView[]; sessions: CliSessionView[] }
  | { type: "list.delta"; upserts: CliSessionView[]; removes: CliSessionKey[]; devices?: CliDeviceView[] }
  | { type: "items"; key: CliSessionKey; items: CliItem[]; reset?: boolean; more?: boolean; snapshot?: string[] }
  | { type: "term.opened"; req: string; sid: number; cols: number; rows: number; observe: boolean }
  | { type: "term.size"; sid: number; cols: number; rows: number }
  | { type: "term.closed"; sid: number; reason: string }
  | { type: "error"; code: CliErrorCode; req?: string; message?: string }
  | { type: "summary"; waiting: number; running: number }
  /** the full pending list of one session, sent on subscribe and on every change */
  | { type: "requests"; key: CliSessionKey; requests: CliRequestView[] }
  | { type: "request.resolved"; key: CliSessionKey; id: string; by: CliRequestResolvedBy }
  /** one logical session's outbox, sent on subscribe of its key and on every change */
  | { type: "queue"; queue: CliQueueView }
  /** the workbench tree; a full snapshot, rare enough not to need a delta */
  | { type: "workbench"; sessions: CliWorkbenchSessionView[] }
  | { type: "pong" };

// ---------------------------------------------------------------------------
// Helpers

const textEncoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return textEncoder.encode(text).length;
}

/** Cuts `text` to at most `maxBytes` of UTF-8 without splitting a code point
 * (a surrogate pair stays whole; a lone surrogate counts as the 3 bytes of
 * U+FFFD, what TextEncoder writes for it). Returns the input when it fits. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (!(maxBytes > 0)) return "";
  const limit = Math.floor(maxBytes);
  // a UTF-16 unit is at most 3 bytes, so a short string always fits
  if (text.length * 3 <= limit) return text;
  let bytes = 0;
  let index = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > limit) return text.slice(0, index);
    bytes += size;
    index += char.length;
  }
  return text;
}

/** Clamps a requested terminal size into TERM_LIMITS; a missing or
 * non-numeric value takes the default. */
export function clampTermSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const pick = (value: unknown, fallback: number, min: number, max: number): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
  };
  return {
    cols: pick(cols, TERM_DEFAULT.cols, TERM_LIMITS.minCols, TERM_LIMITS.maxCols),
    rows: pick(rows, TERM_DEFAULT.rows, TERM_LIMITS.minRows, TERM_LIMITS.maxRows),
  };
}

const SAFE_CLI_ARG_RE = /^[A-Za-z0-9._:/=-]+$/;

/** An argument nex_bot may put on a CLI command line itself. */
export function isSafeCliArg(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && SAFE_CLI_ARG_RE.test(value);
}

const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const UNC_RE = /^[\\/]{2}([^\\/?.][^\\/]*)[\\/][^\\/]+/;

/** Syntax only: a Windows drive path, a UNC path or a POSIX absolute path.
 * It touches no file system; the device checks the directory exists. */
export function isAbsoluteCwd(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > CLI_LIMITS.cwd) return false;
  if (value.includes("\0")) return false;
  if (WINDOWS_DRIVE_RE.test(value)) return true;
  if (UNC_RE.test(value)) return true;
  // a leading single slash; `//` and `\\` that are not a share are not paths
  return value.startsWith("/") && !value.startsWith("//");
}

// ---------------------------------------------------------------------------
// Parsing internals. They throw this private error; the public parse*
// functions catch everything and return null.

class Invalid extends Error {}

type Rec = Record<string, unknown>;

function fail(): never {
  throw new Invalid();
}

function guard<T>(parse: () => T): T | null {
  try {
    return parse();
  } catch {
    return null;
  }
}

function rec(value: unknown): Rec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  return value as Rec;
}

function str(value: unknown, max: number, min = 0): string {
  if (typeof value !== "string" || value.length > max || value.length < min) fail();
  return value;
}

function int(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) fail();
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}

function oneOf<T extends string>(value: unknown, list: readonly T[]): T {
  if (typeof value !== "string" || !(list as readonly string[]).includes(value)) fail();
  return value as T;
}

function arr(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail();
  return value;
}

function present(o: Rec, key: string): boolean {
  return Object.hasOwn(o, key) && o[key] !== undefined;
}

function optStr(o: Rec, key: string, max: number, min = 0): string | undefined {
  return present(o, key) ? str(o[key], max, min) : undefined;
}

function optInt(o: Rec, key: string, min: number, max: number): number | undefined {
  return present(o, key) ? int(o[key], min, max) : undefined;
}

function optBool(o: Rec, key: string): boolean | undefined {
  return present(o, key) ? bool(o[key]) : undefined;
}

/** Copies only the keys whose value is not undefined. */
function pick<T extends Rec>(o: T): T {
  const out: Rec = {};
  for (const key of Object.keys(o)) if (o[key] !== undefined) out[key] = o[key];
  return out as T;
}

const U32_MAX = 0xffff_ffff;
const COUNTER_MAX = Number.MAX_SAFE_INTEGER;

function sid(value: unknown): number {
  return int(value, 0, U32_MAX);
}

function cols(value: unknown): number {
  return int(value, TERM_LIMITS.minCols, TERM_LIMITS.maxCols);
}

function rows(value: unknown): number {
  return int(value, TERM_LIMITS.minRows, TERM_LIMITS.maxRows);
}

function ref(value: unknown): CliSessionRef {
  const parsed = parseCliRef(value);
  if (!parsed) fail();
  return `${parsed.engine}:${parsed.nativeId}`;
}

function key(value: unknown): CliSessionKey {
  const parsed = parseCliKey(value);
  if (!parsed) fail();
  return `${parsed.deviceId}:${parsed.ref}`;
}

function nativeIdOf(value: unknown): string {
  if (!isCliNativeId(value)) fail();
  return value;
}

function deviceIdOf(value: unknown): string {
  if (!isCliDeviceId(value)) fail();
  return value;
}

// ---------------------------------------------------------------------------
// Parsers: sessions, items, capability

function sessionWire(value: unknown): CliSessionWire {
  const o = rec(value);
  const lastActivityAt = int(o.lastActivityAt, 0, COUNTER_MAX);
  return pick({
    engine: oneOf(o.engine, CLI_ENGINES),
    nativeId: nativeIdOf(o.nativeId),
    configDir: str(o.configDir, CLI_LIMITS.configDir),
    cwd: str(o.cwd, CLI_LIMITS.cwd),
    title: str(o.title, CLI_LIMITS.title),
    gitBranch: optStr(o, "gitBranch", CLI_LIMITS.gitBranch),
    state: oneOf(o.state, CLI_SESSION_STATES),
    waitingFor: optStr(o, "waitingFor", CLI_LIMITS.waitingFor),
    liveIn: present(o, "liveIn") ? oneOf(o.liveIn, CLI_LIVE_IN) : undefined,
    terminal: optStr(o, "terminal", CLI_LIMITS.terminal, 1),
    sendVia: present(o, "sendVia") ? oneOf(o.sendVia, CLI_SEND_VIA) : undefined,
    repoRoot: optStr(o, "repoRoot", CLI_LIMITS.cwd, 1),
    forkOf: present(o, "forkOf") ? nativeIdOf(o.forkOf) : undefined,
    sideOf: present(o, "sideOf") ? nativeIdOf(o.sideOf) : undefined,
    model: optStr(o, "model", CLI_LIMITS.model),
    cliVersion: optStr(o, "cliVersion", CLI_LIMITS.cliVersion),
    // a usage this side cannot read is left out rather than dropping the row
    context: present(o, "context") ? guard(() => contextUsage(rec(o.context))) ?? undefined : undefined,
    lastActivityAt,
    writerUnknown: optBool(o, "writerUnknown"),
  });
}

const TOKENS_MAX = 100_000_000;
function contextUsage(o: Rec): CliContextUsage {
  return pick({ used: int(o.used, 1, TOKENS_MAX), window: optInt(o, "window", 1, TOKENS_MAX) });
}

function sessionView(value: unknown): CliSessionView {
  const o = rec(value);
  const wire = sessionWire(o);
  const deviceId = deviceIdOf(o.deviceId);
  const expected = `${deviceId}:${wire.engine}:${wire.nativeId}` as CliSessionKey;
  if (o.key !== expected) fail();
  return { ...wire, key: expected, deviceId, hidden: bool(o.hidden), online: bool(o.online) };
}

function item(value: unknown): CliItem {
  const o = rec(value);
  const id = str(o.id, CLI_LIMITS.itemId, 1);
  const ts = int(o.ts, 0, COUNTER_MAX);
  switch (o.kind) {
    case "user": {
      let images: string[] | undefined;
      if (present(o, "images")) {
        images = arr(o.images, CLI_LIMITS.images).map((path) => str(path, CLI_LIMITS.imagePath, 1));
      }
      return pick({
        kind: "user" as const,
        id,
        ts,
        text: str(o.text, ITEM_TEXT_MAX),
        images,
        queued: optBool(o, "queued"),
      });
    }
    case "assistant":
      return { kind: "assistant", id, ts, text: str(o.text, ITEM_TEXT_MAX) };
    case "thinking":
      return { kind: "thinking", id, ts, text: str(o.text, SUMMARY_MAX) };
    case "tool":
      return pick({
        kind: "tool" as const,
        id,
        ts,
        name: str(o.name, CLI_LIMITS.toolName),
        input: str(o.input, SUMMARY_MAX),
        status: oneOf(o.status, ["running", "ok", "error"] as const),
        output: optStr(o, "output", TOOL_OUTPUT_MAX),
      });
    case "notice":
      return {
        kind: "notice",
        id,
        ts,
        level: oneOf(o.level, ["info", "error"] as const),
        text: str(o.text, CLI_LIMITS.noticeText),
      };
    case "turn":
      return { kind: "turn", id, ts, phase: oneOf(o.phase, ["started", "ended", "aborted"] as const) };
    default:
      return fail();
  }
}

function items(value: unknown): CliItem[] {
  return arr(value, MAX_ITEMS_PER_MESSAGE).map(item);
}

function capability(value: unknown): CliAgentsCapability {
  const o = rec(value);
  if (o.version !== CLI_AGENTS_PROTOCOL_VERSION) fail();
  const engines: CliEngine[] = [];
  for (const engine of arr(o.engines, CLI_ENGINES.length * 2)) {
    const parsed = oneOf(engine, CLI_ENGINES);
    if (!engines.includes(parsed)) engines.push(parsed);
  }
  const t = rec(o.terminal);
  if (t.name !== "herdr-core") fail();
  const terminal = pick({
    name: "herdr-core" as const,
    version: str(t.version, 64, 1),
    ready: bool(t.ready),
    error: optStr(t, "error", CLI_LIMITS.message),
  });
  let forkEngines: CliEngine[] | undefined;
  if (present(o, "forkEngines")) {
    forkEngines = [];
    for (const engine of arr(o.forkEngines, CLI_ENGINES.length * 2)) {
      const parsed = oneOf(engine, CLI_ENGINES);
      if (!forkEngines.includes(parsed)) forkEngines.push(parsed);
    }
  }
  // a newer executor may list features this side does not know yet: those are
  // dropped instead of failing the whole capability (and with it the device)
  let features: CliFeature[] | undefined;
  if (present(o, "features")) {
    features = [];
    for (const entry of arr(o.features, 32)) {
      const name = str(entry, 64);
      if ((CLI_FEATURES as readonly string[]).includes(name) && !features.includes(name as CliFeature)) features.push(name as CliFeature);
    }
  }
  return { version: 1, engines, terminal, ...(forkEngines ? { forkEngines } : {}), ...(features ? { features } : {}) };
}

function deviceView(value: unknown): CliDeviceView {
  const o = rec(value);
  return {
    id: deviceIdOf(o.id),
    name: str(o.name, CLI_LIMITS.deviceName),
    online: bool(o.online),
    cliAgents: o.cliAgents === null ? null : capability(o.cliAgents),
  };
}

function cliError(value: unknown): CliError {
  const o = rec(value);
  return pick({ code: oneOf(o.code, CLI_ERROR_CODES), message: optStr(o, "message", CLI_LIMITS.message) });
}

export function parseCliSessionWire(value: unknown): CliSessionWire | null {
  return guard(() => sessionWire(value));
}

export function parseCliSessionView(value: unknown): CliSessionView | null {
  return guard(() => sessionView(value));
}

export function parseCliItem(value: unknown): CliItem | null {
  return guard(() => item(value));
}

/** At most MAX_ITEMS_PER_MESSAGE items; one invalid item rejects the list. */
export function parseCliItems(value: unknown): CliItem[] | null {
  return guard(() => items(value));
}

export function parseCliAgentsCapability(value: unknown): CliAgentsCapability | null {
  return guard(() => capability(value));
}

export function parseCliDeviceView(value: unknown): CliDeviceView | null {
  return guard(() => deviceView(value));
}

// ---------------------------------------------------------------------------
// Parsers: workbench sessions and the outbox queue

function workbenchSession(value: unknown): CliWorkbenchSessionView {
  const o = rec(value);
  return pick({
    id: str(o.id, 128, 1),
    sessionKey: present(o, "sessionKey") ? key(o.sessionKey) : null,
    deviceId: present(o, "deviceId") ? deviceIdOf(o.deviceId) : null,
    engine: present(o, "engine") ? oneOf(o.engine, CLI_ENGINES) : null,
    cwd: str(o.cwd, CLI_LIMITS.cwd),
    parentId: present(o, "parentId") ? str(o.parentId, 128, 1) : null,
    kind: oneOf(o.kind, ["main", "fork", "side"] as const),
    title: str(o.title, CLI_LIMITS.title),
    archived: bool(o.archived),
    deleted: bool(o.deleted),
    version: int(o.version, 0, COUNTER_MAX),
    createdAt: int(o.createdAt, 0, COUNTER_MAX),
    updatedAt: int(o.updatedAt, 0, COUNTER_MAX),
  });
}

function queueEntry(value: unknown): CliQueueEntryView {
  const o = rec(value);
  return pick({
    id: str(o.id, 128, 1),
    seq: int(o.seq, 0, COUNTER_MAX),
    text: str(o.text, MAX_SEND_TEXT),
    status: oneOf(o.status, CLI_QUEUE_STATUSES),
    version: int(o.version, 0, COUNTER_MAX),
    createdAt: int(o.createdAt, 0, COUNTER_MAX),
    updatedAt: int(o.updatedAt, 0, COUNTER_MAX),
    revisesMessageId: optStr(o, "revisesMessageId", CLI_LIMITS.itemId, 1),
    errorCode: present(o, "errorCode") ? oneOf(o.errorCode, CLI_ERROR_CODES) : undefined,
  });
}

function queueView(value: unknown): CliQueueView {
  const o = rec(value);
  return pick({
    workbenchId: str(o.workbenchId, 128, 1),
    sessionKey: key(o.sessionKey),
    paused: bool(o.paused),
    pauseReason: optStr(o, "pauseReason", 40, 1),
    entries: arr(o.entries, 200).map(queueEntry),
  });
}

export function parseCliWorkbenchSession(value: unknown): CliWorkbenchSessionView | null {
  return guard(() => workbenchSession(value));
}

export function parseCliQueueView(value: unknown): CliQueueView | null {
  return guard(() => queueView(value));
}

// ---------------------------------------------------------------------------
// Parsers: operations

const CLI_ANSWER_DECISIONS: readonly CliAnswerDecision[] = ["allow", "deny"];

function answersMap(value: unknown): Record<string, string> {
  const o = rec(value);
  const keys = Object.keys(o);
  if (keys.length > CLI_LIMITS.requestQuestions) fail();
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (k === "__proto__" || k.length > CLI_LIMITS.requestQuestion) fail();
    out[k] = str(o[k], CLI_LIMITS.requestAnswer);
  }
  return out;
}

function requestQuestions(value: unknown): CliRequestQuestion[] {
  return arr(value, CLI_LIMITS.requestQuestions).map((entry) => {
    const q = rec(entry);
    return pick({
      question: str(q.question, CLI_LIMITS.requestQuestion),
      header: optStr(q, "header", CLI_LIMITS.requestOption),
      options: arr(q.options, CLI_LIMITS.requestOptions).map((opt) => {
        const p = rec(opt);
        return pick({
          label: str(p.label, CLI_LIMITS.requestOption),
          description: optStr(p, "description", CLI_LIMITS.requestDescription),
        });
      }),
      multiSelect: optBool(q, "multiSelect"),
    });
  });
}

function requestOptions(value: unknown): string[] {
  return arr(value, CLI_LIMITS.requestOptions).map((entry) => str(entry, CLI_LIMITS.requestOption));
}

function requestFields(o: Rec) {
  return {
    id: str(o.id, CLI_LIMITS.requestId, 1),
    kind: oneOf(o.kind, CLI_REQUEST_KINDS),
    tool: str(o.tool, CLI_LIMITS.requestTool),
    summary: str(o.summary, SUMMARY_MAX),
    detail: optStr(o, "detail", CLI_LIMITS.requestDetail),
    options: present(o, "options") ? requestOptions(o.options) : undefined,
    questions: present(o, "questions") ? requestQuestions(o.questions) : undefined,
    always: optBool(o, "always") === true ? true : undefined,
    expiresAt: int(o.expiresAt, 0, COUNTER_MAX),
  };
}

function requestView(value: unknown): CliRequestView {
  const o = rec(value);
  const fields = requestFields(o);
  return pick({
    id: fields.id,
    key: key(o.key),
    kind: fields.kind,
    tool: fields.tool,
    summary: fields.summary,
    detail: fields.detail,
    options: fields.options,
    questions: fields.questions,
    always: fields.always,
    createdAt: int(o.createdAt, 0, COUNTER_MAX),
    expiresAt: fields.expiresAt,
  });
}

export function parseCliRequestView(value: unknown): CliRequestView | null {
  return guard(() => requestView(value));
}

/** `model` and `effort` of a start or continue; an effort the engine does not
 * have is invalid rather than dropped, so the user never gets a silent default. */
function launchOptions(o: Rec, engine: CliEngine): CliLaunchOptions {
  const out: CliLaunchOptions = {};
  if (present(o, "model")) {
    if (!isCliModel(o.model)) fail();
    out.model = o.model;
  }
  if (present(o, "effort")) {
    if (!isCliEffort(engine, o.effort)) fail();
    out.effort = o.effort;
  }
  if (present(o, "permissions")) out.permissions = oneOf(o.permissions, CLI_PERMISSION_MODES);
  return out;
}

const ARGS_PARSERS: { [K in CliOp]: (o: Rec) => CliOpArgs[K] } = {
  read: (o) =>
    pick({
      ref: ref(o.ref),
      before: optStr(o, "before", CLI_LIMITS.itemId, 1),
      limit: optInt(o, "limit", 1, MAX_ITEMS_PER_MESSAGE),
    }),
  watch: (o) => ({ ref: ref(o.ref) }),
  unwatch: (o) => ({ ref: ref(o.ref) }),
  start: (o) => {
    const cwd = o.cwd;
    if (!isAbsoluteCwd(cwd)) fail();
    let worktree: { branch: string; requestId: string } | undefined;
    if (present(o, "worktree")) {
      const tree = rec(o.worktree);
      const branch = str(tree.branch, 120, 1);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch)) fail();
      worktree = { branch, requestId: str(tree.requestId, 128, 1) };
    }
    const engine = oneOf(o.engine, CLI_ENGINES);
    let forkFrom: CliSessionRef | undefined;
    if (present(o, "forkFrom")) {
      forkFrom = ref(o.forkFrom);
      // a fork resumes a session of the engine being started, never another one
      if (!forkFrom.startsWith(`${engine}:`)) fail();
    }
    return pick({
      engine,
      cwd,
      cols: present(o, "cols") ? cols(o.cols) : undefined,
      rows: present(o, "rows") ? rows(o.rows) : undefined,
      worktree,
      forkFrom,
      createDir: present(o, "createDir") ? bool(o.createDir) || undefined : undefined,
      ...launchOptions(o, engine),
    });
  },
  continue: (o) => {
    const target = ref(o.ref);
    return pick({
      ref: target,
      cols: present(o, "cols") ? cols(o.cols) : undefined,
      rows: present(o, "rows") ? rows(o.rows) : undefined,
      ...launchOptions(o, target.slice(0, target.indexOf(":")) as CliEngine),
    });
  },
  search: (o) => {
    const query = str(o.query, CLI_SEARCH.queryMax, 1);
    if (!query.trim()) fail();
    return pick({ query, limit: optInt(o, "limit", 1, CLI_SEARCH.maxLimit) });
  },
  models: (o) => ({ engine: oneOf(o.engine, CLI_ENGINES) }),
  dirs: (o) => {
    const path = str(o.path, CLI_LIMITS.cwd);
    if (path && !isAbsoluteCwd(path)) fail();
    return { path };
  },
  attach: (o) => {
    const name = str(o.name, CLI_ATTACH_NAME_MAX, 1);
    const data = str(o.data, ATTACH_BASE64_MAX);
    if (base64DecodedLength(data) < 0) fail();
    return { ref: ref(o.ref), name, data };
  },
  send: (o) => {
    const text = str(o.text, MAX_SEND_TEXT, 1);
    if (utf8ByteLength(text) > MAX_SEND_TEXT) fail();
    return { ref: ref(o.ref), text };
  },
  steer: (o) => {
    const text = str(o.text, MAX_SEND_TEXT, 1);
    if (utf8ByteLength(text) > MAX_SEND_TEXT) fail();
    return { ref: ref(o.ref), text };
  },
  interrupt: (o) => ({ ref: ref(o.ref) }),
  open_local: (o) => ({ ref: ref(o.ref) }),
  git: (o) => {
    const action = oneOf(o.action, ["info", "worktree"] as const);
    if (action === "info") return { ref: ref(o.ref), action };
    const branch = str(o.branch, 120, 1);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch)) fail();
    return { ref: ref(o.ref), action, branch, requestId: str(o.requestId, 128, 1) };
  },
  answer: (o) =>
    pick({
      id: str(o.id, CLI_LIMITS.requestId, 1),
      decision: oneOf(o.decision, CLI_ANSWER_DECISIONS),
      answers: present(o, "answers") ? answersMap(o.answers) : undefined,
      message: optStr(o, "message", CLI_LIMITS.answerMessage),
      always: optBool(o, "always") === true ? true : undefined,
    }),
};

const RESULT_PARSERS: { [K in CliOp]: (o: Rec) => CliOpResult[K] } = {
  read: (o) => ({ items: items(o.items), more: bool(o.more) }),
  watch: () => ({}),
  unwatch: () => ({}),
  start: (o) =>
    pick({
      ref: ref(o.ref),
      terminal: str(o.terminal, CLI_LIMITS.terminal, 1),
      cwd: optStr(o, "cwd", CLI_LIMITS.cwd, 1),
    }),
  continue: (o) => ({ ref: ref(o.ref), terminal: str(o.terminal, CLI_LIMITS.terminal, 1) }),
  send: (o) =>
    pick({
      turn: int(o.turn, 0, COUNTER_MAX),
      started: bool(o.started),
      delivery: present(o, "delivery") ? oneOf(o.delivery, CLI_DELIVERY) : undefined,
      waiting: optBool(o, "waiting"),
    }),
  steer: (o) => ({ accepted: bool(o.accepted) }),
  interrupt: (o) => ({ outcome: str(o.outcome, CLI_LIMITS.reason) }),
  open_local: () => ({}),
  // a device that answers with an empty result still counts as delivered
  answer: (o) => ({ outcome: present(o, "outcome") ? str(o.outcome, CLI_LIMITS.reason) : "ok" }),
  git: (o) => {
    const source = oneOf(o.source, ["worktree", "folder", "none", "failed"] as const);
    const files = present(o, "files") ? arr(o.files, 500).map((entry) => str(entry, 1024, 1)) : undefined;
    return pick({
      source,
      project: optStr(o, "project", CLI_LIMITS.cwd, 1),
      worktree: optStr(o, "worktree", CLI_LIMITS.cwd, 1),
      branch: optStr(o, "branch", CLI_LIMITS.gitBranch, 1),
      head: optStr(o, "head", 64, 1),
      files,
      added: optInt(o, "added", 0, 1_000_000),
      removed: optInt(o, "removed", 0, 1_000_000),
      error: optStr(o, "error", CLI_LIMITS.message, 1),
    });
  },
  search: (o) => ({
    hits: arr(o.hits, CLI_SEARCH.maxLimit).map((entry) => {
      const hit = rec(entry);
      return { ref: ref(hit.ref), snippet: str(hit.snippet, CLI_SEARCH.snippetMax * 2) };
    }),
  }),
  attach: (o) => {
    const path = str(o.path, CLI_LIMITS.imagePath, 1);
    if (!isAbsoluteCwd(path)) fail();
    return { path };
  },
  models: (o) => modelCatalog(o),
  dirs: (o) => dirListing(o),
};

/** One folder's sub-folders on a computer. */
export interface CliDirListing {
  /** the folder listed; "" for the roots */
  path: string;
  /** one level up; absent at a drive, `/` and the roots */
  parent?: string;
  exists: boolean;
  /** the folder is a Git repository */
  git?: boolean;
  entries: Array<{ name: string; path: string; git?: boolean }>;
  /** more sub-folders than the computer sends */
  more?: boolean;
}

export const CLI_DIR_LIMIT = 500;

export function parseCliDirListing(value: unknown): CliDirListing | null {
  return guard(() => dirListing(rec(value)));
}

function dirListing(o: Rec): CliDirListing {
  const path = str(o.path, CLI_LIMITS.cwd);
  const entries: CliDirListing["entries"] = [];
  for (const entry of arr(o.entries, CLI_DIR_LIMIT)) {
    const row = rec(entry);
    const childPath = str(row.path, CLI_LIMITS.cwd, 1);
    if (!isAbsoluteCwd(childPath)) continue;
    entries.push(pick({ name: str(row.name, 255, 1), path: childPath, git: row.git === true ? true : undefined }));
  }
  return pick({
    path,
    parent: optStr(o, "parent", CLI_LIMITS.cwd, 1),
    exists: bool(o.exists),
    git: o.git === true ? true : undefined,
    entries,
    more: o.more === true ? true : undefined,
  });
}

/** A catalog from the computer (or Core). A row that is no valid model name is left out rather than failing the list. */
export function parseCliModelCatalog(value: unknown): CliModelCatalog | null {
  return guard(() => modelCatalog(rec(value)));
}

function modelCatalog(o: Rec): CliModelCatalog {
  const models: CliModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of arr(o.models, CLI_MODEL_LIMITS.models)) {
    const row = rec(entry);
    if (!isCliModel(row.id) || seen.has(row.id)) continue;
    seen.add(row.id);
    const label = typeof row.label === "string" && row.label.trim() ? row.label.trim().slice(0, CLI_MODEL_LIMITS.label) : row.id;
    const description = typeof row.description === "string" && row.description.trim() ? row.description.trim().slice(0, CLI_MODEL_LIMITS.description) : undefined;
    const efforts = Array.isArray(row.efforts) ? [...new Set(row.efforts.filter((level): level is string => typeof level === "string" && level.length <= 32))].slice(0, 16) : undefined;
    models.push(pick({ id: row.id, label, description, efforts }));
  }
  return pick({
    models,
    current: isCliModel(o.current) ? o.current : undefined,
    currentEffort: typeof o.currentEffort === "string" && o.currentEffort.length <= 32 && o.currentEffort ? o.currentEffort : undefined,
  });
}

export function parseCliOpArgs<K extends CliOp>(op: K, value: unknown): CliOpArgs[K] | null {
  if (!isCliOp(op)) return null;
  return guard(() => (ARGS_PARSERS[op] as (o: Rec) => CliOpArgs[K])(rec(value)));
}

/** Validates the `result` of a successful cli.reply for the op it answers. */
export function parseCliOpResult<K extends CliOp>(op: K, value: unknown): CliOpResult[K] | null {
  if (!isCliOp(op)) return null;
  return guard(() => (RESULT_PARSERS[op] as (o: Rec) => CliOpResult[K])(rec(value)));
}

// A cli.reply result is typed per op by parseCliOpResult once Core knows which
// op the opId belongs to; here it only has to be bounded plain JSON.
const RESULT_MAX_DEPTH = 6;

function plainJson(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return value;
  }
  if (depth >= RESULT_MAX_DEPTH) fail();
  if (Array.isArray(value)) {
    if (value.length > 1000) fail();
    return value.map((entry) => plainJson(entry, depth + 1));
  }
  const o = rec(value);
  const keys = Object.keys(o);
  if (keys.length > 100) fail();
  const out: Rec = {};
  for (const k of keys) {
    if (k === "__proto__") fail();
    out[k] = plainJson(o[k], depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsers: messages

export function parseDeviceCliMessage(value: unknown): DeviceCliMessage | null {
  return guard((): DeviceCliMessage => {
    const o = rec(value);
    switch (o.type) {
      case "cli.sessions":
        return {
          type: "cli.sessions",
          full: bool(o.full),
          upserts: arr(o.upserts, MAX_SESSIONS).map(sessionWire),
          removes: arr(o.removes, MAX_SESSIONS).map(ref),
          seq: int(o.seq, 0, COUNTER_MAX),
        };
      case "cli.items":
        return pick({
          type: "cli.items" as const,
          ref: ref(o.ref),
          items: items(o.items),
          reset: optBool(o, "reset"),
          more: optBool(o, "more"),
        });
      case "cli.turn":
        return pick({
          type: "cli.turn" as const,
          ref: ref(o.ref),
          turn: int(o.turn, 0, COUNTER_MAX),
          endedAt: int(o.endedAt, 0, COUNTER_MAX),
          reason: oneOf(o.reason, CLI_TURN_REASONS),
          error: optStr(o, "error", CLI_LIMITS.turnError),
        });
      case "cli.request": {
        const fields = requestFields(o);
        return pick({ type: "cli.request" as const, ref: ref(o.ref), ...fields });
      }
      case "cli.request.resolved":
        return {
          type: "cli.request.resolved",
          id: str(o.id, CLI_LIMITS.requestId, 1),
          by: oneOf(o.by, CLI_REQUEST_RESOLVED_BY),
        };
      case "cli.reply": {
        const ok = bool(o.ok);
        const result = present(o, "result") ? (plainJson(rec(o.result), 0) as Record<string, unknown>) : undefined;
        const error = present(o, "error") ? cliError(o.error) : undefined;
        if (!ok && !error) fail();
        return pick({
          type: "cli.reply" as const,
          opId: str(o.opId, CLI_LIMITS.opId, 1),
          ok,
          result,
          error,
        });
      }
      case "cli.term.opened":
        return {
          type: "cli.term.opened",
          sid: sid(o.sid),
          cols: cols(o.cols),
          rows: rows(o.rows),
          observe: bool(o.observe),
        };
      case "cli.term.size":
        return { type: "cli.term.size", sid: sid(o.sid), cols: cols(o.cols), rows: rows(o.rows) };
      case "cli.term.closed":
        return pick({
          type: "cli.term.closed" as const,
          sid: sid(o.sid),
          reason: str(o.reason, CLI_LIMITS.reason),
          exitCode: optInt(o, "exitCode", -0x8000_0000, 0xffff_ffff),
        });
      case "cli.term.error":
        return { type: "cli.term.error", sid: sid(o.sid), code: oneOf(o.code, CLI_ERROR_CODES) };
      default:
        return fail();
    }
  });
}

export function parseCoreCliMessage(value: unknown): CoreCliMessage | null {
  return guard((): CoreCliMessage => {
    const o = rec(value);
    switch (o.type) {
      case "cli.op": {
        const op = oneOf(o.op, CLI_OPS);
        const args = (ARGS_PARSERS[op] as (a: Rec) => unknown)(rec(o.args));
        return {
          type: "cli.op",
          opId: str(o.opId, CLI_LIMITS.opId, 1),
          op,
          args,
          deadlineMs: int(o.deadlineMs, 1, CLI_LIMITS.deadlineMs),
        } as CoreCliMessage;
      }
      case "cli.term.open":
        return {
          type: "cli.term.open",
          sid: sid(o.sid),
          ref: ref(o.ref),
          cols: cols(o.cols),
          rows: rows(o.rows),
          observe: bool(o.observe),
        };
      case "cli.term.resize":
        return { type: "cli.term.resize", sid: sid(o.sid), cols: cols(o.cols), rows: rows(o.rows) };
      case "cli.term.credit":
        return { type: "cli.term.credit", sid: sid(o.sid), bytes: int(o.bytes, 1, CORE_STREAM_BUFFER_MAX) };
      case "cli.term.close":
        return { type: "cli.term.close", sid: sid(o.sid) };
      case "cli.resync":
        return { type: "cli.resync" };
      default:
        return fail();
    }
  });
}

export function parseClientMessage(value: unknown): ClientMessage | null {
  return guard((): ClientMessage => {
    const o = rec(value);
    switch (o.type) {
      case "sub.list":
        return { type: "sub.list" };
      case "sub.session":
        return pick({ type: "sub.session" as const, key: key(o.key), known: present(o, "known") ? arr(o.known, 200).map(v => str(v, 512, 66)) : undefined });
      case "unsub.session":
        return { type: "unsub.session", key: key(o.key) };
      case "term.open":
        return {
          type: "term.open",
          req: str(o.req, CLI_LIMITS.req, 1),
          key: key(o.key),
          cols: cols(o.cols),
          rows: rows(o.rows),
          observe: bool(o.observe),
        };
      case "term.resize":
        return { type: "term.resize", sid: sid(o.sid), cols: cols(o.cols), rows: rows(o.rows) };
      case "term.credit":
        return { type: "term.credit", sid: sid(o.sid), bytes: int(o.bytes, 1, CORE_STREAM_BUFFER_MAX) };
      case "term.close":
        return { type: "term.close", sid: sid(o.sid) };
      case "ping":
        return { type: "ping" };
      default:
        return fail();
    }
  });
}

export function parseServerMessage(value: unknown): ServerMessage | null {
  return guard((): ServerMessage => {
    const o = rec(value);
    switch (o.type) {
      case "list":
        return {
          type: "list",
          devices: arr(o.devices, CLI_LIMITS.devices).map(deviceView),
          sessions: arr(o.sessions, CLI_LIMITS.listSessions).map(sessionView),
        };
      case "list.delta":
        return pick({
          type: "list.delta" as const,
          upserts: arr(o.upserts, CLI_LIMITS.listSessions).map(sessionView),
          removes: arr(o.removes, CLI_LIMITS.listSessions).map(key),
          devices: present(o, "devices") ? arr(o.devices, CLI_LIMITS.devices).map(deviceView) : undefined,
        });
      case "items":
        return pick({
          type: "items" as const,
          key: key(o.key),
          items: items(o.items),
          reset: optBool(o, "reset"),
          more: optBool(o, "more"),
          snapshot: present(o, "snapshot") ? arr(o.snapshot, 200).map(v => str(v, 512, 66)) : undefined,
        });
      case "term.opened":
        return {
          type: "term.opened",
          req: str(o.req, CLI_LIMITS.req, 1),
          sid: sid(o.sid),
          cols: cols(o.cols),
          rows: rows(o.rows),
          observe: bool(o.observe),
        };
      case "term.size":
        return { type: "term.size", sid: sid(o.sid), cols: cols(o.cols), rows: rows(o.rows) };
      case "term.closed":
        return { type: "term.closed", sid: sid(o.sid), reason: str(o.reason, CLI_LIMITS.reason) };
      case "error":
        return pick({
          type: "error" as const,
          code: oneOf(o.code, CLI_ERROR_CODES),
          req: optStr(o, "req", CLI_LIMITS.req, 1),
          message: optStr(o, "message", CLI_LIMITS.message),
        });
      case "summary":
        return { type: "summary", waiting: int(o.waiting, 0, 1_000_000), running: int(o.running, 0, 1_000_000) };
      case "requests": {
        const sessionKey = key(o.key);
        const requests = arr(o.requests, CLI_LIMITS.requestsPerSession).map(requestView);
        // a requests message is one session's list
        if (requests.some((request) => request.key !== sessionKey)) fail();
        return { type: "requests", key: sessionKey, requests };
      }
      case "request.resolved":
        return {
          type: "request.resolved",
          key: key(o.key),
          id: str(o.id, CLI_LIMITS.requestId, 1),
          by: oneOf(o.by, CLI_REQUEST_RESOLVED_BY),
        };
      case "queue":
        return { type: "queue", queue: queueView(o.queue) };
      case "workbench":
        return { type: "workbench", sessions: arr(o.sessions, CLI_LIMITS.listSessions).map(workbenchSession) };
      case "pong":
        return { type: "pong" };
      default:
        return fail();
    }
  });
}

/** A user record that is only a CLI command's bookkeeping (`/model`, `/compact`…): the command
 * line, its arguments, its local output or the caveat Claude Code writes before them. */
const CLI_COMMAND_RECORD = /^\s*(?:<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*?<\/\1>\s*)+$/;
export function isCliCommandRecord(text: string): boolean {
  return CLI_COMMAND_RECORD.test(text);
}

/** Why a model call failed, in a few words, for an error the CLI recorded ("API Error: …").
 * Null for any other notice. The provider's raw wording is never shown. */
export function modelFailureReason(text: string): string | null {
  const raw = text.trim();
  if (!/^(api error|api_error)\b|request rejected|overloaded_error|rate_limit_error|authentication_error|invalid_request_error|\bHTTP (4|5)\d\d\b/i.test(raw)) return null;
  const status = Number(/\((\d{3})\)|HTTP (\d{3})|\b(\d{3})\b/.exec(raw)?.slice(1).find(Boolean) ?? 0);
  if (/credit|quota|usage limit|billing|balance|insufficient|余额|额度/i.test(raw)) return "模型服务的额度已用完";
  if (status === 429 || /rate.?limit|too many requests/i.test(raw)) return "模型服务请求太频繁，被限流了";
  if (status === 401 || status === 403 || /authentication|api key|unauthori[sz]ed|forbidden|permission/i.test(raw)) return "模型服务的密钥无效或没有权限";
  if (/context|too long|maximum.*tokens|prompt is too long/i.test(raw)) return "对话内容超出了模型的上下文长度";
  if (status === 404 || /model.*not.*(found|exist|available)/i.test(raw)) return "找不到这个模型，请换一个模型";
  if (status === 529 || status >= 500 || /overloaded|unavailable|internal server/i.test(raw)) return "模型服务暂时不可用";
  if (/timeout|timed out|ECONN|ENOTFOUND|network|fetch failed|socket/i.test(raw)) return "连接不上模型服务";
  return "模型服务返回了错误";
}

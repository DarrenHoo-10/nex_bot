// The computer side of the Claude hooks (plan 7.1 and 7.3): a listener on a
// local named pipe / unix socket that the plugin's hook.mjs talks to. A
// permission prompt or an AskUserQuestion of a Claude session that nex_bot
// started becomes a `cli.request` for Core; the answer Core relays comes back
// through `answer()` and is handed to the waiting hook. Turn ends (the Stop
// hook, a status change, a Codex task_complete) become `cli.turn`.
//
// Everything fails towards the terminal: when Core is unreachable, the feature
// is paused or off, the token is wrong, the request expires or the link drops,
// the hook is told to pass and Claude Code asks in its own terminal as usual.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_LIMITS,
  cliRef,
  type CliOpArgs,
  type CliRequestQuestion,
  type CliRequestResolvedBy,
  type CliSessionRef,
  type CliTurnReason,
  type DeviceCliMessage,
} from "../../../shared/cli-agents.ts";
import { clipUnits, summarizeInput } from "./items.ts";

/** A request stays open this long. Claude Code ends the hook at 1800 s (hooks.json), so ours ends first. */
export const REQUEST_TTL_MS = 1_790_000;
const FIRST_LINE_MS = 10_000;
const LINE_LIMIT = 1024 * 1024;
const TURN_DEDUPE_MS = 10_000;

export class HookError extends Error {
  constructor(readonly code: "not_found" | "invalid", message?: string) {
    super(message ?? code);
  }
}

type Emit = (message: DeviceCliMessage) => boolean;

/** The plugin directory: NEX_CLI_PLUGIN_PATH, then `cli-agents-plugin/` beside the executor's
 * `client-node/` folder (the packaged layout, like herdr-core), then `plugin/` next to this
 * source file. Null when none has a plugin manifest. */
export function locateHookPlugin(options: { env?: NodeJS.ProcessEnv; moduleUrl?: string } = {}): string | null {
  const env = options.env ?? process.env;
  const here = path.dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
  const candidates = [env.NEX_CLI_PLUGIN_PATH?.trim(), path.resolve(here, "..", "cli-agents-plugin"), path.join(here, "plugin")];
  for (const candidate of candidates) {
    if (candidate && existsSync(path.join(candidate, ".claude-plugin", "plugin.json"))) return path.resolve(candidate);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Turn ends

export type TurnSource = "stop" | "status" | "codex";

/** Numbers the turns of each session and reports `cli.turn` once per turn end,
 * whichever of the hook, the status fallback and the Codex rollout saw it. */
export class TurnTracker {
  private readonly last = new Map<string, { at: number; endedAt: number; source: TurnSource }>();
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly emit: Emit,
    private readonly now: () => number = Date.now,
    private readonly dedupeMs = TURN_DEDUPE_MS,
  ) {}

  /** Returns false when nothing was sent (a repeat, or no link to Core). */
  report(ref: CliSessionRef, reason: CliTurnReason, source: TurnSource, options: { endedAt?: number; error?: string } = {}): boolean {
    const at = this.now();
    const endedAt = options.endedAt ?? at;
    const previous = this.last.get(ref);
    if (previous) {
      if (endedAt <= previous.endedAt) return false;
      // The status fallback guesses; any report close before it is the real one. A Stop hook that
      // comes right after the fallback is the same turn.
      if (source === "status" && at - previous.at < this.dedupeMs) return false;
      if (source === "stop" && previous.source === "status" && at - previous.at < 5000) return false;
    }
    const turn = (this.counts.get(ref) ?? 0) + 1;
    const sent = this.emit({
      type: "cli.turn",
      ref,
      turn,
      endedAt,
      reason,
      ...(options.error ? { error: clipUnits(options.error, CLI_LIMITS.turnError) } : {}),
    });
    if (!sent) return false;
    this.counts.set(ref, turn);
    this.last.set(ref, { at, endedAt, source });
    return true;
  }

  forget(ref: CliSessionRef): void {
    this.last.delete(ref);
    this.counts.delete(ref);
  }
}

// ---------------------------------------------------------------------------
// The hook server

export interface HookServerOptions {
  /** Where `hook-secret` lives. */
  dir: string;
  emit: Emit;
  turns: TurnTracker;
  /** The feature is on, not paused, and Core is reachable: otherwise every hook passes. */
  active: () => boolean;
  /** The session runs in a live nex_bot terminal. A token of any other session is refused. */
  isLive: (ref: CliSessionRef) => boolean;
  platform?: NodeJS.Platform;
  /** Directory of the unix socket. Default: the temp directory. */
  socketDir?: string;
  ttlMs?: number;
  now?: () => number;
  log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
}

interface Pending {
  id: string;
  ref: CliSessionRef;
  tool: string;
  toolUseId?: string;
  canonical: string;
  questions?: CliRequestQuestion[];
  isQuestion: boolean;
  socket: net.Socket;
  timer: NodeJS.Timeout;
  done: boolean;
}

type Reply = { decision: "allow" | "deny" | "pass"; message?: string; answers?: Record<string, string> };

interface HookInput {
  tool_name?: unknown;
  tool_use_id?: unknown;
  tool_input?: unknown;
}

const isRec = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRec(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The questions of an AskUserQuestion, or null when they do not fit what Core accepts (the card is then skipped). */
function questionsOf(input: unknown): CliRequestQuestion[] | null {
  if (!isRec(input) || !Array.isArray(input.questions)) return null;
  const list = input.questions;
  if (list.length < 1 || list.length > CLI_LIMITS.requestQuestions) return null;
  const out: CliRequestQuestion[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!isRec(entry) || typeof entry.question !== "string" || !entry.question || entry.question.length > CLI_LIMITS.requestQuestion) return null;
    if (seen.has(entry.question) || entry.question === "__proto__") return null;
    seen.add(entry.question);
    if (!Array.isArray(entry.options) || entry.options.length > CLI_LIMITS.requestOptions) return null;
    const options: CliRequestQuestion["options"] = [];
    for (const option of entry.options) {
      if (!isRec(option) || typeof option.label !== "string" || !option.label || option.label.length > CLI_LIMITS.requestOption) return null;
      options.push({
        label: option.label,
        ...(typeof option.description === "string" && option.description ? { description: clipUnits(option.description, CLI_LIMITS.requestDescription) } : {}),
      });
    }
    out.push({
      question: entry.question,
      ...(typeof entry.header === "string" && entry.header ? { header: clipUnits(entry.header, CLI_LIMITS.requestOption) } : {}),
      options,
      ...(entry.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return out;
}

export class HookServer {
  private readonly platform: NodeJS.Platform;
  private readonly secret: Buffer;
  private readonly pipePath: string;
  private readonly pending = new Map<string, Pending>();
  private readonly sockets = new Set<net.Socket>();
  private server: net.Server | null = null;
  private starting: Promise<void> | null = null;
  private closed = false;
  private refused = 0;

  constructor(private readonly options: HookServerOptions) {
    this.platform = options.platform ?? process.platform;
    this.secret = loadSecret(options.dir);
    const name = `nexbot-hook-${this.mac("pipe", "").slice(0, 16)}`;
    this.pipePath = this.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(options.socketDir ?? os.tmpdir(), `${name}.sock`);
  }

  /** The address hook.mjs connects to (NEXBOT_HOOK_PIPE). */
  get pipe(): string {
    return this.pipePath;
  }

  /** How many connections were turned away for a bad token. */
  get refusals(): number {
    return this.refused;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string): void {
    try {
      this.options.log?.(level, `hooks: ${message}`);
    } catch {
      // logging must not break the server
    }
  }

  private mac(purpose: string, value: string): string {
    return createHmac("sha256", this.secret).update(`nexbot-hook\0${purpose}\0${value}`).digest("hex");
  }

  /** The token of one session: `<mac>.<native id>`. It is only good while the session's terminal lives. */
  tokenFor(ref: CliSessionRef): string {
    return `${this.mac("token", ref)}.${ref.slice(ref.indexOf(":") + 1)}`;
  }

  /** The variables the terminal of a Claude session gets. */
  environment(ref: CliSessionRef, node: string): Record<string, string> {
    return { NEXBOT_HOOK_NODE: node, NEXBOT_HOOK_PIPE: this.pipePath, NEXBOT_HOOK_TOKEN: this.tokenFor(ref) };
  }

  private refFor(token: unknown): CliSessionRef | null {
    if (typeof token !== "string" || token.length > 400) return null;
    const dot = token.indexOf(".");
    if (dot !== 64) return null;
    let ref: CliSessionRef;
    try {
      ref = cliRef("claude", token.slice(dot + 1));
    } catch {
      return null;
    }
    const given = Buffer.from(token.slice(0, dot));
    const expected = Buffer.from(this.mac("token", ref));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    return ref;
  }

  // -- listening ------------------------------------------------------------------

  start(): Promise<void> {
    this.starting ??= this.listen().catch((error) => {
      this.starting = null;
      throw error;
    });
    return this.starting;
  }

  private async listen(): Promise<void> {
    if (this.closed) return;
    if (this.platform !== "win32") await this.clearStaleSocket();
    const server = net.createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.pipePath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (error) => this.log("warn", `listener error: ${String(error)}`));
    if (this.platform !== "win32") {
      try {
        chmodSync(this.pipePath, 0o600);
      } catch {
        // the directory is private enough, and the token is still required
      }
    }
    if (this.closed) {
      server.close();
      return;
    }
    this.server = server;
  }

  /** A socket file left by a crashed client blocks `listen`; a live one must stay. */
  private async clearStaleSocket(): Promise<void> {
    const alive = await new Promise<boolean>((resolve) => {
      const probe = net.connect(this.pipePath);
      probe.once("connect", () => (probe.destroy(), resolve(true)));
      probe.once("error", () => resolve(false));
    });
    if (alive) throw new Error("another nex_bot client is already listening for hooks");
    try {
      unlinkSync(this.pipePath);
    } catch {
      // nothing to remove
    }
  }

  /** Stops listening and tells every waiting hook to pass. */
  async close(): Promise<void> {
    this.closed = true;
    this.passAll();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.platform !== "win32") {
      try {
        unlinkSync(this.pipePath);
      } catch {
        // already gone
      }
    }
  }

  /** The link to Core dropped: the prompts go back to the terminal. Core closes its copies itself. */
  linkLost(): void {
    this.passAll();
  }

  private passAll(): void {
    // deleting the current entry while iterating a Map is safe
    for (const pending of this.pending.values()) this.finish(pending, null, { decision: "pass" });
  }

  // -- connections ----------------------------------------------------------------

  private onConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("close", () => this.sockets.delete(socket));
    let buffer = "";
    let received = false;
    const idle = setTimeout(() => socket.destroy(), FIRST_LINE_MS);
    idle.unref?.();
    socket.on("close", () => clearTimeout(idle));
    socket.on("data", (chunk: string) => {
      if (received) return;
      buffer += chunk;
      if (buffer.length > LINE_LIMIT) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      received = true;
      clearTimeout(idle);
      this.dispatch(socket, buffer.slice(0, end));
    });
  }

  private reply(socket: net.Socket, reply: Reply): void {
    if (socket.destroyed || !socket.writable) return;
    socket.end(JSON.stringify({ v: 1, ...reply }) + "\n");
  }

  private dispatch(socket: net.Socket, line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      socket.destroy();
      return;
    }
    if (!isRec(message) || message.v !== 1 || !isRec(message.input) || typeof message.event !== "string") {
      socket.destroy();
      return;
    }
    const ref = this.refFor(message.token);
    if (!ref || !this.options.isLive(ref)) {
      this.refused += 1;
      this.reply(socket, { decision: "pass" });
      return;
    }
    const input = message.input as HookInput;
    switch (message.event) {
      case "permission":
        this.onPermission(socket, ref, input);
        return;
      case "post":
        this.onPost(ref, input);
        this.reply(socket, { decision: "pass" });
        return;
      case "stop":
        if (this.options.active()) this.options.turns.report(ref, "end", "stop");
        this.reply(socket, { decision: "pass" });
        return;
      default:
        this.reply(socket, { decision: "pass" });
    }
  }

  // -- permission prompts and questions -------------------------------------------------

  private onPermission(socket: net.Socket, ref: CliSessionRef, input: HookInput): void {
    const tool = typeof input.tool_name === "string" ? input.tool_name : "";
    if (!tool || this.closed || !this.options.active()) {
      this.reply(socket, { decision: "pass" });
      return;
    }
    let count = 0;
    for (const pending of this.pending.values()) if (pending.ref === ref) count += 1;
    if (count >= CLI_LIMITS.requestsPerSession) {
      this.reply(socket, { decision: "pass" });
      return;
    }
    const isQuestion = tool === "AskUserQuestion";
    const questions = isQuestion ? questionsOf(input.tool_input) : undefined;
    if (isQuestion && !questions) {
      this.reply(socket, { decision: "pass" });
      return;
    }
    const now = (this.options.now ?? Date.now)();
    const id = randomUUID();
    const summary = questions ? questions[0].question : summarizeInput(input.tool_input);
    const pending: Pending = {
      id,
      ref,
      tool,
      ...(typeof input.tool_use_id === "string" && input.tool_use_id ? { toolUseId: input.tool_use_id } : {}),
      canonical: canonical(input.tool_input),
      ...(questions ? { questions } : {}),
      isQuestion,
      socket,
      timer: setTimeout(() => this.finish(pending, "timeout", { decision: "pass" }), this.options.ttlMs ?? REQUEST_TTL_MS),
      done: false,
    };
    pending.timer.unref?.();
    this.pending.set(id, pending);
    // Claude Code ends the hook when the prompt is answered in the terminal.
    socket.on("close", () => this.finish(pending, "terminal", null));
    const sent = this.options.emit({
      type: "cli.request",
      ref,
      id,
      kind: isQuestion ? "question" : "permission",
      tool: clipUnits(tool, CLI_LIMITS.requestTool),
      summary,
      ...(questions ? { questions } : {}),
      expiresAt: now + (this.options.ttlMs ?? REQUEST_TTL_MS),
    });
    if (!sent) this.finish(pending, null, { decision: "pass" });
  }

  /** PostToolUse: the tool ran, so a prompt for it was answered in the terminal. */
  private onPost(ref: CliSessionRef, input: HookInput): void {
    const tool = typeof input.tool_name === "string" ? input.tool_name : "";
    if (!tool) return;
    const toolUseId = typeof input.tool_use_id === "string" ? input.tool_use_id : "";
    const mine = [...this.pending.values()].filter((pending) => pending.ref === ref && pending.tool === tool);
    if (mine.length === 0) return;
    // A PermissionRequest may carry no tool_use_id, so the input pairs them; a lone prompt for the tool is the one.
    const same = canonical(input.tool_input);
    const match =
      mine.find((pending) => toolUseId !== "" && pending.toolUseId === toolUseId) ??
      mine.find((pending) => pending.canonical === same) ??
      (mine.length === 1 && !mine[0].toolUseId ? mine[0] : undefined);
    if (match) this.finish(match, "terminal", { decision: "pass" });
  }

  /** Closes a request once. `by` tells Core who closed it (null: Core already knows or is gone). */
  private finish(pending: Pending, by: CliRequestResolvedBy | null, reply: Reply | null): boolean {
    if (pending.done) return false;
    pending.done = true;
    clearTimeout(pending.timer);
    this.pending.delete(pending.id);
    if (by) this.options.emit({ type: "cli.request.resolved", id: pending.id, by });
    if (reply) this.reply(pending.socket, reply);
    else pending.socket.destroy();
    return true;
  }

  /** Core relays an answer (op `answer`). Throws HookError when the request is no longer open. */
  answer(args: CliOpArgs["answer"]): string {
    const pending = this.pending.get(args.id);
    if (!pending || pending.done) throw new HookError("not_found", "request is closed");
    if (pending.socket.destroyed || !pending.socket.writable) {
      this.finish(pending, "terminal", null);
      throw new HookError("not_found", "request is closed");
    }
    let reply: Reply;
    if (args.decision === "deny") {
      reply = { decision: "deny", ...(args.message ? { message: args.message } : {}) };
    } else if (pending.isQuestion) {
      const answers = args.answers;
      if (!answers || !isRec(answers)) throw new HookError("invalid");
      const chosen: Record<string, string> = {};
      for (const question of pending.questions ?? []) {
        const value = answers[question.question];
        if (typeof value !== "string" || value === "") throw new HookError("invalid");
        chosen[question.question] = value;
      }
      reply = { decision: "allow", answers: chosen };
    } else {
      reply = { decision: "allow" };
    }
    // Core closes its copy when this answer succeeds, so no resolved message goes back.
    this.finish(pending, null, reply);
    return "ok";
  }
}

function loadSecret(dir: string): Buffer {
  const file = path.join(dir, "hook-secret");
  const read = (): Buffer | null => {
    try {
      const text = readFileSync(file, "utf8").trim();
      return /^[0-9a-f]{64}$/.test(text) ? Buffer.from(text, "hex") : null;
    } catch {
      return null;
    }
  };
  const existing = read();
  if (existing) return existing;
  mkdirSync(dir, { recursive: true });
  const secret = randomBytes(32);
  try {
    writeFileSync(file, secret.toString("hex"), { mode: 0o600, flag: "wx" });
    return secret;
  } catch {
    // another process wrote it first, or an unusable file is there
    const again = read();
    if (again) return again;
    writeFileSync(file, secret.toString("hex"), { mode: 0o600 });
    return secret;
  }
}

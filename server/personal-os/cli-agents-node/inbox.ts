// Sending a message into a live Claude Code session that runs outside nex_bot's
// terminals (the user's own terminal, the Claude desktop app) through the
// session's inbox: a named pipe on Windows, a unix socket elsewhere, announced
// in `<config>/sessions/<pid>.json` as `messagingSocketPath`.
//
// Wire format (sender to inbox only, the inbox never answers): one JSON object per
// line, at most 1 MiB. The first line authenticates with the peer token kept in
// `<config>/sessions/<pid>.<sha256 of the canonical socket path>.key`; the second is
// the message. The inbox closes a connection that sends no complete line within 30 s.
//
// The token is read at send time for that one session, held in memory for the
// length of the call and never logged, returned or put in an error message.
//
// Claude Code (2.1.330 checked) gates every inbox message by permission class.
// A session that runs without asking (`bypassPermissions`) queues a message only
// when it declares the same class, in a `<cross-session-message from-mode="bypass">`
// envelope around the content; an undeclared or other class is held, out of the
// transcript, until someone releases it on that computer. A prompting session
// queues an undeclared message, and holds a `bypass` one. So the class sent is
// the receiving session's own, read from the permission mode its transcript last
// recorded: the user who owns the session is the one sending.
import { createHash, randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { CliDelivery, CliErrorCode, CliSessionState } from "../../../shared/cli-agents.ts";

const FRAME_MAX = 1024 * 1024;
const KEY_FILE_MAX = 16 * 1024;
const TOKEN_MAX = 1024;
const CONNECT_MS = 5000;
const CONFIRM_MS = 6000;
const CONFIRM_POLL_MS = 150;
const PIPE_PREFIX = "\\\\.\\pipe\\";

export class InboxError extends Error {
  constructor(
    readonly code: CliErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InboxError";
  }
}

export interface InboxTarget {
  configDir: string;
  pid: number;
  socketPath: string;
  sessionId: string;
}

export interface InboxSendOptions {
  platform?: NodeJS.Platform;
  /** The session's transcript, watched for the message to show up. None: the result is "unconfirmed". */
  transcript?: string | null;
  /** The row's state when the message was sent. `waiting` is reported back. */
  state?: CliSessionState;
  confirmMs?: number;
  connectMs?: number;
  pollMs?: number;
  uuid?: () => string;
  /** The user pressed Stop: the inbox's priority `now` aborts the running turn (Claude
   * Code's own "send now"), and the words ask the model to stop and say where. */
  stop?: boolean;
  /** The receiving session's permission class; by default read from `transcript` (null: not known). */
  permissionClass?: InboxPermissionClass | null;
}

/** What Stop sends: start nothing else, say in one sentence where it stopped. */
export const INBOX_STOP =
  "[NexBot 远程停止 / NexBot remote stop]\n" +
  "用户在 NexBot 上按了停止：请立即停下当前的工作，不要开始任何新的事情，用一句话说明停在了哪里（用本会话的语言）。\n" +
  "The user pressed Stop in NexBot: stop what you are doing now, start nothing else, and say in one sentence where you stopped, in this conversation's language.";

export interface InboxResult {
  delivery: CliDelivery;
  /** The session waits for an answer on the computer; the message is read after that. */
  waiting: boolean;
}

/** Tells the session who is talking and how to ask back. The desktop app shows it in its
 * "message from another session" card above the user's words, so it is one line. */
export const INBOX_PREAMBLE =
  "[NexBot] 用户本人在另一台设备上发来，请在本会话直接回答；需要选择时用 1. 2. 3. 纯文本选项，不用交互式提问工具。\n---\n";
/** The preamble releases up to 0.9.42 sent; their messages are still in transcripts. */
const LEGACY_PREAMBLE_HEAD = "[NexBot 远程消息 / NexBot remote message]\n";

/** The wire text of a message: preamble first. */
export function inboxMessageText(text: string): string {
  return INBOX_PREAMBLE + text;
}

/** What a peer message this module sent says: the user's words, or Stop; null for any other text. */
export function inboxWords(body: string): { text: string } | { stop: true } | null {
  if (body.startsWith(INBOX_STOP.slice(0, INBOX_STOP.indexOf("\n")))) return { stop: true };
  if (body.startsWith(INBOX_PREAMBLE)) return { text: body.slice(INBOX_PREAMBLE.length) };
  if (!body.startsWith(LEGACY_PREAMBLE_HEAD)) return null;
  const rule = body.indexOf("\n---\n");
  return rule < 0 ? null : { text: body.slice(rule + 5) };
}

/** Claude Code's permission class: `bypass` for a session that runs tools without asking. */
export type InboxPermissionClass = "bypass" | "prompting";

const MODE_TAIL = 2 * 1024 * 1024;
const MODE_RE = /"permissionMode":"([A-Za-z]+)"/g;

/** The class Claude Code gives the modes a transcript recorded, oldest first; null when it recorded none.
 * Plan mode keeps the class of the mode it was entered from (Claude Code counts plan as bypass when
 * bypass is available to the session, which a session that ran in bypass has). */
export function permissionClassOf(modes: readonly string[]): InboxPermissionClass | null {
  for (let i = modes.length - 1; i >= 0; i--) {
    if (modes[i] === "plan") continue;
    return modes[i] === "bypassPermissions" ? "bypass" : "prompting";
  }
  return modes.length ? "prompting" : null;
}

/** The receiving session's class, from the permission modes the end of its transcript recorded. */
export async function transcriptPermissionClass(file: string | null | undefined): Promise<InboxPermissionClass | null> {
  if (!file) return null;
  let handle;
  try {
    handle = await open(file, "r");
    const size = (await handle.stat()).size;
    const length = Math.min(size, MODE_TAIL);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, size - length);
    const modes = Array.from(buf.toString("utf8", 0, bytesRead).matchAll(MODE_RE), (match) => match[1]);
    return permissionClassOf(modes);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

const ENVELOPE_TAG = "cross-session-message";

/** The content as Claude Code's peer envelope declaring `mode`. A closing tag inside the
 * words is defused the way Claude Code itself writes it (`<\`), so the envelope stays whole
 * and Claude Code reads the declared class from it. */
export function inboxEnvelope(content: string, mode: InboxPermissionClass): string {
  const body = content.replace(/<(?!\\)(?=[^A-Za-z0-9]{0,4}\/[^A-Za-z0-9]{0,4}c[^A-Za-z0-9]{0,2}r[^A-Za-z0-9]{0,2}o)/giu, "<\\");
  return `<${ENVELOPE_TAG} from-mode="${mode}">\n${body}\n</${ENVELOPE_TAG}>`;
}

/** A slash command would run in the session instead of being read as a message. */
export function isSlashCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

/** The path the key file name is derived from: a pipe name lower-cased as a whole (including `LOCAL\`), a socket as an absolute path. */
export function canonicalSocketPath(socketPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32" && socketPath.slice(0, PIPE_PREFIX.length).toLowerCase() === PIPE_PREFIX.toLowerCase()) {
    return PIPE_PREFIX + socketPath.slice(PIPE_PREFIX.length).toLowerCase();
  }
  return (platform === "win32" ? path.win32 : path.posix).resolve(socketPath);
}

export function keyFileName(pid: number, socketPath: string, platform: NodeJS.Platform = process.platform): string {
  const digest = createHash("sha256").update(canonicalSocketPath(socketPath, platform)).digest("hex");
  return `${pid}.${digest}.key`;
}

async function readToken(target: InboxTarget, platform: NodeJS.Platform): Promise<string> {
  const file = path.join(target.configDir, "sessions", keyFileName(target.pid, target.socketPath, platform));
  let handle;
  try {
    handle = await open(file, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > KEY_FILE_MAX) throw new Error("unusable key file");
    const buf = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buf, 0, info.size, 0);
    const parsed: unknown = JSON.parse(buf.toString("utf8", 0, bytesRead));
    const token = parsed && typeof parsed === "object" ? (parsed as { peerToken?: unknown }).peerToken : undefined;
    if (typeof token !== "string" || token === "" || token.length > TOKEN_MAX) throw new Error("no token");
    return token;
  } catch {
    // no detail on purpose: nothing about the key file goes into an error
    throw new InboxError("not_in_terminal", "无法连接电脑上的会话");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function connect(socketPath: string, ms: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new InboxError("stopped", "会话没有响应"));
    }, ms);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      socket.on("error", () => {});
      resolve(socket);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new InboxError("stopped", CLI_STOPPED));
    });
  });
}

const CLI_STOPPED = "会话已停止";

function writeAll(socket: net.Socket, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (error) => (error ? reject(error) : resolve()));
  });
}

/** What the transcript looked like before the send: the confirmation reads only what comes after. */
async function sizeOf(file: string | null | undefined): Promise<number | null> {
  if (!file) return null;
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

/** True once a line appended after `from` is the message's queue entry or carries its id or marker. */
async function confirmed(file: string, from: number, markers: readonly string[]): Promise<{ seen: boolean; next: number }> {
  let handle;
  try {
    handle = await open(file, "r");
    const size = (await handle.stat()).size;
    if (size <= from) return { seen: false, next: Math.min(from, size) };
    const length = Math.min(size - from, 4 * 1024 * 1024);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, from);
    const chunk = buf.toString("utf8", 0, bytesRead);
    const end = chunk.lastIndexOf("\n");
    const whole = end < 0 ? "" : chunk.slice(0, end);
    for (const line of whole.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!record || typeof record !== "object") continue;
      const rec = record as { type?: unknown; operation?: unknown };
      if (rec.type === "queue-operation" && rec.operation === "enqueue") return { seen: true, next: size };
      const flat = JSON.stringify(record);
      if (markers.some((marker) => flat.includes(marker))) return { seen: true, next: size };
    }
    return { seen: false, next: end < 0 ? from : from + Buffer.byteLength(chunk.slice(0, end + 1), "utf8") };
  } catch {
    return { seen: false, next: from };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Writes `text` to the session's inbox. Throws InboxError when it could not be written;
 * otherwise says whether the transcript showed it arrive (`unconfirmed` is no failure and is never retried). */
export async function sendToInbox(target: InboxTarget, text: string, options: InboxSendOptions = {}): Promise<InboxResult> {
  if (!options.stop && isSlashCommand(text)) throw new InboxError("invalid", "不能发送斜杠命令");
  const platform = options.platform ?? process.platform;
  const messageId = (options.uuid ?? randomUUID)();
  const words = options.stop ? INBOX_STOP : inboxMessageText(text);
  // only a bypass session needs the class declared; a prompting one would hold `bypass` and queues an undeclared message
  const mode = options.permissionClass !== undefined ? options.permissionClass : await transcriptPermissionClass(options.transcript);
  const line =
    JSON.stringify({
      type: "user",
      message: { role: "user", content: mode === "bypass" ? inboxEnvelope(words, "bypass") : words },
      msgV: 1,
      msg_id: messageId,
      priority: options.stop ? "now" : "next",
      session_id: target.sessionId,
    }) + "\n";
  if (Buffer.byteLength(line, "utf8") > FRAME_MAX) throw new InboxError("too_large", "内容太长");

  const token = await readToken(target, platform);
  const before = await sizeOf(options.transcript);
  const socket = await connect(target.socketPath, options.connectMs ?? CONNECT_MS);
  try {
    await writeAll(socket, JSON.stringify({ type: "auth", token }) + "\n");
    await writeAll(socket, line);
  } catch {
    socket.destroy();
    // part of the frame may have arrived
    throw new InboxError("unknown", "结果未知");
  }
  // The inbox sends nothing back; ending our side closes the connection after it has read both lines.
  socket.end();

  const waiting = options.state === "waiting";
  const file = options.transcript;
  if (!file || before === null) return { delivery: "unconfirmed", waiting };
  const markers = [messageId, options.stop ? "NexBot remote stop" : "[NexBot] "];
  const deadline = Date.now() + (options.confirmMs ?? CONFIRM_MS);
  let from = before;
  for (;;) {
    const result = await confirmed(file, from, markers);
    if (result.seen) return { delivery: "confirmed", waiting };
    from = result.next;
    const left = deadline - Date.now();
    if (left <= 0) return { delivery: "unconfirmed", waiting };
    await sleep(Math.min(options.pollMs ?? CONFIRM_POLL_MS, left));
  }
}

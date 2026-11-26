// The official CLI and its ACP server share the same on-device conversations.
// Discover metadata here, and open transcript content only for a read/watch/search.
import { lstat, open, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CLI_LIMITS, ITEM_TEXT_MAX, TOOL_OUTPUT_MAX, isCliModel, truncateUtf8, type CliItem } from "../../../shared/cli-agents.ts";
import { clipUnits, type LocalSession } from "./items.ts";
import { defaultRunner, type CommandRunner } from "./liveness.ts";

const RECENT = 120;
const TOOL_NAME_LIMIT = 120;
const SAFE_NATIVE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const NON_WRITERS = new Set(["models", "agents", "agent", "install", "update", "changelog", "help", "mcp", "mic-serve", "plugin", "plugins", "--help", "-h", "--version"]);

export type AgyRecord = Record<string, unknown>;
export const agyRecord = (value: unknown): AgyRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? value as AgyRecord : {};
export const agyString = (value: unknown): string => typeof value === "string" ? value : "";
export const agyArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const isAgyId = (value: unknown): value is string => typeof value === "string" && SAFE_NATIVE_ID.test(value);

export function agyConfigDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const configured = env.ANTIGRAVITY_CLI_CONFIG_DIR;
  return configured && path.isAbsolute(configured) ? configured : path.join(home, ".gemini", "antigravity-cli");
}

export function supportsAgyAcp(version: string | null): boolean {
  const [major, minor, patch] = version?.match(/\b(\d+)\.(\d+)\.(\d+)\b/)?.slice(1).map(Number) ?? [];
  return major > 1 || (major === 1 && (minor > 5 || (minor === 5 && patch >= 15)));
}

/** AGY uses Go's proxy environment, while a Windows GUI may only have WinINET set. */
export async function agyProxyEnvironment(
  platform: NodeJS.Platform, env: NodeJS.ProcessEnv, run: CommandRunner = defaultRunner,
): Promise<Record<string, string>> {
  if (platform !== "win32" || Object.entries(env).some(([key, value]) => /^(all|http|https)_proxy$/i.test(key) && value)) return {};
  const query = "$s=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue; if ($s.ProxyEnable -eq 1) { [Console]::Write($s.ProxyServer) }";
  const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query], { env, timeoutMs: 1500 });
  if (result.code !== 0) return {};
  const entries = result.stdout.trim().split(";");
  const common = entries.length === 1 && !entries[0].includes("=") ? entries[0] : undefined;
  const forProtocol = (protocol: string) => entries.find((entry) => entry.trim().toLowerCase().startsWith(protocol + "="))?.split("=", 2)[1] ?? common;
  const proxy: Record<string, string> = {};
  for (const protocol of ["http", "https"]) {
    // Bind this fallback to a local proxy already configured by the user.
    // Remote proxies still use explicit environment variables on the executor.
    const raw = forProtocol(protocol)?.trim();
    const match = /^(?:http:\/\/)?(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/i.exec(raw ?? "");
    if (match && Number(match[2]) >= 1 && Number(match[2]) <= 65535) proxy[protocol.toUpperCase() + "_PROXY"] = "http://" + match[1] + ":" + match[2];
  }
  return proxy;
}

export async function agyJson(file: string): Promise<AgyRecord> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) return {};
    return agyRecord(JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")));
  } catch {
    return {};
  }
}

export async function agyTranscript(dir: string, id: string): Promise<string> {
  if (!isAgyId(id)) return "";
  try {
    const root = await realpath(dir);
    for (const name of ["transcript_full.jsonl", "transcript.jsonl"]) {
      const requested = path.join(root, "brain", id, ".system_generated", "logs", name);
      const resolved = await realpath(requested).catch(() => "");
      if (resolved !== requested) continue;
      if ((await lstat(resolved).catch(() => null))?.isFile()) return resolved;
    }
  } catch {
    // A new ACP session can exist before its first transcript is exported.
  }
  return "";
}

function nativeRows(dir: string): AgyRecord[] {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path.join(dir, "conversation_summaries.db"), { readOnly: true });
    db.exec("PRAGMA query_only = 1; PRAGMA busy_timeout = 50");
    return db.prepare(`SELECT conversation_id, status, not_fully_idle, killed, title, workspace_uris, last_modified_time
      FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT ?`).all(RECENT);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function workspacePath(value: unknown, platform: NodeJS.Platform): string {
  if (typeof value !== "string") return "";
  try {
    const cwd = value.startsWith("file:") ? fileURLToPath(value, { windows: platform === "win32" }) : value;
    const fsPath = platform === "win32" ? path.win32 : path.posix;
    if (cwd.length <= CLI_LIMITS.cwd && fsPath.isAbsolute(cwd)) return cwd;
  } catch {
    // Non-local workspaces are outside this executor.
  }
  return "";
}

function workspaces(value: unknown): unknown[] {
  if (typeof value !== "string") return agyArray(value);
  try { return agyArray(JSON.parse(value)); } catch { return []; }
}

export interface AgyNativeSession {
  row: LocalSession;
  working: boolean;
}

export async function scanAgyHistory(dir: string, platform: NodeJS.Platform): Promise<AgyNativeSession[]> {
  const [cached, last] = await Promise.all([
    agyJson(path.join(dir, "cache", "conversation_metadata.json")),
    agyJson(path.join(dir, "cache", "last_conversations.json")),
  ]);
  const metadata = agyRecord(cached.conversations);
  const cwdById = new Map(Object.entries(last).filter((pair): pair is [string, string] => isAgyId(pair[1])).map(([cwd, id]) => [id, cwd]));
  const summaries = new Map(nativeRows(dir).filter((row) => isAgyId(row.conversation_id)).map((row) => [row.conversation_id as string, row]));
  const timestamp = (id: string) => {
    const summary = summaries.get(id);
    const cachedSummary = agyRecord(agyRecord(metadata[id]).summary);
    return Date.parse(agyString(summary?.last_modified_time ?? cachedSummary.UpdatedAt)) || 0;
  };
  const ids = [...new Set([...summaries.keys(), ...Object.keys(metadata).filter(isAgyId)])].sort((a, b) => timestamp(b) - timestamp(a)).slice(0, RECENT);
  const rows = await Promise.all(ids.map(async (id): Promise<AgyNativeSession | null> => {
    const cachedRow = agyRecord(metadata[id]);
    const summary = summaries.get(id);
    if (cachedRow.is_internal && !summary) return null;
    const fallback = agyRecord(cachedRow.summary);
    const cwd = [...workspaces(summary?.workspace_uris), ...agyArray(fallback.WorkspaceURIs), cwdById.get(id)]
      .map((value) => workspacePath(value, platform)).find(Boolean);
    if (!cwd) return null;
    const transcript = await agyTranscript(dir, id);
    if (!transcript && !summary) return null;
    return {
      working: !summary?.killed && (summary?.status === "CASCADE_RUN_STATUS_RUNNING" || Boolean(summary?.not_fully_idle)),
      row: {
        engine: "agy", nativeId: id, cwd, configDir: dir, transcript, state: "stopped",
        title: clipUnits(agyString(summary?.title ?? fallback.Title) || path.basename(cwd), CLI_LIMITS.title),
        lastActivityAt: timestamp(id) || (transcript ? Math.trunc((await lstat(transcript).catch(() => null))?.mtimeMs ?? 0) : 0),
      },
    };
  }));
  return rows.filter((row): row is AgyNativeSession => row !== null);
}

export interface AgyWriters { sessions: Set<string>; unknown: boolean }

/** A CLI without an explicit conversation flag may have opened any session via /resume. */
export async function agyWriters(platform: NodeJS.Platform, ownedPids: ReadonlySet<number>, run: CommandRunner = defaultRunner): Promise<AgyWriters> {
  const file = platform === "win32" ? "powershell.exe" : "ps";
  const script = "Get-CimInstance Win32_Process -Filter \"Name='agy.exe'\" -ErrorAction Stop | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId,$_.ParentProcessId,$_.CommandLine }";
  const args = platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", script] : ["-axo", "pid=,ppid=,command="];
  const result = await run(file, args, { timeoutMs: 3500 });
  const sessions = new Set<string>();
  let unknown = result.code !== 0;
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (!match || ownedPids.has(Number(match[1])) || ownedPids.has(Number(match[2]))) continue;
    const command = match[3];
    const argv = /^(?:"[^"]*(?:[/\\])?agy(?:\.exe)?"|(?:[^"]*[/\\])?agy(?:\.exe)?)(?:\s+(.*))?$/i.exec(command);
    if (!argv && platform !== "win32") continue;
    const tail = argv?.[1]?.trim() ?? "";
    if (NON_WRITERS.has(tail.split(/\s+/, 1)[0])) continue;
    const id = /(?:^|\s)(?:--conversation|--resume|-r)(?:\s+|=)["']?([\w-]+)/.exec(tail)?.[1];
    if (isAgyId(id)) sessions.add(id.toLowerCase());
    else unknown = true;
  }
  return { sessions, unknown };
}

/** Only AGY's whole input envelope is special. Literal markup inside a normal message stays intact. */
export function agyUserText(content: string): string {
  const trimmed = content.trim();
  const hasRequest = trimmed.startsWith("<USER_REQUEST>");
  const close = hasRequest ? trimmed.lastIndexOf("</USER_REQUEST>") : -1;
  if (hasRequest && close < 0) return content;
  let rest = hasRequest ? trimmed.slice(close + "</USER_REQUEST>".length).trimStart() : trimmed;
  while (rest) {
    const tag = /^<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/.exec(rest);
    if (!tag) return content;
    const endTag = `</${tag[1]}>`;
    const end = rest.indexOf(endTag, tag[0].length);
    if (end < 0) return content;
    rest = rest.slice(end + endTag.length).trimStart();
  }
  // AGY can put the tags on their own lines. Do not strip indentation inside the prompt.
  return hasRequest ? trimmed.slice("<USER_REQUEST>".length, close).replace(/^\r?\n|\r?\n$/g, "") : "";
}

/** Capture the export frontier BEFORE submitting to ACP. A timestamp is not
 * an identity: native timestamps may be rounded, and two prompts can be equal.
 * Read only the last physical line(s), not the whole conversation on each send. */
export async function agyLastStep(dir: string, id: string): Promise<number | undefined> {
  const file = await agyTranscript(dir, id);
  if (!file) return -1;
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    if (!size) return -1;
    let length = Math.min(8192, size);
    for (;;) {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, size - length);
      const lines = buffer.toString("utf8", 0, bytesRead).trimEnd().split("\n");
      if (length === size || lines.length > 1) {
        const step = agyRecord(JSON.parse(lines.at(-1)!)).step_index;
        return typeof step === "number" && Number.isSafeInteger(step) ? step : undefined;
      }
      if (length >= 1024 * 1024) return undefined;
      length = Math.min(length * 2, size);
    }
  } catch {
    return undefined; // concurrent export; use the send time as a conservative fallback
  } finally {
    await handle.close();
  }
}

/** Stable native step ids let pagination and external CLI changes use the same reader. */
export function agyRecordItems(value: unknown, fallbackTs = 0): CliItem[] {
  const row = agyRecord(value);
  if (typeof row.step_index !== "number" || !Number.isSafeInteger(row.step_index) || row.step_index < 0) return [];
  const id = `agy:${row.step_index}`;
  const ts = Date.parse(agyString(row.created_at)) || fallbackTs;
  const content = row.type === "USER_INPUT" ? agyUserText(agyString(row.content)) : agyString(row.content);
  const text = truncateUtf8(content, ITEM_TEXT_MAX);
  if (row.type === "USER_INPUT") return text ? [{ id, ts, kind: "user", text }] : [];
  if (row.type === "ERROR_MESSAGE") {
    const error = truncateUtf8(agyString(row.error) || content, 4096);
    return error ? [{ id, ts, kind: "notice", level: "error", text: error }] : [];
  }
  const items: CliItem[] = [];
  if (row.type === "PLANNER_RESPONSE") {
    const thinking = truncateUtf8(agyString(row.thinking), ITEM_TEXT_MAX);
    if (thinking) items.push({ id: `${id}:thought`, ts, kind: "thinking", text: thinking });
    if (text) items.push({ id, ts, kind: "assistant", text });
  }
  for (const [index, raw] of agyArray(row.tool_calls).slice(0, 32).entries()) {
    const call = agyRecord(raw);
    const name = clipUnits(agyString(call.name), TOOL_NAME_LIMIT);
    if (!name) continue;
    items.push({
      id: `${id}:tool:${index}`, ts, kind: "tool", name,
      input: truncateUtf8(JSON.stringify(call.args ?? {}), TOOL_OUTPUT_MAX),
      status: row.status === "ERROR" ? "error" : row.status === "RUNNING" ? "running" : "ok",
    });
  }
  return items;
}

export function agyModelId(value: unknown): string | undefined {
  return isCliModel(value) ? value : undefined;
}

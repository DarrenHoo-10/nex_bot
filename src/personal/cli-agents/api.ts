// HTTP side of Agent mode (plan 5.4). Not the shared `api()` wrapper: that one
// keeps only the error text, and this page needs Core's `code` to say what
// happened. Responses are validated with the shared parsers.
import {
  CLI_ERROR_TEXT,
  isCliErrorCode,
  parseCliDeviceView,
  parseCliItems,
  parseCliSessionView,
  type CliDeviceView,
  type CliEngine,
  type CliErrorCode,
  type CliItem,
  type CliSessionKey,
  type CliSessionView,
} from "../../../shared/cli-agents";

export class CliApiError extends Error {
  constructor(message: string, readonly code?: CliErrorCode, readonly status = 0) {
    super(message);
    this.name = "CliApiError";
  }
}

/** The one line the page shows for a failed call. */
export function cliErrorText(error: unknown, fallback = "操作失败"): string {
  if (error instanceof CliApiError) {
    if (error.code) return CLI_ERROR_TEXT[error.code];
    return error.message || fallback;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/cli-agents${path}`, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new CliApiError("连接失败");
  }
  let data: unknown = null;
  try { data = await response.json(); } catch { /* empty or not JSON */ }
  const record = (data && typeof data === "object" ? data : {}) as { error?: unknown; code?: unknown };
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("nex-session-expired"));
    const code = isCliErrorCode(record.code) ? record.code : undefined;
    throw new CliApiError(typeof record.error === "string" ? record.error : "连接失败", code, response.status);
  }
  return data as T;
}

export interface CliSnapshot { devices: CliDeviceView[]; sessions: CliSessionView[] }

export async function fetchSnapshot(): Promise<CliSnapshot> {
  const data = await call<{ devices?: unknown[]; sessions?: unknown[] }>("");
  // one malformed row should not blank the page
  const devices = (data.devices ?? []).map(parseCliDeviceView).filter((row): row is CliDeviceView => row !== null);
  const sessions = (data.sessions ?? []).map(parseCliSessionView).filter((row): row is CliSessionView => row !== null);
  return { devices, sessions };
}

export async function fetchItems(key: CliSessionKey, before?: string): Promise<{ items: CliItem[]; more: boolean }> {
  const query = `?key=${encodeURIComponent(key)}${before ? `&before=${encodeURIComponent(before)}` : ""}`;
  const data = await call<{ items?: unknown; more?: unknown }>(`/items${query}`);
  const items = parseCliItems(data.items);
  if (!items) throw new CliApiError("记录格式不对");
  return { items, more: data.more === true };
}

export const startSession = (deviceId: string, engine: CliEngine, cwd: string) =>
  call<{ key: CliSessionKey }>("/start", { deviceId, engine, cwd });
export const continueSession = (key: CliSessionKey) => call<{ key: CliSessionKey }>("/continue", { key });
export const sendMessage = (key: CliSessionKey, text: string) => call<{ turn: number }>("/send", { key, text });
export const interruptSession = (key: CliSessionKey) => call<{ outcome: string }>("/interrupt", { key });
export const openLocal = (key: CliSessionKey) => call<{ ok: boolean }>("/open-local", { key });
export const hideSession = (key: CliSessionKey, hidden: boolean) => call<{ ok: boolean }>("/hide", { key, hidden });

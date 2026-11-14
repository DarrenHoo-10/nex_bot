// State machine for one terminal stream in the browser. Pure: the view owns the
// sockets, ids and xterm; it feeds events in and acts on `needsOpen`.
//
//   idle ──start──▶ (needsOpen) ──requested──▶ (req pending) ──opened──▶ observing | controlling
//   observing | controlling ──disconnected | overflow──▶ reconnecting (needsOpen) ──▶ opened
//   observing | controlling ──closed(exited, device_offline, ...)──▶ closed
import { CREDIT_CHUNK, type CliErrorCode } from "../../../shared/cli-agents";

export type TermMode = "observe" | "control";
export type TermPhase = "idle" | "observing" | "controlling" | "reconnecting" | "closed";

export interface TermState {
  phase: TermPhase;
  /** the mode the user wants; follows the server when it answers differently */
  want: TermMode;
  /** the view should send term.open as soon as the socket is up */
  needsOpen: boolean;
  /** id of the term.open waiting for its term.opened */
  req: string | null;
  sid: number | null;
  mode: TermMode | null;
  cols: number;
  rows: number;
  reason: string | null;
  error: CliErrorCode | null;
}

export type TermEvent =
  | { type: "start"; want?: TermMode }
  | { type: "requested"; req: string }
  | { type: "opened"; req: string; sid: number; cols: number; rows: number; observe: boolean }
  | { type: "size"; sid: number; cols: number; rows: number }
  | { type: "closed"; sid: number; reason: string }
  | { type: "error"; code: CliErrorCode; req?: string }
  | { type: "disconnected" }
  | { type: "mode"; want: TermMode }
  | { type: "stop" };

export function initialTermState(want: TermMode = "observe"): TermState {
  return { phase: "idle", want, needsOpen: false, req: null, sid: null, mode: null, cols: 0, rows: 0, reason: null, error: null };
}

/** Reasons after which Core wants the browser to open the stream again. */
const REOPEN_REASONS = new Set(["overflow"]);

export function termReducer(state: TermState, event: TermEvent): TermState {
  switch (event.type) {
    case "start":
      return { ...initialTermState(event.want ?? state.want), needsOpen: true };
    case "stop":
      return initialTermState(state.want);
    case "requested":
      return { ...state, needsOpen: false, req: event.req, error: null };
    case "opened": {
      if (event.req !== state.req) return state;
      const mode: TermMode = event.observe ? "observe" : "control";
      return { ...state, phase: mode === "observe" ? "observing" : "controlling", want: mode, needsOpen: false, req: null, sid: event.sid, mode, cols: event.cols, rows: event.rows, reason: null, error: null };
    }
    case "size":
      return event.sid === state.sid ? { ...state, cols: event.cols, rows: event.rows } : state;
    case "closed": {
      if (event.sid !== state.sid) return state;
      if (REOPEN_REASONS.has(event.reason)) return { ...state, phase: "reconnecting", needsOpen: true, req: null, sid: null, mode: null, reason: null };
      return { ...state, phase: "closed", needsOpen: false, req: null, sid: null, mode: null, reason: event.reason };
    }
    case "error": {
      if (event.req !== undefined) {
        if (event.req !== state.req) return state;
        return { ...state, phase: "closed", needsOpen: false, req: null, error: event.code };
      }
      return { ...state, error: event.code };
    }
    case "disconnected": {
      // only a stream that was live or being opened has anything to recover
      const live = state.sid !== null || state.req !== null;
      if (!live && state.phase !== "reconnecting") return state;
      return { ...state, phase: "reconnecting", needsOpen: true, req: null, sid: null, mode: null };
    }
    case "mode": {
      if (event.want === state.want && state.sid !== null) return state;
      return { ...state, phase: "idle", want: event.want, needsOpen: true, req: null, sid: null, mode: null, error: null };
    }
  }
}

/** Whether a term.opened belongs to the request the view is waiting for. */
export function acceptsOpened(state: TermState, req: string): boolean {
  return state.req !== null && state.req === req;
}

export type TermStatus = "connecting" | "reconnecting" | "observing" | "controlling" | "closed";

export function termStatus(state: TermState, connected: boolean): TermStatus {
  if (state.phase === "closed") return "closed";
  if (state.phase === "reconnecting" || (!connected && state.phase !== "idle")) return "reconnecting";
  if (state.phase === "observing") return "observing";
  if (state.phase === "controlling") return "controlling";
  return connected ? "connecting" : "reconnecting";
}

export const TERM_STATUS_TEXT: Record<TermStatus, string> = {
  connecting: "正在连接",
  reconnecting: "正在重新连接",
  observing: "只看",
  controlling: "操作中",
  closed: "已结束",
};

const CLOSE_REASON_TEXT: Record<string, string> = {
  exited: "程序已退出",
  device_offline: "电脑离线",
  paused: "本机控制已暂停",
  disabled: "Agent 会话已关闭",
  closed: "已关闭",
};

export function closeReasonText(reason: string | null): string {
  return reason ? CLOSE_REASON_TEXT[reason] ?? "终端已断开" : "";
}

/** Counts bytes xterm has finished writing and hands them back to Core in
 * `chunk` sized credits, so the device only sends as fast as this tab draws. */
export function createCreditMeter(send: (bytes: number) => void, chunk: number = CREDIT_CHUNK) {
  let pending = 0;
  return {
    wrote(bytes: number): void {
      pending += bytes;
      if (pending >= chunk) {
        const grant = pending;
        pending = 0;
        send(grant);
      }
    },
    get pending() { return pending; },
  };
}

/** Scale that makes a terminal of `natural` px fit a container, never above 1. */
export function fitScale(container: number, natural: number): number {
  if (!(container > 0) || !(natural > 0)) return 1;
  return Math.min(1, container / natural);
}

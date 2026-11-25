// The right-hand terminal tab attaches a controller and fits the PTY to its pane.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { CLI_ERROR_TEXT, TERM_DEFAULT, TERM_HISTORY, clampTermSize, type CliSessionKey } from "../../../shared/cli-agents";
import type { CliStream } from "./stream";
import { closeReasonText, createCreditMeter, initialTermState, TERM_STATUS_TEXT, termReducer, termStatus, type TermMode } from "./terminal-session";

const RESIZE_DEBOUNCE_MS = 100;

const TERM_THEME = { background: "#12161a", foreground: "#d7dde3", cursor: "#d7dde3", selectionBackground: "#3d5a73" };

async function loadXterm() {
  const [xterm, fit, unicode] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-unicode11"),
    import("@xterm/xterm/css/xterm.css"),
  ]);
  return { Terminal: xterm.Terminal, FitAddon: fit.FitAddon, Unicode11Addon: unicode.Unicode11Addon };
}

let requestCounter = 0;
const newRequestId = () => `${Math.random().toString(36).slice(2, 8)}-${(++requestCounter).toString(36)}`;

export interface TerminalViewProps {
  stream: CliStream;
  sessionKey: CliSessionKey;
  /** the stream's socket is open */
  connected: boolean;
}

export function TerminalView({ stream, sessionKey, connected }: TerminalViewProps) {
  const [state, dispatch] = useReducer(termReducer, "control" as TermMode, initialTermState);
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sidRef = useRef<number | null>(null);
  const reqRef = useRef<string | null>(null);
  const modeRef = useRef<TermMode | null>(null);
  const meterRef = useRef<ReturnType<typeof createCreditMeter> | null>(null);
  const streamRef = useRef(stream);
  streamRef.current = stream;

  /** Let go of the stream (or the request still waiting for its answer). */
  const release = useCallback(() => {
    const sid = sidRef.current;
    const req = reqRef.current;
    if (sid !== null) streamRef.current.closeTerm(sid);
    else if (req) streamRef.current.abandonReq(req);
    sidRef.current = null;
    reqRef.current = null;
    modeRef.current = null;
    meterRef.current = null;
  }, []);

  // xterm itself, created once the chunk has loaded
  useEffect(() => {
    let disposed = false;
    let term: Terminal | null = null;
    loadXterm().then(({ Terminal: Xterm, FitAddon: Fit, Unicode11Addon: Unicode }) => {
      const target = scaleRef.current;
      if (disposed || !target) return;
      term = new Xterm({
        allowProposedApi: true,
        cursorBlink: true,
        disableStdin: true,
        fontFamily: "ui-monospace, SFMono-Regular, Consolas, 'Cascadia Mono', 'Microsoft YaHei', monospace",
        fontSize: 15,
        lineHeight: 1.15,
        scrollback: TERM_HISTORY,
        theme: TERM_THEME,
      });
      const fit = new Fit();
      term.loadAddon(fit);
      term.loadAddon(new Unicode());
      term.unicode.activeVersion = "11";
      term.open(target);
      const encoder = new TextEncoder();
      term.onData((data) => {
        const sid = sidRef.current;
        if (sid !== null && modeRef.current === "control") streamRef.current.sendInput(sid, encoder.encode(data));
      });
      term.onBinary((data) => {
        const sid = sidRef.current;
        if (sid !== null && modeRef.current === "control") streamRef.current.sendInput(sid, Uint8Array.from(data, (char) => char.charCodeAt(0) & 0xff));
      });
      termRef.current = term;
      fitRef.current = fit;
      setReady(true);
    }).catch(() => {
      if (!disposed) setLoadFailed(true);
    });
    return () => {
      disposed = true;
      termRef.current = null;
      fitRef.current = null;
      setReady(false);
      term?.dispose();
    };
  }, []);

  // one terminal stream per session: reset on a new session, close on leaving
  useEffect(() => {
    dispatch({ type: "start", want: "control" });
    return release;
  }, [sessionKey, stream, release]);

  // what Core says about the stream
  useEffect(() => stream.on((event) => {
    if (event.type === "status") {
      if (event.status !== "open") {
        sidRef.current = null;
        reqRef.current = null;
        modeRef.current = null;
        meterRef.current = null;
        dispatch({ type: "disconnected" });
      }
      return;
    }
    if (event.type === "output") {
      if (event.sid !== sidRef.current) return;
      const meter = meterRef.current;
      const bytes = event.data.length;
      termRef.current?.write(event.data, () => meter?.wrote(bytes));
      return;
    }
    const message = event.message;
    switch (message.type) {
      case "term.opened": {
        if (message.req !== reqRef.current) return;
        const term = termRef.current;
        const sid = message.sid;
        reqRef.current = null;
        sidRef.current = sid;
        modeRef.current = message.observe ? "observe" : "control";
        meterRef.current = createCreditMeter((bytes) => { stream.credit(sid, bytes); });
        if (term) {
          term.options.disableStdin = message.observe;
          term.reset();
          term.resize(message.cols, message.rows);
        }
        dispatch({ type: "opened", req: message.req, sid, cols: message.cols, rows: message.rows, observe: message.observe });
        return;
      }
      case "term.size":
        if (message.sid !== sidRef.current) return;
        // the controller's own size comes back too: only follow when it differs
        if (termRef.current && (termRef.current.cols !== message.cols || termRef.current.rows !== message.rows)) termRef.current.resize(message.cols, message.rows);
        dispatch({ type: "size", sid: message.sid, cols: message.cols, rows: message.rows });
        return;
      case "term.closed":
        if (message.sid !== sidRef.current) return;
        sidRef.current = null;
        modeRef.current = null;
        meterRef.current = null;
        dispatch({ type: "closed", sid: message.sid, reason: message.reason });
        return;
      case "error":
        if (message.req === undefined || message.req !== reqRef.current) return;
        reqRef.current = null;
        dispatch({ type: "error", code: message.code, req: message.req });
        return;
    }
  }), [stream]);

  // open the stream whenever the state machine asks and the link is up
  useEffect(() => {
    if (!state.needsOpen || !connected || !ready) return;
    let proposed: { cols: number; rows: number } | undefined;
    try { proposed = fitRef.current?.proposeDimensions(); } catch { proposed = undefined; }
    const size = clampTermSize(proposed?.cols || TERM_DEFAULT.cols, proposed?.rows || TERM_DEFAULT.rows);
    const req = newRequestId();
    if (!stream.openTerm(req, sessionKey, size.cols, size.rows, false)) return;
    reqRef.current = req;
    dispatch({ type: "requested", req });
  }, [state.needsOpen, connected, ready, stream, sessionKey]);

  useEffect(() => {
    if (state.mode === "control") termRef.current?.focus();
  }, [state.mode]);

  // keep the pane and the PTY the same size while controlling
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !ready || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (modeRef.current !== "control") return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const term = termRef.current;
        const sid = sidRef.current;
        if (!term || sid === null || host.clientWidth === 0 || host.clientHeight === 0) return;
        const before = { cols: term.cols, rows: term.rows };
        try { fitRef.current?.fit(); } catch { return; }
        if (term.cols === before.cols && term.rows === before.rows) return;
        const size = clampTermSize(term.cols, term.rows);
        streamRef.current.resizeTerm(sid, size.cols, size.rows);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(host);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [ready, state.mode]);

  const status = termStatus(state, connected);
  const closedText = state.error ? CLI_ERROR_TEXT[state.error] : closeReasonText(state.reason);
  return (
    <div className="cli-term" data-status={status}>
      <div className="cli-term-host" ref={hostRef} data-mode={state.mode ?? "none"}>
        <div className="cli-term-scale" ref={scaleRef} />
        {loadFailed ? <div className="cli-term-overlay" role="alert">终端组件加载失败</div> : null}
        {!loadFailed && status === "reconnecting" ? <div className="cli-term-overlay" role="status">正在重新连接</div> : null}
        {status === "closed" || status === "observing" ? (
          <div className="cli-term-overlay" role="status">
            <span>{status === "observing" ? "暂未取得终端控制权" : closedText || TERM_STATUS_TEXT.closed}</span>
            <button type="button" onClick={() => { release(); dispatch({ type: "start", want: "control" }); }}>重新连接</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

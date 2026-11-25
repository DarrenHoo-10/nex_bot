// Browser side of the Agent mode WebSocket (/api/cli-agents/stream): list and
// session subscriptions that survive reconnects, terminal streams, binary
// frames and a keep-alive. Core pings at the protocol level too; this ping is
// for the proxies in front of it and for noticing a dead link.
import { parseServerMessage, WS_PING_MS, WS_PONG_TIMEOUT_MS, FRAME_PAYLOAD_MAX, type ClientMessage, type CliSessionKey, type ServerMessage } from "../../../shared/cli-agents";
import { decodeTermFrame, encodeTermFrame, splitPayload, TERM_INPUT, TERM_OUTPUT } from "../../../shared/cli-agent-frames";

export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
/** Core closes with this code when the login ended; reconnecting cannot help. */
export const CLOSE_UNAUTHORIZED = 4401;

export type StreamStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export type StreamEvent =
  | { type: "status"; status: StreamStatus; code?: number }
  | { type: "message"; message: Exclude<ServerMessage, { type: "pong" }> }
  | { type: "output"; sid: number; data: Uint8Array };

/** The slice of WebSocket this client uses, so a test can pass a fake. */
export interface SocketLike {
  binaryType: string;
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** A page cannot open this WebSocket inside the Android WebView, so the app injects
 * `openCliSocket` (see android-bridge.ts); it returns a SocketLike backed by a native
 * socket that carries the bearer. Everything else, reconnects included, stays here. */
export function createDefaultSocket(url: string): SocketLike {
  const host = typeof window === "undefined" ? undefined : (window as unknown as { nex?: { platform?: string; openCliSocket?: () => SocketLike } }).nex;
  if (host?.platform === "android" && host.openCliSocket) return host.openCliSocket();
  return new WebSocket(url) as unknown as SocketLike;
}

export interface CliStreamOptions {
  url?: string;
  createSocket?: (url: string) => SocketLike;
  random?: () => number;
  now?: () => number;
}

const OPEN = 1;

export function defaultStreamUrl(): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/cli-agents/stream`;
}

/** Delay before reconnect attempt number `attempt` (0 based): 1 s doubling to
 * 30 s, plus up to 25% jitter, never below 1 s or above 30 s. */
export function reconnectDelay(attempt: number, random: number): number {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.max(0, attempt));
  return Math.min(RECONNECT_MAX_MS, Math.max(RECONNECT_MIN_MS, Math.round(base * (1 + 0.25 * random))));
}

export class CliStream {
  private socket: SocketLike | null = null;
  private listeners = new Set<(event: StreamEvent) => void>();
  private sessions = new Map<CliSessionKey, number>();
  private wantList = 0;
  /** term.open requests the page gave up on before Core answered */
  private abandoned = new Set<string>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private lastRx = 0;
  private running = false;
  private current: StreamStatus = "idle";
  private readonly encoder = new TextEncoder();
  private readonly options: Required<CliStreamOptions>;

  constructor(options: CliStreamOptions = {}) {
    this.options = {
      url: options.url ?? "",
      createSocket: options.createSocket ?? createDefaultSocket,
      random: options.random ?? Math.random,
      now: options.now ?? Date.now,
    };
  }

  get status(): StreamStatus {
    return this.current;
  }

  get isOpen(): boolean {
    return this.current === "open";
  }

  on(listener: (event: StreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.connect("connecting");
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearPing();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try { socket.close(1000); } catch { /* already closed */ }
    }
    this.setStatus("closed");
  }

  /** Skip the backoff, e.g. when the browser says the network is back. */
  reconnectNow(): void {
    if (!this.running || this.socket) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connect("reconnecting");
  }

  /** Receive session list updates. Counted, so two users of it do not clash. */
  subscribeList(): () => void {
    if (this.wantList++ === 0) this.send({ type: "sub.list" });
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.wantList = Math.max(0, this.wantList - 1);
    };
  }

  /** Receive a session's items. The returned function releases this caller. */
  private sessionKnown = new Map<CliSessionKey, string[]>();

  updateSessionKnown(key: CliSessionKey, known: string[]) {
    if (this.sessions.has(key)) this.sessionKnown.set(key, known);
  }

  subscribeSession(key: CliSessionKey, known?: string[]): () => void {
    const count = this.sessions.get(key) ?? 0;
    this.sessions.set(key, count + 1);
    if (count === 0) {
      if (known) this.sessionKnown.set(key, known);
      this.send({ type: "sub.session", key, known });
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.sessions.get(key) ?? 1) - 1;
      if (left > 0) { this.sessions.set(key, left); return; }
      this.sessions.delete(key);
      this.sessionKnown.delete(key);
      this.send({ type: "unsub.session", key });
    };
  }

  openTerm(req: string, key: CliSessionKey, cols: number, rows: number, observe: boolean): boolean {
    return this.send({ type: "term.open", req, key, cols, rows, observe });
  }

  resizeTerm(sid: number, cols: number, rows: number): boolean {
    return this.send({ type: "term.resize", sid, cols, rows });
  }

  /** Tell Core `bytes` of output were drawn, so the device may send more. */
  credit(sid: number, bytes: number): boolean {
    if (!(bytes > 0)) return false;
    return this.send({ type: "term.credit", sid, bytes: Math.floor(bytes) });
  }

  closeTerm(sid: number): boolean {
    return this.send({ type: "term.close", sid });
  }

  /** A term.open nobody waits for any more: close its stream when Core opens it. */
  abandonReq(req: string): void {
    this.abandoned.add(req);
  }

  /** Keyboard input as binary frames (UTF-8, at most 64 KiB per frame). */
  sendInput(sid: number, input: string | Uint8Array): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return false;
    const bytes = typeof input === "string" ? this.encoder.encode(input) : input;
    for (const chunk of splitPayload(bytes, FRAME_PAYLOAD_MAX)) socket.send(encodeTermFrame(TERM_INPUT, sid, chunk));
    return true;
  }

  private send(message: ClientMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  private emit(event: StreamEvent): void {
    for (const listener of Array.from(this.listeners)) listener(event);
  }

  private setStatus(status: StreamStatus, code?: number): void {
    if (this.current === status && code === undefined) return;
    this.current = status;
    this.emit(code === undefined ? { type: "status", status } : { type: "status", status, code });
  }

  private connect(status: StreamStatus): void {
    this.setStatus(status);
    let socket: SocketLike;
    try {
      socket = this.options.createSocket(this.options.url || defaultStreamUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = "arraybuffer";
    // a new socket has no pending requests from the old one
    this.abandoned.clear();
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.lastRx = this.options.now();
      this.setStatus("open");
      this.startPing();
      // what the page wants survives a drop: ask for all of it again
      if (this.wantList > 0) this.send({ type: "sub.list" });
      for (const key of this.sessions.keys()) this.send({ type: "sub.session", key, known: this.sessionKnown.get(key) });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.lastRx = this.options.now();
      // a message proves the link works, so the next drop starts from 1 s again
      this.attempt = 0;
      this.receive(event.data);
    };
    socket.onerror = () => { /* onclose follows and drives the reconnect */ };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearPing();
      if (!this.running) return;
      if (event.code === CLOSE_UNAUTHORIZED) {
        this.running = false;
        this.setStatus("closed", CLOSE_UNAUTHORIZED);
        return;
      }
      this.scheduleReconnect();
    };
  }

  private receive(data: unknown): void {
    if (typeof data === "string") {
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { return; }
      const message = parseServerMessage(parsed);
      if (!message || message.type === "pong") return;
      if (message.type === "term.opened" && this.abandoned.delete(message.req)) {
        this.closeTerm(message.sid);
        return;
      }
      this.emit({ type: "message", message });
      return;
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (!bytes) return;
    const frame = decodeTermFrame(bytes);
    if (frame?.type === TERM_OUTPUT) this.emit({ type: "output", sid: frame.sid, data: frame.payload });
  }

  private scheduleReconnect(): void {
    this.setStatus("reconnecting");
    clearTimeout(this.reconnectTimer);
    const delay = reconnectDelay(this.attempt++, this.options.random());
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.running) this.connect("reconnecting");
    }, delay);
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket) return;
      if (this.options.now() - this.lastRx > WS_PONG_TIMEOUT_MS) {
        // nothing came back for too long: drop it and let onclose reconnect
        try { socket.close(); } catch { /* ignore */ }
        // a socket that never reports its own close would hang here, so handle it
        const dead = socket.onclose;
        if (this.socket === socket && dead) dead({ code: 1006 });
        return;
      }
      this.send({ type: "ping" });
    }, WS_PING_MS);
  }

  private clearPing(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }
}

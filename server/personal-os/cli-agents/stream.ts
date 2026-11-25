import { createHash } from "node:crypto";
/* oxlint-disable unicorn/no-useless-spread -- the copies are deliberate: listeners and entries remove themselves while a loop runs over the collection */
// Browser WebSocket for Agent mode (`/api/cli-agents/stream`): the live session
// list, transcript items of the sessions a browser has open, and terminal bytes.
// A remote terminal is a remote shell, so this socket is owner-only, checks
// Host and Origin like the HTTP routes do, authenticates with the same session
// the page already has (the `nex` cookie) and re-checks it while it lives.
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  WS_PING_MS,
  WS_PONG_TIMEOUT_MS,
  parseClientMessage,
  type CliErrorCode,
  type CliItem,
  type CliSessionKey,
  type ServerMessage,
} from "../../../shared/cli-agents.ts";
import { TERM_INPUT, decodeTermFrame } from "../../../shared/cli-agent-frames.ts";
import { CliOpError, errorCodeOf, type CliAgentHub, type StreamSink } from "./hub.ts";

export type StreamAuth = { ok: true; sessionId: string } | { ok: false; status: 401 | 403 | 503 };

export interface StreamOptions {
  hostAllowed(host: string | undefined): boolean;
  /** The Origin a browser page served for this Host has. */
  originFor(host: string): string;
  /** Resolves a session token: the owner's session, or the HTTP status to refuse with. */
  authorize(token: string): Promise<StreamAuth>;
  pingMs?: number;
  pongTimeoutMs?: number;
  /** How often live sockets are re-authorized. */
  reauthMs?: number;
}

const MAX_SOCKETS_PER_SESSION = 8;
const MAX_SUBSCRIPTIONS = 50;
/** One JSON message stays well under the 1 MiB that proxies and browsers handle comfortably. */
const MESSAGE_BYTES = 900_000;
const SOCKET_BUFFER_MAX = 16 * 1024 * 1024;
const HTTP_TEXT: Record<number, string> = { 401: "Unauthorized", 403: "Forbidden", 429: "Too Many Requests", 503: "Service Unavailable" };

interface Subscription {
  ready: boolean;
  queue: ServerMessage[];
  off: () => void;
}

interface Connection {
  ws: WebSocket;
  sessionId: string;
  token: string;
  lastSeen: number;
  subscriptions: Map<string, Subscription>;
  offList: (() => void) | null;
  offSummary: (() => void) | null;
  offRequests: (() => void) | null;
  sink: StreamSink;
}

/** Cuts a list into groups whose JSON stays under `MESSAGE_BYTES`; one oversized element still forms its own group. */
function groups<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  let current: T[] = [], size = 0;
  for (const value of values) {
    const bytes = JSON.stringify(value).length + 1;
    if (current.length && size + bytes > MESSAGE_BYTES) { out.push(current); current = []; size = 0; }
    current.push(value);
    size += bytes;
  }
  if (current.length || !out.length) out.push(current);
  return out;
}

export class CliAgentStream {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private readonly connections = new Set<Connection>();
  private readonly timer: NodeJS.Timeout;
  private readonly pongTimeoutMs: number;
  private readonly reauthMs: number;
  private lastReauth = Date.now();
  private reauthing = false;
  private closed = false;

  constructor(
    private readonly hub: CliAgentHub,
    private readonly options: StreamOptions,
  ) {
    const pingMs = options.pingMs ?? WS_PING_MS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? WS_PONG_TIMEOUT_MS;
    this.reauthMs = options.reauthMs ?? 15_000;
    this.timer = setInterval(() => this.tick(), pingMs);
    this.timer.unref();
  }

  /** Number of live sockets, for tests and diagnostics. */
  get size() {
    return this.connections.size;
  }

  readonly handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    void this.upgrade(request, socket, head).catch(() => this.refuse(socket, 503));
  };

  private refuse(socket: Duplex, status: number) {
    if (socket.destroyed) return;
    socket.end(`HTTP/1.1 ${status} ${HTTP_TEXT[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const host = request.headers.host;
    if (this.closed || !host || !this.options.hostAllowed(host)) return this.refuse(socket, 403);
    const header = request.headers.authorization;
    const bearer = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("nex="))?.slice(4) ?? "";
    // A browser cannot set Authorization on a WebSocket, so a cookie login must come with this Core's own Origin.
    const origin = request.headers.origin;
    if (origin !== undefined ? origin !== this.options.originFor(host) : !bearer) return this.refuse(socket, 403);
    const token = bearer || cookie;
    if (!token || token.length > 200) return this.refuse(socket, 401);
    const auth = await this.options.authorize(token);
    if (!auth.ok) return this.refuse(socket, auth.status);
    let sameSession = 0;
    for (const connection of this.connections) if (connection.sessionId === auth.sessionId) sameSession++;
    if (sameSession >= MAX_SOCKETS_PER_SESSION) return this.refuse(socket, 429);
    if (this.closed || socket.destroyed) return;
    this.wss.handleUpgrade(request, socket, head, (ws) => this.attach(ws, auth.sessionId, token));
  }

  private attach(ws: WebSocket, sessionId: string, token: string) {
    const connection: Connection = {
      ws, sessionId, token, lastSeen: Date.now(), subscriptions: new Map(), offList: null, offSummary: null, offRequests: null,
      sink: undefined as unknown as StreamSink,
    };
    connection.sink = this.sinkFor(connection);
    this.connections.add(connection);
    ws.on("error", () => ws.terminate());
    ws.on("pong", () => { connection.lastSeen = Date.now(); });
    ws.on("message", (raw, isBinary) => { connection.lastSeen = Date.now(); this.onMessage(connection, raw, isBinary); });
    ws.on("close", () => this.detach(connection));
  }

  private detach(connection: Connection) {
    if (!this.connections.delete(connection)) return;
    for (const subscription of connection.subscriptions.values()) subscription.off();
    connection.subscriptions.clear();
    connection.offList?.();
    connection.offSummary?.();
    connection.offRequests?.();
    this.hub.closeSink(connection.sink);
  }

  private send(connection: Connection, message: ServerMessage) {
    const { ws } = connection;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > SOCKET_BUFFER_MAX) { ws.terminate(); return; }
    ws.send(JSON.stringify(message));
  }

  private sendError(connection: Connection, code: CliErrorCode, req?: string, message?: string) {
    this.send(connection, { type: "error", code, ...(req ? { req } : {}), ...(message ? { message } : {}) });
  }

  private sinkFor(connection: Connection): StreamSink {
    return {
      sessionId: connection.sessionId,
      opened: (req, sid, cols, rows, observe) => this.send(connection, { type: "term.opened", req, sid, cols, rows, observe }),
      size: (sid, cols, rows) => this.send(connection, { type: "term.size", sid, cols, rows }),
      closed: (sid, reason) => this.send(connection, { type: "term.closed", sid, reason }),
      error: (code, req, message) => this.sendError(connection, code, req, message),
      data: (frame, done) => {
        const { ws } = connection;
        if (ws.readyState !== WebSocket.OPEN) { done(); return; }
        ws.send(frame, { binary: true }, () => done());
      },
    };
  }

  private onMessage(connection: Connection, raw: RawData, isBinary: boolean) {
    if (!this.connections.has(connection) || connection.ws.readyState !== WebSocket.OPEN) return;
    if (isBinary) {
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
      const frame = decodeTermFrame(new Uint8Array(bytes));
      if (frame?.type === TERM_INPUT) this.hub.streamInput(connection.sink, frame.sid, frame.payload);
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString()); } catch { parsed = null; }
    const message = parseClientMessage(parsed);
    if (!message) { this.sendError(connection, "invalid"); return; }
    switch (message.type) {
      case "ping": this.send(connection, { type: "pong" }); break;
      case "sub.list": this.subscribeList(connection); break;
      case "sub.session": void this.subscribeSession(connection, message.key, message.known); break;
      case "unsub.session": {
        connection.subscriptions.get(message.key)?.off();
        connection.subscriptions.delete(message.key);
        // the list subscription takes over this session's request updates
        if (connection.offRequests) this.send(connection, { type: "requests", key: message.key, requests: this.hub.requests(message.key) });
        break;
      }
      case "term.open": this.hub.openStream(connection.sink, message.key, message.req, message.cols, message.rows, message.observe); break;
      case "term.resize": this.hub.streamResize(connection.sink, message.sid, message.cols, message.rows); break;
      case "term.credit": this.hub.streamCredit(connection.sink, message.sid, message.bytes); break;
      case "term.close": this.hub.streamClose(connection.sink, message.sid); break;
    }
  }

  private subscribeList(connection: Connection) {
    connection.offList?.();
    connection.offSummary?.();
    connection.offRequests?.();
    connection.offList = this.hub.onList((delta) => this.send(connection, { type: "list.delta", ...delta }));
    connection.offSummary = this.hub.onSummary((summary) => this.send(connection, { type: "summary", ...summary }));
    const { devices, sessions } = this.hub.list();
    const [first = [], ...rest] = groups(sessions);
    this.send(connection, { type: "list", devices, sessions: first });
    // The rest of a very long list follows as upserts: the browser merges them the same way.
    for (const more of rest) this.send(connection, { type: "list.delta", upserts: more, removes: [] });
    this.send(connection, { type: "summary", ...this.hub.summary() });
    // Pending permission and question cards, one message per session that has any.
    connection.offRequests = this.hub.onRequests((message) => {
      if (message.type !== "requests" && message.type !== "request.resolved") return;
      // a session this socket has open already gets them from its own subscription
      if (connection.subscriptions.has(message.key)) return;
      this.send(connection, message);
    });
    for (const [key, requests] of this.hub.requestsByKey()) this.send(connection, { type: "requests", key, requests });
  }

  private sendItems(connection: Connection, key: string, items: CliItem[], more: boolean) {
    let first = true;
    const parts = groups(items);
    parts.forEach((part, index) => {
      const last = index === parts.length - 1;
      this.send(connection, {
        type: "items", key: key as CliSessionKey, items: part,
        ...(first ? { reset: true } : {}), ...(more ? { more: true } : {}), ...(!last ? { continues: true } : {}),
      });
      first = false;
    });
  }

  private async subscribeSession(connection: Connection, key: string, known?: string[]) {
    connection.subscriptions.get(key)?.off();
    connection.subscriptions.delete(key);
    if (connection.subscriptions.size >= MAX_SUBSCRIPTIONS) { this.sendError(connection, "busy", undefined, key); return; }
    const subscription: Subscription = { ready: false, queue: [], off: () => undefined };
    try {
      // Live items that arrive while the first page is being fetched wait behind it, so they never overwrite it.
      subscription.off = this.hub.subscribe(key, (message) => {
        if (subscription.ready) this.send(connection, message); else subscription.queue.push(message);
      });
    } catch (error) { this.sendError(connection, errorCodeOf(error), undefined, key); return; }
    connection.subscriptions.set(key, subscription);
    try {
      const page = await this.hub.items(connection.sessionId, key);
      if (connection.subscriptions.get(key) !== subscription) return;
      if (!subscription.queue.some(message => message.type === "items" && message.reset)) {
        if (known && page.items.length <= 200) {
          const snapshot = page.items.map((item) => `${createHash("sha256").update(JSON.stringify(item)).digest("hex")}:${item.id}`);
          const have = new Set(known);
          const missing = page.items.filter((_, index) => !have.has(snapshot[index]));
          const frame = { type: "items" as const, key: key as CliSessionKey, items: missing, reset: true, more: page.more, snapshot };
          if (snapshot.every(mark => mark.length <= 512) && Buffer.byteLength(JSON.stringify(frame)) <= MESSAGE_BYTES) {
            this.send(connection, frame);
          } else this.sendItems(connection, key, page.items, page.more);
        } else this.sendItems(connection, key, page.items, page.more);
      }
    } catch (error) {
      if (connection.subscriptions.get(key) !== subscription) return;
      this.sendError(connection, error instanceof CliOpError ? error.code : "unknown", undefined, key);
    }
    subscription.ready = true;
    this.send(connection, { type: "requests", key: key as CliSessionKey, requests: this.hub.requests(key) });
    for (const message of subscription.queue.splice(0)) this.send(connection, message);
  }

  private tick() {
    const at = Date.now();
    for (const connection of [...this.connections]) {
      if (at - connection.lastSeen > this.pongTimeoutMs) { connection.ws.terminate(); continue; }
      if (connection.ws.readyState === WebSocket.OPEN) connection.ws.ping();
    }
    if (at - this.lastReauth >= this.reauthMs && !this.reauthing && !this.closed) {
      this.lastReauth = at;
      this.reauthing = true;
      void this.reauthorize().finally(() => { this.reauthing = false; });
    }
  }

  /** A logout, revoke or lost upstream login ends the socket within one re-check even when no hook fired. */
  private async reauthorize() {
    for (const token of new Set([...this.connections].map((connection) => connection.token))) {
      if (this.closed) return;
      const auth = await this.options.authorize(token).catch(() => ({ ok: false, status: 503 } as const));
      if (auth.ok) continue;
      const temporary = auth.status === 503;
      for (const connection of [...this.connections]) if (connection.token === token) this.closeConnection(connection, temporary);
    }
  }

  /** Called when a login ends (logout, revoke, lost upstream session). */
  closeSession(sessionId: string, temporary = false) {
    for (const connection of [...this.connections]) if (connection.sessionId === sessionId) this.closeConnection(connection, temporary);
  }

  private closeConnection(connection: Connection, temporary: boolean) {
    connection.ws.close(temporary ? 1013 : 4401, temporary ? "try again later" : "session ended");
    this.detach(connection);
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const connection of [...this.connections]) { connection.ws.terminate(); this.detach(connection); }
    this.wss.close();
  }
}

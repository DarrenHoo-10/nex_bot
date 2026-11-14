import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAME_PAYLOAD_MAX, WS_PING_MS, WS_PONG_TIMEOUT_MS } from "../../../shared/cli-agents";
import { decodeTermFrame, encodeTermFrame, TERM_INPUT, TERM_OUTPUT } from "../../../shared/cli-agent-frames";
import { CLOSE_UNAUTHORIZED, CliStream, reconnectDelay, RECONNECT_MAX_MS, RECONNECT_MIN_MS, type SocketLike, type StreamEvent } from "./stream";

class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  sent: Array<string | Uint8Array> = [];
  closed: number | undefined;
  send(data: string | Uint8Array) { this.sent.push(data); }
  close(code?: number) { this.closed = code ?? 1000; }
  open() { this.readyState = 1; this.onopen?.({}); }
  receive(data: unknown) { this.onmessage?.({ data }); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  json() { return this.sent.filter((entry): entry is string => typeof entry === "string").map((entry) => JSON.parse(entry)); }
  frames() { return this.sent.filter((entry): entry is Uint8Array => typeof entry !== "string"); }
}

let sockets: FakeSocket[];
let clock: number;
let stream: CliStream;
let events: StreamEvent[];

function make(random = 0) {
  stream = new CliStream({ url: "ws://test/stream", createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, random: () => random, now: () => clock });
  events = [];
  stream.on((event) => events.push(event));
}
const last = () => sockets[sockets.length - 1];
const statuses = () => events.filter((event) => event.type === "status").map((event) => (event as { status: string }).status);

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  clock = 0;
  make();
});
afterEach(() => {
  stream.stop();
  vi.useRealTimers();
});

describe("reconnectDelay", () => {
  it("doubles from 1 s to 30 s and keeps jitter inside the bounds", () => {
    expect(reconnectDelay(0, 0)).toBe(RECONNECT_MIN_MS);
    expect(reconnectDelay(1, 0)).toBe(2000);
    expect(reconnectDelay(2, 0)).toBe(4000);
    expect(reconnectDelay(10, 0)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelay(0, 1)).toBe(1250);
    expect(reconnectDelay(10, 1)).toBe(RECONNECT_MAX_MS);
  });
});

describe("connection", () => {
  it("connects with binary frames as ArrayBuffer and reports the status", () => {
    stream.start();
    expect(last().binaryType).toBe("arraybuffer");
    last().open();
    expect(statuses()).toEqual(["connecting", "open"]);
    expect(stream.isOpen).toBe(true);
  });

  it("sends a subscription made before the socket opened once it opens", () => {
    stream.start();
    stream.subscribeList();
    stream.subscribeSession("dev1:claude:s1");
    expect(last().json()).toEqual([]);
    last().open();
    expect(last().json()).toEqual([{ type: "sub.list" }, { type: "sub.session", key: "dev1:claude:s1" }]);
  });

  it("reconnects with backoff and sends the subscriptions again", () => {
    stream.start();
    stream.subscribeList();
    stream.subscribeSession("dev1:claude:s1");
    last().open();
    last().drop();
    expect(statuses().at(-1)).toBe("reconnecting");
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    last().open();
    expect(last().json()).toEqual([{ type: "sub.list" }, { type: "sub.session", key: "dev1:claude:s1" }]);
  });

  it("backs off further while nothing gets through and starts over after a message", () => {
    stream.start();
    last().drop();
    vi.advanceTimersByTime(1000);
    last().drop();
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    last().open();
    last().receive(JSON.stringify({ type: "summary", waiting: 0, running: 0 }));
    last().drop();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(4);
  });

  it("does not subscribe again for a released subscription", () => {
    stream.start();
    last().open();
    const release = stream.subscribeSession("dev1:claude:s1");
    release();
    release();
    expect(last().json()).toEqual([{ type: "sub.session", key: "dev1:claude:s1" }, { type: "unsub.session", key: "dev1:claude:s1" }]);
    last().drop();
    vi.advanceTimersByTime(1000);
    last().open();
    expect(last().json()).toEqual([]);
  });

  it("counts two users of one session subscription", () => {
    stream.start();
    last().open();
    const first = stream.subscribeSession("dev1:claude:s1");
    const second = stream.subscribeSession("dev1:claude:s1");
    first();
    expect(last().json().filter((message) => message.type === "unsub.session")).toHaveLength(0);
    second();
    expect(last().json().filter((message) => message.type === "unsub.session")).toHaveLength(1);
  });

  it("stops for good when the login ended", () => {
    stream.start();
    last().open();
    last().drop(CLOSE_UNAUTHORIZED);
    expect(events.at(-1)).toEqual({ type: "status", status: "closed", code: CLOSE_UNAUTHORIZED });
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("stop closes the socket and does not reconnect", () => {
    stream.start();
    const socket = last();
    socket.open();
    stream.stop();
    expect(socket.closed).toBe(1000);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(stream.status).toBe("closed");
  });

  it("reconnectNow skips the wait", () => {
    stream.start();
    last().drop();
    stream.reconnectNow();
    expect(sockets).toHaveLength(2);
    stream.reconnectNow();
    expect(sockets).toHaveLength(2);
  });
});

describe("keep-alive", () => {
  it("pings on an interval", () => {
    stream.start();
    last().open();
    vi.advanceTimersByTime(WS_PING_MS);
    expect(last().json()).toContainEqual({ type: "ping" });
  });

  it("drops a link that went silent and reconnects", () => {
    stream.start();
    last().open();
    clock = WS_PONG_TIMEOUT_MS + 1;
    vi.advanceTimersByTime(WS_PING_MS);
    expect(statuses().at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });

  it("does not hand pongs to listeners", () => {
    stream.start();
    last().open();
    last().receive(JSON.stringify({ type: "pong" }));
    expect(events.some((event) => event.type === "message")).toBe(false);
  });
});

describe("messages", () => {
  it("emits valid server messages and drops invalid ones", () => {
    stream.start();
    last().open();
    last().receive(JSON.stringify({ type: "summary", waiting: 2, running: 1 }));
    last().receive(JSON.stringify({ type: "summary", waiting: "x" }));
    last().receive("not json");
    expect(events.filter((event) => event.type === "message")).toEqual([{ type: "message", message: { type: "summary", waiting: 2, running: 1 } }]);
  });
});

describe("terminal streams", () => {
  it("sends term.open, resize, credit and close", () => {
    stream.start();
    last().open();
    expect(stream.openTerm("r1", "dev1:claude:s1", 120, 36, true)).toBe(true);
    stream.resizeTerm(4, 100, 30);
    stream.credit(4, 32_768.9);
    stream.credit(4, 0);
    stream.closeTerm(4);
    expect(last().json()).toEqual([
      { type: "term.open", req: "r1", key: "dev1:claude:s1", cols: 120, rows: 36, observe: true },
      { type: "term.resize", sid: 4, cols: 100, rows: 30 },
      { type: "term.credit", sid: 4, bytes: 32_768 },
      { type: "term.close", sid: 4 },
    ]);
  });

  it("refuses to send while the socket is not open", () => {
    stream.start();
    expect(stream.openTerm("r1", "dev1:claude:s1", 120, 36, true)).toBe(false);
    expect(stream.sendInput(1, "x")).toBe(false);
    expect(stream.credit(1, 10)).toBe(false);
  });

  it("emits output frames with their sid", () => {
    stream.start();
    last().open();
    const frame = encodeTermFrame(TERM_OUTPUT, 9, new TextEncoder().encode("hello"));
    last().receive(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
    const output = events.find((event) => event.type === "output");
    expect(output).toMatchObject({ type: "output", sid: 9 });
    expect(new TextDecoder().decode((output as { data: Uint8Array }).data)).toBe("hello");
  });

  it("ignores input frames and garbage coming from the server", () => {
    stream.start();
    last().open();
    last().receive(encodeTermFrame(TERM_INPUT, 9, new Uint8Array([65])).buffer);
    last().receive(new Uint8Array([1, 2]).buffer);
    expect(events.some((event) => event.type === "output")).toBe(false);
  });

  it("sends keyboard input as binary frames of at most 64 KiB", () => {
    stream.start();
    last().open();
    stream.sendInput(5, "é");
    stream.sendInput(5, new Uint8Array(FRAME_PAYLOAD_MAX + 10));
    const frames = last().frames().map((bytes) => decodeTermFrame(bytes));
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({ type: TERM_INPUT, sid: 5 });
    expect([...frames[0]!.payload]).toEqual([0xc3, 0xa9]);
    expect(frames[1]!.payload.length).toBe(FRAME_PAYLOAD_MAX);
    expect(frames[2]!.payload.length).toBe(10);
  });

  it("closes a stream Core opens for a request nobody waits for", () => {
    stream.start();
    last().open();
    stream.abandonReq("gone");
    last().receive(JSON.stringify({ type: "term.opened", req: "gone", sid: 12, cols: 80, rows: 24, observe: true }));
    expect(last().json()).toContainEqual({ type: "term.close", sid: 12 });
    expect(events.some((event) => event.type === "message")).toBe(false);
    // a request that was not given up on is delivered
    last().receive(JSON.stringify({ type: "term.opened", req: "kept", sid: 13, cols: 80, rows: 24, observe: true }));
    expect(events.filter((event) => event.type === "message")).toHaveLength(1);
  });
});

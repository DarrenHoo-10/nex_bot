import { describe, expect, it } from "vitest";
import { FRAME_PAYLOAD_MAX, type DeviceCliMessage } from "../../../shared/cli-agents.ts";
import { TERM_INPUT, TERM_OUTPUT, decodeTermFrame, encodeTermFrame } from "../../../shared/cli-agent-frames.ts";
import { HcError } from "./hc.ts";
import { FakeStream } from "./fake-hc.ts";
import { TermStreams, hcErrorCode, type TermAttachParams } from "./streams.ts";

function make(options: { fail?: unknown; maxStreams?: number } = {}) {
  const sent: DeviceCliMessage[] = [];
  const frames: Uint8Array[] = [];
  const attached: FakeStream[] = [];
  const streams = new TermStreams({
    attach: async (params: TermAttachParams) => {
      if (options.fail) throw options.fail;
      const stream = new FakeStream(params.terminal, params, 100, 30);
      attached.push(stream);
      return stream;
    },
    send: (message) => void sent.push(message),
    sendBinary: (frame) => void frames.push(frame),
    coalesceMs: 5,
    ...(options.maxStreams ? { maxStreams: options.maxStreams } : {}),
  });
  return { streams, sent, frames, attached };
}

const open = (streams: TermStreams, sid = 1, extra: Partial<{ observe: boolean; address: string | null }> = {}) =>
  streams.open({ sid, ref: "claude:abc", address: "t-1", cols: 120, rows: 40, observe: false, ...extra });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("TermStreams", () => {
  it("opens a stream, coalesces output into frames and relays input and credit", async () => {
    const { streams, sent, frames, attached } = make();
    await open(streams);
    expect(sent[0]).toMatchObject({ type: "cli.term.opened", sid: 1, observe: false });
    expect(attached[0].params).toMatchObject({ terminal: "t-1", observe: false, cols: 120, rows: 40 });
    attached[0].push("hel");
    attached[0].push("lo");
    await wait(40);
    expect(frames).toHaveLength(1);
    const frame = decodeTermFrame(frames[0])!;
    expect(frame.type).toBe(TERM_OUTPUT);
    expect(frame.sid).toBe(1);
    expect(Buffer.from(frame.payload).toString()).toBe("hello");
    streams.input(encodeTermFrame(TERM_INPUT, 1, Buffer.from("ls\r")));
    expect(attached[0].text()).toBe("ls\r");
    streams.credit(1, 4096);
    expect(attached[0].acks).toEqual([4096]);
    streams.resize(1, 200, 50);
    expect(attached[0].resizes).toEqual([[200, 50]]);
  });

  it("splits large output into frames within the payload limit", async () => {
    const { streams, frames, attached } = make();
    await open(streams);
    attached[0].push(Buffer.alloc(FRAME_PAYLOAD_MAX * 2 + 10, 0x61));
    await wait(40);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    for (const frame of frames) expect(decodeTermFrame(frame)!.payload.length).toBeLessThanOrEqual(FRAME_PAYLOAD_MAX);
    expect(frames.reduce((n, f) => n + decodeTermFrame(f)!.payload.length, 0)).toBe(FRAME_PAYLOAD_MAX * 2 + 10);
  });

  it("rejects input on an observing stream and never resizes it", async () => {
    const { streams, sent, attached } = make();
    await open(streams, 2, { observe: true });
    streams.input(encodeTermFrame(TERM_INPUT, 2, Buffer.from("x")));
    expect(attached[0].writes).toHaveLength(0);
    expect(sent).toContainEqual({ type: "cli.term.error", sid: 2, code: "read_only" });
    streams.resize(2, 10, 10);
    expect(attached[0].resizes).toHaveLength(0);
  });

  it("forwards the size of an observed terminal", async () => {
    const { streams, sent, attached } = make();
    await open(streams, 3, { observe: true });
    attached[0].emit("resize", { cols: 90, rows: 20 });
    expect(sent).toContainEqual({ type: "cli.term.size", sid: 3, cols: 90, rows: 20 });
  });

  it("reports why an attach failed", async () => {
    const draft = make({ fail: new HcError("hc_draft", "x") });
    await open(draft.streams);
    expect(draft.sent).toEqual([{ type: "cli.term.error", sid: 1, code: "busy" }]);
    const gone = make({ fail: new HcError("not_found", "x") });
    await open(gone.streams);
    expect(gone.sent).toEqual([{ type: "cli.term.error", sid: 1, code: "stopped" }]);
  });

  it("rejects a session without a terminal, duplicate sids and too many streams", async () => {
    const { streams, sent } = make({ maxStreams: 1 });
    await open(streams, 1, { address: null });
    expect(sent.pop()).toMatchObject({ code: "not_in_terminal" });
    await open(streams, 1);
    await open(streams, 1);
    expect(sent.pop()).toMatchObject({ code: "invalid" });
    await open(streams, 2);
    expect(sent.pop()).toMatchObject({ code: "busy" });
  });

  it("tells Core when the program exits and leaves terminals alone when closing all", async () => {
    const { streams, sent, attached } = make();
    await open(streams, 1);
    await open(streams, 2);
    attached[0].finish("exited", 2);
    expect(sent).toContainEqual({ type: "cli.term.closed", sid: 1, reason: "exited", exitCode: 2 });
    sent.length = 0;
    streams.closeAll("paused");
    expect(sent).toEqual([{ type: "cli.term.closed", sid: 2, reason: "paused" }]);
    expect(attached[1].closed).toBe(true);
    expect(streams.count).toBe(0);
    streams.closeAll("link_lost");
    expect(sent).toHaveLength(1);
  });

  it("refuses to open while blocked", async () => {
    const { streams, sent } = make();
    streams.block("paused");
    await open(streams);
    expect(sent).toEqual([{ type: "cli.term.error", sid: 1, code: "paused" }]);
  });

  it("closes silently when Core closes a stream", async () => {
    const { streams, sent, attached } = make();
    await open(streams);
    sent.length = 0;
    streams.close(1);
    expect(attached[0].closed).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe("hcErrorCode", () => {
  it("maps herdr-core failures to Core error codes", () => {
    expect(hcErrorCode(new HcError("hc_unavailable", "x"))).toBe("hc_unavailable");
    expect(hcErrorCode(new HcError("hc_version", "x"))).toBe("hc_version");
    expect(hcErrorCode(new HcError("hc_observe_only", "x"))).toBe("read_only");
    expect(hcErrorCode(new Error("boom"))).toBe("unknown");
  });
});

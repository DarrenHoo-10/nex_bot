import { describe, expect, it } from "vitest";

import {
  FRAME_HEADER_BYTES,
  FrameDecoder,
  FrameError,
  FrameKind,
  MAX_FRAME_PAYLOAD,
  decodeCloseReason,
  decodeCredit,
  decodeResize,
  encodeClose,
  encodeCredit,
  encodeFocus,
  encodeFrame,
  encodeJsonFrame,
  encodeResize,
} from "./hc-frames.ts";

describe("frame codec", () => {
  it("lays out channel, kind and length little-endian", () => {
    const frame = encodeFrame(0x01020304, FrameKind.DATA, "hi");
    expect([...frame]).toEqual([4, 3, 2, 1, 0, 2, 0, 0, 0, 0x68, 0x69]);
    expect(frame.length).toBe(FRAME_HEADER_BYTES + 2);
  });

  it("encodes credit, resize, close and focus payloads", () => {
    expect(decodeCredit(new FrameDecoder().push(encodeCredit(7, 262144))[0].payload)).toBe(262144);
    const resize = new FrameDecoder().push(encodeResize(7, 120, 40))[0];
    expect(resize.kind).toBe(FrameKind.RESIZE);
    expect(decodeResize(resize.payload)).toEqual({ cols: 120, rows: 40 });
    const close = new FrameDecoder().push(encodeClose(7))[0];
    expect(close).toMatchObject({ channel: 7, kind: FrameKind.CLOSE });
    expect(close.payload.length).toBe(0);
    expect([...new FrameDecoder().push(encodeFocus(7, true))[0].payload]).toEqual([1]);
  });

  it("rejects out-of-range values on encode", () => {
    expect(() => encodeFrame(-1, 0)).toThrow(FrameError);
    expect(() => encodeFrame(0, 256)).toThrow(FrameError);
    expect(() => encodeResize(1, 70000, 1)).toThrow(FrameError);
    expect(() => encodeCredit(1, -5)).toThrow(FrameError);
    expect(() => encodeFrame(1, 0, Buffer.alloc(MAX_FRAME_PAYLOAD + 1))).toThrow(/exceeds/);
    expect(() => decodeCredit(Buffer.alloc(3))).toThrow(FrameError);
    expect(() => decodeResize(Buffer.alloc(5))).toThrow(FrameError);
  });

  it("reads the close reason JSON, tolerating an empty or broken payload", () => {
    expect(decodeCloseReason(Buffer.from('{"reason":"exited","exit_code":0,"signal":null}'))).toEqual({
      reason: "exited",
      exit_code: 0,
      signal: null,
    });
    expect(decodeCloseReason(Buffer.alloc(0))).toBeNull();
    expect(decodeCloseReason(Buffer.from("not json"))).toBeNull();
    expect(decodeCloseReason(Buffer.from("[1]"))).toBeNull();
  });
});

describe("FrameDecoder", () => {
  it("returns several frames from one chunk", () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(Buffer.concat([encodeJsonFrame(0, { a: 1 }), encodeFrame(3, 0, "abc"), encodeClose(3)]));
    expect(frames.map((frame) => [frame.channel, frame.kind, frame.payload.toString()])).toEqual([
      [0, 0, '{"a":1}'],
      [3, 0, "abc"],
      [3, 2, ""],
    ]);
    expect(decoder.pendingBytes).toBe(0);
  });

  it("reassembles frames split at every byte boundary", () => {
    const wire = Buffer.concat([encodeFrame(5, 0, "hello world"), encodeResize(5, 80, 24), encodeFrame(9, 0, Buffer.alloc(0))]);
    const decoder = new FrameDecoder();
    const seen: Array<[number, number, number]> = [];
    for (const byte of wire) {
      for (const frame of decoder.push(Buffer.from([byte]))) seen.push([frame.channel, frame.kind, frame.payload.length]);
    }
    expect(seen).toEqual([
      [5, 0, 11],
      [5, 3, 4],
      [9, 0, 0],
    ]);
  });

  it("keeps a partial frame pending until the rest arrives", () => {
    const decoder = new FrameDecoder();
    const wire = encodeFrame(1, 0, "0123456789");
    expect(decoder.push(wire.subarray(0, 5))).toEqual([]);
    expect(decoder.pendingBytes).toBe(5);
    expect(decoder.push(wire.subarray(5, 12))).toEqual([]);
    const [frame] = decoder.push(wire.subarray(12));
    expect(frame.payload.toString()).toBe("0123456789");
  });

  it("preserves binary payloads and unknown kinds", () => {
    const payload = Buffer.from([0, 255, 1, 254, 0x1b, 0x5b]);
    const [frame] = new FrameDecoder().push(encodeFrame(2, 200, payload));
    expect(frame.kind).toBe(200);
    expect(frame.payload.equals(payload)).toBe(true);
  });

  it("accepts a payload of exactly 16 MiB", () => {
    const decoder = new FrameDecoder();
    const [frame] = decoder.push(encodeFrame(1, 0, Buffer.alloc(MAX_FRAME_PAYLOAD, 7)));
    expect(frame.payload.length).toBe(MAX_FRAME_PAYLOAD);
  });

  it("rejects an oversized length from the header and stays failed", () => {
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.writeUInt32LE(1, 0);
    header.writeUInt32LE(MAX_FRAME_PAYLOAD + 1, 5);
    const decoder = new FrameDecoder();
    expect(() => decoder.push(header)).toThrow(/exceeds/);
    expect(decoder.pendingBytes).toBe(0);
    expect(() => decoder.push(encodeFrame(1, 0, "ok"))).toThrow(FrameError);
  });
});

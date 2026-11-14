import { describe, expect, it } from "vitest";

import {
  decodeTermFrame,
  encodeTermFrame,
  FRAME_HEADER_BYTES,
  splitPayload,
  TERM_INPUT,
  TERM_OUTPUT,
} from "./cli-agent-frames.ts";
import { FRAME_PAYLOAD_MAX } from "./cli-agents.ts";

describe("terminal frames", () => {
  it("round trips both types", () => {
    const payload = new Uint8Array([1, 2, 3, 255]);
    for (const type of [TERM_OUTPUT, TERM_INPUT] as const) {
      const frame = decodeTermFrame(encodeTermFrame(type, 7, payload));
      expect(frame?.type).toBe(type);
      expect(frame?.sid).toBe(7);
      expect(Array.from(frame?.payload ?? [])).toEqual([1, 2, 3, 255]);
    }
  });

  it("writes the layout [type][u32 LE sid][payload]", () => {
    const bytes = encodeTermFrame(TERM_OUTPUT, 0x01020304, new Uint8Array([9]));
    expect(Array.from(bytes)).toEqual([0x01, 0x04, 0x03, 0x02, 0x01, 9]);
  });

  it("handles the extreme sids and an empty payload", () => {
    for (const sid of [0, 0xffff_ffff]) {
      const frame = decodeTermFrame(encodeTermFrame(TERM_INPUT, sid, new Uint8Array()));
      expect(frame).toMatchObject({ type: TERM_INPUT, sid });
      expect(frame?.payload.length).toBe(0);
    }
  });

  it("accepts a payload of exactly the maximum", () => {
    const frame = decodeTermFrame(encodeTermFrame(TERM_OUTPUT, 1, new Uint8Array(FRAME_PAYLOAD_MAX)));
    expect(frame?.payload.length).toBe(FRAME_PAYLOAD_MAX);
  });

  it("decodes from a view with a byte offset", () => {
    const inner = encodeTermFrame(TERM_OUTPUT, 5, new Uint8Array([4, 5]));
    const host = new Uint8Array(inner.length + 3);
    host.set(inner, 3);
    const frame = decodeTermFrame(host.subarray(3));
    expect(frame?.sid).toBe(5);
    expect(Array.from(frame?.payload ?? [])).toEqual([4, 5]);
  });

  it("rejects short frames, unknown types and oversize payloads", () => {
    expect(decodeTermFrame(new Uint8Array())).toBeNull();
    expect(decodeTermFrame(new Uint8Array([TERM_OUTPUT, 0, 0, 0]))).toBeNull();
    expect(decodeTermFrame(new Uint8Array(FRAME_HEADER_BYTES))).toBeNull();
    expect(decodeTermFrame(new Uint8Array([0x03, 0, 0, 0, 0]))).toBeNull();
    expect(decodeTermFrame(new Uint8Array([0xff, 0, 0, 0, 0, 1]))).toBeNull();
    const big = new Uint8Array(FRAME_HEADER_BYTES + FRAME_PAYLOAD_MAX + 1);
    big[0] = TERM_OUTPUT;
    expect(decodeTermFrame(big)).toBeNull();
    expect(decodeTermFrame("abc" as unknown as Uint8Array)).toBeNull();
  });

  it("refuses to encode what the decoder would reject", () => {
    expect(() => encodeTermFrame(3 as 1, 1, new Uint8Array())).toThrow(RangeError);
    expect(() => encodeTermFrame(TERM_OUTPUT, -1, new Uint8Array())).toThrow(RangeError);
    expect(() => encodeTermFrame(TERM_OUTPUT, 0x1_0000_0000, new Uint8Array())).toThrow(RangeError);
    expect(() => encodeTermFrame(TERM_OUTPUT, 1.5, new Uint8Array())).toThrow(RangeError);
    expect(() => encodeTermFrame(TERM_OUTPUT, 1, new Uint8Array(FRAME_PAYLOAD_MAX + 1))).toThrow(RangeError);
  });
});

describe("splitPayload", () => {
  it("returns nothing for an empty payload and one chunk for a small one", () => {
    expect(splitPayload(new Uint8Array())).toEqual([]);
    expect(splitPayload(new Uint8Array(10))).toHaveLength(1);
  });

  it("splits at the frame maximum by default and keeps the bytes in order", () => {
    const payload = new Uint8Array(FRAME_PAYLOAD_MAX * 2 + 5).map((_, index) => index % 251);
    const chunks = splitPayload(payload);
    expect(chunks.map((chunk) => chunk.length)).toEqual([FRAME_PAYLOAD_MAX, FRAME_PAYLOAD_MAX, 5]);
    const joined = new Uint8Array(payload.length);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    expect(joined).toEqual(payload);
  });

  it("honours a custom size and rejects a bad one", () => {
    expect(splitPayload(new Uint8Array(10), 4).map((chunk) => chunk.length)).toEqual([4, 4, 2]);
    expect(splitPayload(new Uint8Array(8), 4)).toHaveLength(2);
    expect(() => splitPayload(new Uint8Array(1), 0)).toThrow(RangeError);
    expect(() => splitPayload(new Uint8Array(1), 1.5)).toThrow(RangeError);
  });

  it("every chunk encodes as a valid frame", () => {
    for (const chunk of splitPayload(new Uint8Array(FRAME_PAYLOAD_MAX + 10))) {
      expect(decodeTermFrame(encodeTermFrame(TERM_OUTPUT, 2, chunk))).not.toBeNull();
    }
  });
});

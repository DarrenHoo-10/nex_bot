// Binary frames for terminal bytes on the device link and the browser
// WebSocket (plan 4.3): [u8 type][u32 LE sid][payload]. Core re-encodes a
// frame between the two sides, swapping only the sid. Uint8Array and DataView
// only, so the browser can use it as is.
import { FRAME_PAYLOAD_MAX } from "./cli-agents.ts";

/** terminal output: device -> Core -> browser */
export const TERM_OUTPUT = 0x01;
/** terminal input: browser -> Core -> device */
export const TERM_INPUT = 0x02;

export type TermFrameType = typeof TERM_OUTPUT | typeof TERM_INPUT;

export const FRAME_HEADER_BYTES = 5;

export interface TermFrame {
  type: TermFrameType;
  sid: number;
  payload: Uint8Array;
}

const U32_MAX = 0xffff_ffff;

/** Throws a RangeError on an unknown type, an out-of-range sid or a payload
 * above FRAME_PAYLOAD_MAX: encoding is our own code, so that is a bug. Use
 * splitPayload first for anything that may be larger. */
export function encodeTermFrame(type: TermFrameType, sid: number, payload: Uint8Array): Uint8Array {
  if (type !== TERM_OUTPUT && type !== TERM_INPUT) throw new RangeError("unknown terminal frame type");
  if (!Number.isInteger(sid) || sid < 0 || sid > U32_MAX) throw new RangeError("terminal frame sid out of range");
  if (payload.length > FRAME_PAYLOAD_MAX) throw new RangeError("terminal frame payload too large");
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, sid, true);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

/** Null for an unknown type, a frame shorter than its header or a payload
 * above FRAME_PAYLOAD_MAX. The payload is a view into `bytes`, not a copy. */
export function decodeTermFrame(bytes: Uint8Array): TermFrame | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < FRAME_HEADER_BYTES) return null;
  const type = bytes[0];
  if (type !== TERM_OUTPUT && type !== TERM_INPUT) return null;
  if (bytes.length - FRAME_HEADER_BYTES > FRAME_PAYLOAD_MAX) return null;
  const sid = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true);
  return { type, sid, payload: bytes.subarray(FRAME_HEADER_BYTES) };
}

/** Cuts a payload into chunks of at most `max` bytes (views, no copy). An
 * empty payload gives no chunks. */
export function splitPayload(payload: Uint8Array, max: number = FRAME_PAYLOAD_MAX): Uint8Array[] {
  if (!Number.isInteger(max) || max < 1) throw new RangeError("split size must be a positive integer");
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < payload.length; offset += max) {
    chunks.push(payload.subarray(offset, Math.min(offset + max, payload.length)));
  }
  return chunks;
}

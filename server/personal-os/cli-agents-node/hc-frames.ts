// herdr-core framed-mode codec (protocol generation 1).
//
// Every frame is `[channel u32 LE][kind u8][len u32 LE][payload]`. Channel 0
// carries JSON-RPC (one message per DATA frame); other channels are attach
// streams or the event stream. Pure functions only: no sockets, no timers.

export const FRAME_HEADER_BYTES = 9;
/** herdr-core refuses payloads above 16 MiB; so do we, in both directions. */
export const MAX_FRAME_PAYLOAD = 16 * 1024 * 1024;

export const FrameKind = {
  DATA: 0,
  CREDIT: 1,
  CLOSE: 2,
  RESIZE: 3,
  FOCUS: 4,
  FACTS: 5,
  AUTOMATIC_INPUT: 6,
} as const;
export type FrameKindValue = (typeof FrameKind)[keyof typeof FrameKind];

export interface Frame {
  channel: number;
  /** Unknown kinds are passed through so callers can ignore them. */
  kind: number;
  payload: Buffer;
}

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

export function encodeFrame(channel: number, kind: number, payload: Uint8Array | string = Buffer.alloc(0)): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (!Number.isInteger(channel) || channel < 0 || channel > 0xffffffff) throw new FrameError(`invalid channel ${channel}`);
  if (!Number.isInteger(kind) || kind < 0 || kind > 0xff) throw new FrameError(`invalid frame kind ${kind}`);
  if (body.length > MAX_FRAME_PAYLOAD) throw new FrameError(`frame payload of ${body.length} bytes exceeds ${MAX_FRAME_PAYLOAD}`);
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + body.length);
  frame.writeUInt32LE(channel, 0);
  frame.writeUInt8(kind, 4);
  frame.writeUInt32LE(body.length, 5);
  body.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

export function encodeJsonFrame(channel: number, message: unknown): Buffer {
  return encodeFrame(channel, FrameKind.DATA, JSON.stringify(message));
}

/** CREDIT: the receiver consumed this many bytes, so the sender may send more. */
export function encodeCredit(channel: number, bytes: number): Buffer {
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > 0xffffffff) throw new FrameError(`invalid credit ${bytes}`);
  const payload = Buffer.allocUnsafe(4);
  payload.writeUInt32LE(bytes, 0);
  return encodeFrame(channel, FrameKind.CREDIT, payload);
}

export function decodeCredit(payload: Uint8Array): number {
  if (payload.byteLength !== 4) throw new FrameError(`credit payload must be 4 bytes, got ${payload.byteLength}`);
  return Buffer.from(payload.buffer, payload.byteOffset, 4).readUInt32LE(0);
}

export function encodeResize(channel: number, cols: number, rows: number): Buffer {
  for (const value of [cols, rows]) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new FrameError(`invalid terminal size ${cols}x${rows}`);
  }
  const payload = Buffer.allocUnsafe(4);
  payload.writeUInt16LE(cols, 0);
  payload.writeUInt16LE(rows, 2);
  return encodeFrame(channel, FrameKind.RESIZE, payload);
}

export function decodeResize(payload: Uint8Array): { cols: number; rows: number } {
  if (payload.byteLength !== 4) throw new FrameError(`resize payload must be 4 bytes, got ${payload.byteLength}`);
  const bytes = Buffer.from(payload.buffer, payload.byteOffset, 4);
  return { cols: bytes.readUInt16LE(0), rows: bytes.readUInt16LE(2) };
}

export function encodeClose(channel: number): Buffer {
  return encodeFrame(channel, FrameKind.CLOSE);
}

export function encodeFocus(channel: number, focused: boolean): Buffer {
  return encodeFrame(channel, FrameKind.FOCUS, Buffer.from([focused ? 1 : 0]));
}

/** CLOSE from the core carries a JSON reason, or nothing (the empty ack). */
export function decodeCloseReason(payload: Uint8Array): Record<string, unknown> | null {
  if (payload.byteLength === 0) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Streaming decoder: feed it socket chunks of any size, get whole frames.
 * An oversized length is rejected from the header alone, before any payload is
 * buffered, and leaves the decoder unusable: the stream is no longer in sync. */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private poisoned: FrameError | null = null;

  /** Bytes received but not yet part of a returned frame. */
  get pendingBytes(): number {
    return this.buffered;
  }

  push(chunk: Uint8Array): Frame[] {
    if (this.poisoned) throw this.poisoned;
    if (chunk.byteLength > 0) {
      this.chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      this.buffered += chunk.byteLength;
    }
    const frames: Frame[] = [];
    while (this.buffered >= FRAME_HEADER_BYTES) {
      const header = this.peek(FRAME_HEADER_BYTES);
      const length = header.readUInt32LE(5);
      if (length > MAX_FRAME_PAYLOAD) {
        this.poisoned = new FrameError(`frame payload of ${length} bytes exceeds ${MAX_FRAME_PAYLOAD}`);
        this.chunks = [];
        this.buffered = 0;
        throw this.poisoned;
      }
      if (this.buffered < FRAME_HEADER_BYTES + length) break;
      const whole = this.take(FRAME_HEADER_BYTES + length);
      frames.push({
        channel: whole.readUInt32LE(0),
        kind: whole.readUInt8(4),
        payload: whole.subarray(FRAME_HEADER_BYTES),
      });
    }
    return frames;
  }

  private peek(size: number): Buffer {
    const first = this.chunks[0];
    if (first.length >= size) return first;
    return this.copy(size, false);
  }

  private take(size: number): Buffer {
    const first = this.chunks[0];
    if (first.length === size) {
      this.chunks.shift();
      this.buffered -= size;
      return first;
    }
    if (first.length > size) {
      this.chunks[0] = first.subarray(size);
      this.buffered -= size;
      return first.subarray(0, size);
    }
    return this.copy(size, true);
  }

  private copy(size: number, consume: boolean): Buffer {
    const out = Buffer.allocUnsafe(size);
    let offset = 0;
    let index = 0;
    while (offset < size) {
      const chunk = this.chunks[index];
      const used = Math.min(chunk.length, size - offset);
      chunk.copy(out, offset, 0, used);
      offset += used;
      if (used === chunk.length) {
        index += 1;
      } else if (consume) {
        this.chunks[index] = chunk.subarray(used);
      }
    }
    if (consume) {
      this.chunks.splice(0, index);
      this.buffered -= size;
    }
    return out;
  }
}

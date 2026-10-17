import type { IncomingMessage } from "node:http";

const bodies = new WeakMap<IncomingMessage, Promise<Record<string, unknown>>>();
/** The hosted dispatcher and selected Core consume exactly the same bounded body. */
export function requestBody(request: IncomingMessage) {
  let pending = bodies.get(request);
  if (!pending) {
    pending = (async () => {
      let size = 0; const buffers: Buffer[] = [];
      for await (const raw of request) {
        const buffer = Buffer.from(raw as Uint8Array); size += buffer.length;
        if (size > 256_000) throw new Error("请求过大");
        buffers.push(buffer);
      }
      const parsed: unknown = JSON.parse(Buffer.concat(buffers).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid request");
      return parsed as Record<string, unknown>;
    })();
    bodies.set(request, pending);
  }
  return pending;
}

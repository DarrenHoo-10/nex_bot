// Host process of the bundled device executor. Swift spawns `node executor-host.mjs <dataDir>` and speaks
// newline-delimited JSON over stdin/stdout. stdout carries the protocol only; logs go to stderr and never contain tokens.
//
//   Swift -> host  {op:"init", key:<base64 32 bytes>}                       first line, once
//                  {id, op:"start", session:{origin,name,token,coreId,sessionId,expiresAt}}
//                  {id, op:"stop", revoke:bool} | {id, op:"pause", paused:bool}
//                  {id, op:"reconcile", callId, version} | {id, op:"state"}
//   host -> Swift  {id, ok:true, state} | {id, ok:false, error}  and unsolicited {event:"state", state}
//
// Stdin EOF or SIGTERM stops the device without revoking it and exits.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { existsSync, realpathSync } from "node:fs";

/** Same contract as Electron's safeStorage, keyed by the master key Swift keeps in the Keychain. */
export function createSafeStorage(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("invalid master key");
  return {
    isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(String(text), "utf8"), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(data) {
      const bytes = Buffer.from(data), decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8");
    },
  };
}

/** Same shape and error text as `request()` in electron/nex-client-main.mjs. */
export async function request(address, route, data, token) {
  const response = await fetch(address + route, { method: data ? "POST" : "GET", headers: { ...(data ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}), redirect: "error", signal: AbortSignal.timeout(15_000) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error ?? "无法连接 Core"), { status: response.status });
  return result;
}

const text = (value, name) => { if (typeof value !== "string" || !value) throw new Error(`invalid ${name}`); return value; };
function validSession(s) {
  if (!s || typeof s !== "object") throw new Error("invalid session");
  for (const field of ["origin", "token", "coreId", "sessionId"]) text(s[field], field);
  if (typeof s.expiresAt !== "number") throw new Error("invalid expiresAt");
  return { origin: s.origin, name: typeof s.name === "string" && s.name ? s.name : "此电脑", token: s.token, coreId: s.coreId, sessionId: s.sessionId, expiresAt: s.expiresAt };
}

/**
 * Runs the protocol on the given streams. `ClientDevice` and `createNode` are injected so tests can fake them.
 * Resolves after the input ends and the device has stopped.
 */
export async function runHost({ input, output, directory, ClientDevice, createNode, requestImpl = request, log = () => {}, signal }) {
  let device, closing = false;
  const send = (value) => { if (!output.destroyed) output.write(JSON.stringify(value) + "\n"); };
  const lines = createInterface({ input });
  signal?.addEventListener("abort", () => lines.close(), { once: true });
  output.on?.("error", () => {});
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) return;
  let init;
  try { init = JSON.parse(first.value); } catch { init = undefined; }
  if (init?.op !== "init") { log("first line must be init"); return; }
  let safeStorage;
  try { safeStorage = createSafeStorage(Buffer.from(String(init.key), "base64")); } catch (e) { log(e.message); return; }
  let last = "";
  const publish = () => {
    if (closing || !device) return;
    const state = device.state(), json = JSON.stringify(state);
    if (json !== last) { last = json; send({ event: "state", state }); }
  };
  device = new ClientDevice({ directory, safeStorage, request: requestImpl, createNode, changed: publish });
  async function handle(message) {
    switch (message.op) {
      case "start": await device.start(validSession(message.session)); return device.state();
      case "stop": await device.stop({ revoke: message.revoke === true }); return device.state();
      case "pause": if (typeof message.paused !== "boolean") throw new Error("invalid paused"); return device.setPaused(message.paused);
      case "reconcile": return device.reconcile(text(message.callId, "callId"), Number(message.version));
      case "state": return device.state();
      default: throw new Error("unknown op");
    }
  }
  const pending = new Set();
  for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { log("ignored malformed line"); continue; }
    const id = message?.id;
    // Requests run concurrently so pause can interrupt a running start; ClientDevice serializes internally.
    const work = handle(message).then(
      (state) => send({ id, ok: true, state }),
      (error) => send({ id, ok: false, error: error instanceof Error ? error.message : String(error) }));
    pending.add(work); work.finally(() => pending.delete(work));
  }
  closing = true;
  await Promise.allSettled(pending);
  await device.stop().catch(() => {});
}

// Entry point: node executor-host.mjs <dataDir>
// Node resolves symlinks in import.meta.url (/tmp -> /private/tmp), so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const here = path.dirname(realpathSync(process.argv[1]));
  const directory = process.argv[2];
  if (!directory) { console.error("usage: executor-host.mjs <dataDir>"); process.exit(2); }
  const nodeFile = path.join(here, "client-executor/client-node/client-node.js");
  const deviceFile = existsSync(path.join(here, "nex-client-device.mjs")) ? path.join(here, "nex-client-device.mjs") : path.resolve(here, "../../../electron/nex-client-device.mjs");
  const log = (message) => process.stderr.write(`[executor-host] ${message}\n`);
  const [{ ClientDevice }, { createClientNode }] = await Promise.all([import(pathToFileURL(deviceFile).href), import(pathToFileURL(nodeFile).href)]);
  const controller = new AbortController();
  // SIGTERM ends the input loop, which stops the device without revoking.
  process.on("SIGTERM", () => controller.abort());
  const done = runHost({ input: process.stdin, output: process.stdout, directory, ClientDevice, createNode: createClientNode, log, signal: controller.signal });
  await done.catch((error) => log(`fatal: ${error?.message ?? error}`));
  process.exit(0);
}

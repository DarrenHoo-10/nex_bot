import { mkdirSync, existsSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";
import { DeviceNode } from "./node.ts";
import type { Row } from "./store.ts";

// Thin clients store only a device execution journal and encrypted connection
// grants. They do not create a Core database or run an Agent/memory service.
export function createClientNode(dir: string, key: Buffer, changed: () => void, expectedOrigin?: string) {
  if (key.length !== 32) throw new Error("Invalid client vault key");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "device-secrets.db"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS secrets(id TEXT PRIMARY KEY,ciphertext TEXT NOT NULL) STRICT;");
  const store = {
    dir,
    get(sql: string, ...args: SQLInputValue[]) { return db.prepare(sql).get(...args) as Row | undefined; },
    run(sql: string, ...args: SQLInputValue[]) { return db.prepare(sql).run(...args); },
    encrypt(value: string) { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString("base64"); },
    decrypt(value: string) { const bytes = Buffer.from(value, "base64"), cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString("utf8"); },
  };
  const previous = store.get("SELECT ciphertext FROM secrets WHERE id='node-config'");
  if (previous && expectedOrigin && JSON.parse(store.decrypt(String(previous.ciphertext))).origin !== expectedOrigin) store.run("DELETE FROM secrets WHERE id='node-config'");
  const node = new DeviceNode(store, changed);
  return { node, async close() { await node.close(); db.close(); } };
}
export function clearClientGrant(dir: string) {
  if (!existsSync(path.join(dir, "device-secrets.db"))) return;
  const db = new DatabaseSync(path.join(dir, "device-secrets.db"));
  try { db.prepare("DELETE FROM secrets WHERE id='node-config'").run(); } finally { db.close(); }
}

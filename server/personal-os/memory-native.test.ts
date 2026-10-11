// Explicit native infrastructure gate; no paid provider or user profile.
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { createPersonalApp } from "./index.ts";
import { pathToFileURL } from "node:url";
const createApp: typeof createPersonalApp = process.env.NEX_TEST_BUNDLE ? (await import(pathToFileURL(path.resolve(process.env.NEX_TEST_BUNDLE)).href)).createPersonalApp : createPersonalApp;
function cleanup(root: string) {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("nex-memory-native-")) throw new Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
}

it.skipIf(process.env.NEX_HINDSIGHT_NATIVE !== "1")("starts genuine Hindsight/Postgres, authenticates the service and attributes a deferred retain model call to Core", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-memory-native-"));
  const requests: Array<Record<string, unknown>> = [];
  const fake = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; requests.push(body);
    // Empty facts is a valid extraction response; this gate verifies real
    // deferred transport/accounting, not semantic quality.
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "native-fixture", model: "fixture", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ facts: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
  })(); });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const app = await createApp({ dir: root, key: randomBytes(32), token: "synthetic-owner", memoryRuntime: { command: "uv", args: ["run", "--offline", "--no-project", "--isolated", "--with", "hindsight-all==0.10.3", "python", "-u"], fixture: true } });
  const { store, memoryService: service } = app, memory = app.runtime.memory;
  store.saveConfig({ provider: "openai", endpoint: `http://127.0.0.1:${(fake.address() as { port: number }).port}/v1`, model: "fixture", apiKey: "synthetic-paid-key" });
  try {
    service.start(); await service.startup;
    expect(service.state, service.diagnostic).toBe("ready");
    const client = memory.ledger.client!;
    expect((await fetch(client.endpoint + "/v1/default/banks")).status).toBe(401);
    const bot = store.createBot("Native任意Agent"); memory.write(bot, { title: "合成中文来源", content: "合成用户偏好中文回答。" });
    const deadline = Date.now() + 45_000;
    while (!store.get("SELECT transfer_id FROM memory_transfer_receipts") && Date.now() < deadline) { await memory.ledger.flush(); await new Promise((resolve) => setTimeout(resolve, 300)); }
    const diagnostic = JSON.stringify({ health: memory.ledger.status(), transfers: store.all("SELECT status,error_code,attempts FROM memory_transfers"), invoices: store.all("SELECT purpose,status FROM memory_model_invocations"), requests: requests.length });
    expect(store.all("SELECT * FROM memory_transfer_receipts"), diagnostic).toHaveLength(1);
    expect(requests.length).toBeGreaterThan(0);
    const invoices = store.all("SELECT * FROM memory_model_invocations");
    expect(invoices.length).toBe(requests.length);
    expect(invoices.every((row) => row.purpose === "retain" && row.status === "succeeded" && row.input_tokens === 12)).toBe(true);
    expect(JSON.stringify(requests)).not.toContain(service.gateway.token);
    expect(store.all("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await app.close(); expect(service.child?.exitCode).toBe(0);
    await new Promise<void>((resolve) => { fake.close(() => resolve()); fake.closeAllConnections(); });
    cleanup(root);
  }
}, 240_000);

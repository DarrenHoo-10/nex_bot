// Explicit native infrastructure gate; no paid provider or user profile.
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { createPersonalApp } from "./index.ts";
import { ManagedMemoryService } from "./memory-service.ts";
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
    const messages = body.messages as Array<{ role: string; content: string }>;
    const tools = Array.isArray(body.tools);
    const evidence = messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
    const call = evidence ? { name: "done", arguments: { answer: "根据合成记忆，雪鹭项目在星期二开会。", memory_ids: [...new Set(evidence.match(/[0-9a-f]{8}-[0-9a-f-]{27}/gi) ?? [])] } } : { name: "recall", arguments: { query: "雪鹭项目会议", reason: "查找合成测试来源", max_tokens: 1500 } };
    response.end(JSON.stringify({ id: "native-fixture", model: "fixture", object: "chat.completion", choices: [{ index: 0, message: tools ? { role: "assistant", content: null, tool_calls: [{ id: "native-tool-" + requests.length, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: "assistant", content: JSON.stringify({ facts: [] }) }, finish_reason: tools ? "tool_calls" : "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
  })(); });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const production = process.env.NEX_HINDSIGHT_PRODUCTION === "1";
  const resources = path.resolve(process.env.NEX_TEST_MEMORY_RESOURCES ?? "dist-personal/memory-runtime"), manifest = production ? JSON.parse((await import("node:fs")).readFileSync(path.join(resources, "runtime.json"), "utf8")) : undefined;
  const app = await createApp({ identity: false, dir: root, key: randomBytes(32), token: "synthetic-owner" });
  const { store } = app, memory = app.runtime.memory;
  // The native infrastructure fixture owns this process; production Core has
  // no process launcher and connects only through the external plugin.
  const service = new ManagedMemoryService(store, memory.ledger, production ? { command: path.join(resources, manifest.python), args: ["-I", "-u"], models: { ...manifest.models, root: resources } } : { command: "uv", args: ["run", "--offline", "--no-project", "--isolated", "--with", "hindsight-all==0.10.3", "python", "-u"], fixture: true });

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
    // Now ingest verbatim synthetic facts through the same genuine engine.
    // Unlike the transport case above these facts must really be searchable
    // and disappear from source records AND native derived storage on forget.
    const remembered = store.createBot("Native隐私来源");
    const binding = store.get("SELECT * FROM memory_bank_bindings WHERE bot_id=?", remembered)!;
    await client.ensure(String(binding.provider_bank_id));
    await client.request(client.bank(String(binding.provider_bank_id)) + "/config", "PATCH", { updates: { retain_extraction_mode: "chunks", enable_observations: false } });
    const doc = memory.write(remembered, { title: "合成隐私", content: "合成代号雪鹭，项目将在星期二举行会议。" });
    const end = Date.now() + 60_000;
    while (store.get("SELECT state FROM memory_bank_bindings WHERE bot_id=?", remembered)?.state !== "ready" && Date.now() < end) { await memory.ledger.flush(); await new Promise((resolve) => setTimeout(resolve, 300)); }
    const recalled = await memory.recall(remembered, "雪鹭会议");
    expect(recalled.facts.some((fact) => fact.text.includes("雪鹭")), JSON.stringify({ recalled, state: store.get("SELECT state FROM memory_bank_bindings WHERE bot_id=?", remembered), transfers: store.all("SELECT status,error_code FROM memory_transfers") })).toBe(true);
    expect((await memory.recall(bot, "雪鹭会议")).facts.some((fact) => fact.text.includes("雪鹭"))).toBe(false);
    const synthesis = await memory.reflect(remembered, "雪鹭何时开会？");
    expect(synthesis.answers.some((answer) => answer.text.includes("星期二") && answer.refs.length > 0)).toBe(true);
    expect(store.all("SELECT * FROM memory_model_invocations WHERE purpose='reflect'").length).toBeGreaterThan(0);
    const plan = memory.privacy.preview(remembered, { documentId: doc.documentId }); memory.forget(remembered, { documentId: doc.documentId }, plan.revision);
    const cleared = Date.now() + 30_000;
    while (store.get("SELECT status FROM memory_forget_rules")?.status !== "completed" && Date.now() < cleared) { await memory.ledger.flush(); await new Promise((resolve) => setTimeout(resolve, 300)); }
    expect(store.get("SELECT status FROM memory_forget_rules")?.status, JSON.stringify({ health: memory.ledger.status(), retirement: store.all("SELECT status FROM memory_bank_retirements"), banks: store.all("SELECT state FROM memory_bank_bindings") })).toBe("completed");
    expect((await memory.recall(remembered, "雪鹭会议")).facts).toEqual([]);
    expect(store.get("SELECT content FROM memory_content WHERE document_id=?", doc.documentId)?.content).toBe("");
    // A late native job cannot resurrect the physically retired bank.
    await expect(client.retain(String(binding.provider_bank_id), (await import("node:crypto")).randomUUID(), { content: "雪鹭旧来源", documentId: "late", timestamp: new Date().toISOString(), metadata: {}, context: "synthetic" })).rejects.toMatchObject({ status: 410 });
    if (production) {
      const firstChild = service.child!;
      const exited = new Promise<void>((resolve) => firstChild.once("exit", () => resolve())); firstChild.kill(); await exited;
      const recovered = Date.now() + 150_000;
      while ((service.state !== "ready" || service.child === firstChild) && Date.now() < recovered) await new Promise((resolve) => setTimeout(resolve, 300));
      expect(service.state, service.diagnostic).toBe("ready"); expect(service.child).not.toBe(firstChild);
      expect((await memory.recall(remembered, "雪鹭会议")).facts).toEqual([]);
      await expect(memory.ledger.client!.retain(String(binding.provider_bank_id), (await import("node:crypto")).randomUUID(), { content: "重启后雪鹭旧来源", documentId: "restart-late", timestamp: new Date().toISOString(), metadata: {}, context: "synthetic" })).rejects.toMatchObject({ status: 410 });
    }
  } finally {
    await service.close(); await app.close(); expect(service.child?.exitCode).toBe(0);
    await new Promise<void>((resolve) => { fake.close(() => resolve()); fake.closeAllConnections(); });
    cleanup(root);
  }
}, 240_000);

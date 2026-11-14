// Fork to topic: the digest of a session's transcript and the route that hands
// it to an assistant as a new private topic. Disposable Core in a temp
// directory and a simulated device; no real session or assistant is touched.
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createPersonalApp } from "../index.ts";
import type { CliItem } from "../../../shared/cli-agents.ts";
import { startFakeModel } from "../../runtime/pi/p0/fake-model.ts";
import { FORK_SUMMARY_LIMIT, summarizeForTopic } from "./fork.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const OWNER = "synthetic-cli-fork-owner";
const CAP = { version: 1, engines: ["claude", "codex"], terminal: { name: "herdr-core", version: "0.1.21", ready: true } };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => T | undefined | null | false, what = "condition", ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await wait(10);
  }
}

const user = (n: number, text: string): CliItem => ({ kind: "user", id: "u" + n, ts: 1000 + n, text });
const assistant = (n: number, text: string): CliItem => ({ kind: "assistant", id: "a" + n, ts: 1000 + n, text });
const tool = (n: number, name: string, input = "{}"): CliItem => ({ kind: "tool", id: "t" + n, ts: 1000 + n, name, input, status: "ok", output: "out" });

describe("summarizeForTopic", () => {
  it("lists user and assistant text and tool names, newest first", () => {
    const summary = summarizeForTopic([user(1, "build it"), tool(2, "Read"), tool(3, "Read"), tool(4, "Bash"), assistant(5, "built"), user(6, "now test")]);
    expect(summary.split("\n")).toEqual(["用户：now test", "助手：built", "工具：Bash、Read×2", "用户：build it"]);
  });

  it("leaves out thinking, notices, turn markers, tool input and output", () => {
    const summary = summarizeForTopic([
      { kind: "thinking", id: "k1", ts: 1, text: "secret reasoning" },
      { kind: "notice", id: "n1", ts: 2, level: "info", text: "a notice" },
      { kind: "turn", id: "m1", ts: 3, phase: "ended" },
      tool(4, "Bash", '{"command":"echo secret-input"}'),
      assistant(5, "   "),
    ]);
    expect(summary).toBe("工具：Bash");
    expect(summarizeForTopic([])).toBe("");
  });

  it("never exceeds the limit, keeps the newest and cuts a single long text", () => {
    const items: CliItem[] = [];
    for (let n = 0; n < 40; n += 1) items.push(n % 2 ? assistant(n, `reply ${n} ${"x".repeat(1500)}`) : user(n, `ask ${n} ${"y".repeat(1500)}`));
    const summary = summarizeForTopic(items);
    expect(summary.length).toBeLessThanOrEqual(FORK_SUMMARY_LIMIT);
    expect(summary.startsWith("助手：reply 39")).toBe(true);
    expect(summary).not.toContain("ask 0 ");
    for (const line of summary.split("\n")) expect(line.length).toBeLessThanOrEqual(2003);
    const single = summarizeForTopic([user(1, "z".repeat(20_000))], 500);
    expect(single.length).toBeLessThanOrEqual(500);
    expect(single.endsWith("…")).toBe(true);
  });

  it("does not split a surrogate pair at the cut", () => {
    const summary = summarizeForTopic([user(1, "😀".repeat(3000))]);
    expect(summary.endsWith("…")).toBe(true);
    expect(() => encodeURIComponent(summary)).not.toThrow();
  });
});

async function ready(items: CliItem[] | ((before?: string) => { items: CliItem[]; more: boolean })) {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-cli-fork-"));
  cleanups.push(() => {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("nex-cli-fork-")) throw Error("Unsafe cleanup");
    rmSync(root, { recursive: true, force: true });
  });
  // A topic input starts a model task; the fake model has no script, so that task simply fails.
  const fake = await startFakeModel();
  cleanups.push(() => fake.close());
  const app = await createPersonalApp({ dir: root, key: randomBytes(32), token: OWNER, identity: false, memoryRuntime: false, hostDevice: false, cliAgents: { graceMs: 0 } });
  cleanups.push(() => app.close());
  app.store.saveConfig({ provider: "openai", endpoint: fake.origin + "/v1", model: "fake", apiKey: "synthetic-model-key" });
  const call = async (route: string, data?: unknown) => {
    const response = await fetch(app.origin + "/api/" + route, { headers: { Authorization: "Bearer " + OWNER, "Content-Type": "application/json" }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) });
    return { status: response.status, data: await response.json() as Record<string, any> };
  };
  const pair = (await call("devices", { name: "fork-device" })).data as { deviceId: string; token: string };
  const ws = new WebSocket(app.origin.replace("http:", "ws:") + "/dcp/v1/connect", { headers: { Authorization: "Bearer " + pair.token } });
  cleanups.push(() => { ws.terminate(); });
  const msgs: Array<Record<string, any>> = [];
  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(raw.toString());
    msgs.push(message);
    if (message.type !== "cli.op") return;
    const page = typeof items === "function" ? items(message.args?.before) : { items, more: false };
    ws.send(JSON.stringify({ type: "cli.reply", opId: message.opId, ok: true, result: message.op === "read" ? page : {} }));
  });
  ws.on("open", () => ws.send(JSON.stringify({
    type: "hello", policyVersion: 1, read: true, exec: true, computer: false, platform: "macos",
    identity: { hostname: "fork-device", supported: ["device.info"] }, cliAgents: CAP,
  })));
  await until(() => msgs.find((m) => m.type === "bound"), "bound");
  ws.send(JSON.stringify({
    type: "cli.sessions", full: true, removes: [], seq: 1,
    upserts: [{ engine: "claude", nativeId: "s1", configDir: "C:/cfg", cwd: "C:/work/proj", title: "fix the parser", state: "idle", lastActivityAt: 1000 }],
  }));
  const key = `${pair.deviceId}:claude:s1`;
  await until(() => app.cliHub.session(key), "session");
  const botId = app.store.createBot("合成助手");
  return { app, call, key, botId };
}

describe("fork route", () => {
  it("creates a private topic holding the digest and leaves the session alone", async () => {
    const { app, call, key, botId } = await ready([user(1, "fix the parser"), tool(2, "Bash", '{"command":"echo secret-input"}'), assistant(3, "fixed it, tests pass")]);
    const forked = await call("cli-agents/fork", { key, botId });
    expect(forked.data).toMatchObject({ botId });
    expect(forked.status).toBe(200);
    expect(forked.data.botId).toBe(botId);
    const conversationId = String(forked.data.conversationId);
    const topic = app.agents.topic(botId, conversationId) as Record<string, any>;
    expect(topic.audience).toBe("private");
    expect(JSON.parse(String(topic.source_context))).toMatchObject({ kind: "cli-agent", key, engine: "claude", title: "fix the parser", cwd: "C:/work/proj" });
    const messages = app.agents.topicMessages(botId, conversationId) as Array<Record<string, any>>;
    const first = String(messages[0].content ?? messages[0].text);
    expect(first).toContain("助手：fixed it, tests pass");
    expect(first).toContain("用户：fix the parser");
    expect(first).toContain("工具：Bash");
    expect(first).not.toContain("secret-input");
    expect(first.indexOf("助手：fixed it")).toBeLessThan(first.indexOf("用户：fix the parser"));
    expect(app.store.get("SELECT COUNT(*) n FROM audit_records WHERE action='cli.fork'")?.n).toBe(1);
    // forking twice makes two topics: nothing is shared or reused
    const again = await call("cli-agents/fork", { key, botId });
    expect(again.status).toBe(200);
    expect(again.data.conversationId).not.toBe(conversationId);
  });

  it("reads back through older pages until the digest is full", async () => {
    const pages = new Map<string | undefined, { items: CliItem[]; more: boolean }>([
      [undefined, { items: [user(5, "newest ask")], more: true }],
      ["u5", { items: [assistant(3, "older reply")], more: false }],
    ]);
    const { app, call, key, botId } = await ready((before) => pages.get(before) ?? { items: [], more: false });
    const forked = await call("cli-agents/fork", { key, botId });
    expect(forked.status).toBe(200);
    const first = String((app.agents.topicMessages(botId, String(forked.data.conversationId)) as Array<Record<string, any>>)[0].content);
    expect(first.indexOf("用户：newest ask")).toBeLessThan(first.indexOf("助手：older reply"));
  });

  it("refuses bad input, an unknown session, an empty transcript and an unknown assistant", async () => {
    const { call, key, botId } = await ready([]);
    expect((await call("cli-agents/fork", { key: "bad", botId })).status).toBe(400);
    expect((await call("cli-agents/fork", { key })).status).toBe(400);
    expect((await call("cli-agents/fork", { key, botId: 5 })).status).toBe(400);
    expect((await call("cli-agents/fork", { key: key.replace(":s1", ":nope"), botId })).status).toBe(404);
    expect((await call("cli-agents/fork", { key, botId })).status).toBe(404);
    const unknown = await call("cli-agents/fork", { key, botId: "no-such-bot" });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(unknown.status).toBeLessThan(500);
  });
});

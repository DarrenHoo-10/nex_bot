// Agent mode supervisor: what it sends, when, and above all when it must not.
// A fake clock drives the timers; the Core is a disposable one in a temp
// directory and the device is simulated, so nothing real is ever continued.
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createPersonalApp } from "../index.ts";
import {
  BOUNDARY_RE, CONTINUE_TEXT, CliAgentSupervisor, RETRY_CAP_MS, STALE_MS, classifyError, detectWait, parseResetTime, retryDelayMs, workspaceScope,
  type SupervisorClock,
} from "./supervisor.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const OWNER = "synthetic-cli-supervisor-owner";
const CAP = { version: 1, engines: ["claude", "codex"], terminal: { name: "herdr-core", version: "0.1.21", ready: true } };
const SECOND = 1000, MINUTE = 60_000, HOUR = 3_600_000;

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

class FakeClock implements SupervisorClock {
  time = Math.floor(Date.now() / 1000) * 1000;
  private nextId = 1;
  private timers = new Map<number, { due: number; callback: () => void }>();
  now() { return this.time; }
  setTimeout(callback: () => void, ms: number) { const id = this.nextId++; this.timers.set(id, { due: this.time + ms, callback }); return id; }
  clearTimeout(handle: unknown) { this.timers.delete(handle as number); }
  pending() { return this.timers.size; }
  /** Moves time forward, firing every timer that falls due on the way, in order. */
  advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.time = Math.max(this.time, next[1].due);
      next[1].callback();
    }
    this.time = target;
  }
}

async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-cli-sup-"));
  cleanups.push(() => {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("nex-cli-sup-")) throw Error("Unsafe cleanup");
    rmSync(root, { recursive: true, force: true });
  });
  const app = await createPersonalApp({ dir: root, key: randomBytes(32), token: OWNER, identity: false, memoryRuntime: false, hostDevice: false, cliAgents: { graceMs: 0 } });
  cleanups.push(() => app.close());
  // the app's own supervisor runs on the real clock; these tests drive their own
  app.cliSupervisor.close();
  const call = async (route: string, data?: unknown, method = data ? "POST" : "GET") => {
    const response = await fetch(app.origin + "/api/" + route, { method, headers: { Authorization: "Bearer " + OWNER, "Content-Type": "application/json" }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, data: await response.json() as Record<string, any> };
  };
  return { app, call };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const wire = (nativeId: string, extra: Record<string, unknown> = {}) => ({
  engine: "claude", nativeId, configDir: "C:/cfg", cwd: "C:/proj", title: "title " + nativeId, state: "idle", lastActivityAt: 1000, ...extra,
});

interface Device {
  id: string;
  msgs: Array<Record<string, any>>;
  onOp: (message: Record<string, any>) => Record<string, any> | undefined;
  send(message: unknown): void;
  sessions(upserts: unknown[], extra?: { full?: boolean }): void;
  ops(op?: string): Array<Record<string, any>>;
}
let seq = 0;

async function connectDevice(f: Fixture, name: string): Promise<Device> {
  const pair = (await f.call("devices", { name })).data as { deviceId: string; token: string };
  const ws = new WebSocket(f.app.origin.replace("http:", "ws:") + "/dcp/v1/connect", { headers: { Authorization: "Bearer " + pair.token } });
  cleanups.push(() => { ws.terminate(); });
  const device: Device = {
    id: String(pair.deviceId), msgs: [],
    onOp: () => ({ ok: true, result: {} }),
    send: (message) => ws.send(JSON.stringify(message)),
    sessions: (upserts, extra = {}) => device.send({ type: "cli.sessions", full: extra.full ?? false, upserts, removes: [], seq: ++seq }),
    ops: (op) => device.msgs.filter((m) => m.type === "cli.op" && (!op || m.op === op)),
  };
  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(raw.toString());
    device.msgs.push(message);
    if (message.type === "cli.op") {
      const reply = device.onOp(message);
      if (reply) device.send({ type: "cli.reply", opId: message.opId, ...reply });
    }
  });
  const failed = new Promise<never>((_, reject) => ws.on("error", reject));
  ws.on("open", () => ws.send(JSON.stringify({
    type: "hello", policyVersion: 1, read: true, exec: true, computer: false, platform: "macos",
    identity: { hostname: name, supported: ["device.info"] }, cliAgents: CAP,
  })));
  await Promise.race([until(() => device.msgs.find((m) => m.type === "bound"), "bound"), failed]);
  return device;
}

const keyOf = (device: Device, nativeId = "s1") => `${device.id}:claude:${nativeId}`;

/** A session on a device whose transcript the test controls. */
async function ready() {
  const f = await fixture();
  const clock = new FakeClock();
  const supervisor = new CliAgentSupervisor(f.app.cliHub, f.app.store, clock);
  cleanups.push(() => supervisor.close());
  const device = await connectDevice(f, "supervised-device");
  device.sessions([wire("s1")], { full: true });
  const key = keyOf(device);
  await until(() => f.app.cliHub.session(key), "session");
  const state = {
    items: [
      { kind: "user", id: "u1", ts: clock.time - 10 * MINUTE, text: "please build the parser" },
      { kind: "assistant", id: "a1", ts: clock.time - SECOND, text: "working on the parser" },
    ] as Array<Record<string, unknown>>,
    readFails: false,
  };
  device.onOp = (message) => {
    if (message.op === "read") return state.readFails ? { ok: false, error: { code: "invalid", message: "no" } } : { ok: true, result: { items: state.items, more: false } };
    if (message.op === "send") return { ok: true, result: { turn: 9, started: true } };
    return { ok: true, result: {} };
  };
  const endTurn = async (turn: number, reason: "end" | "error" | "interrupted", error?: string) => {
    device.send({ type: "cli.turn", ref: "claude:s1", turn, endedAt: clock.time, reason, ...(error ? { error } : {}) });
    await until(() => f.app.cliHub.lastTurn(key)?.turn === turn, "turn " + turn);
  };
  const actions = () => supervisor.actions(50, key).reverse();
  const sent = () => device.ops("send");
  return { f, clock, supervisor, device, key, state, endTurn, actions, sent };
}

describe("rules", () => {
  it("classifies errors", () => {
    expect(classifyError("API Error: 529 overloaded_error")).toBe("transient");
    expect(classifyError("429 Too Many Requests")).toBe("rate_limit");
    expect(classifyError("ECONNRESET")).toBe("transient");
    expect(classifyError("Claude AI usage limit reached|1760000000")).toBe("usage_limit");
    expect(classifyError("401 unauthorized: invalid api key")).toBe("other");
    expect(classifyError("prompt is too long: 250000 tokens")).toBe("other");
    expect(classifyError("something strange")).toBe("other");
    expect(classifyError(undefined)).toBe("other");
  });

  it("backs off 15 s doubling, rate limits four times as long, never over 30 minutes", () => {
    expect([1, 2, 3, 4, 5].map((n) => retryDelayMs(n, false))).toEqual([15_000, 30_000, 60_000, 120_000, 240_000]);
    expect([1, 2, 3].map((n) => retryDelayMs(n, true))).toEqual([60_000, 120_000, 240_000]);
    expect(retryDelayMs(5, true)).toBe(960_000);
    expect(retryDelayMs(9, false)).toBe(RETRY_CAP_MS);
    expect(retryDelayMs(9, true)).toBe(RETRY_CAP_MS);
  });

  it("reads a reset time from a stamp, an ISO time, a duration or a clock time with a zone", () => {
    const at = Date.UTC(2026, 10, 15, 0, 0, 0);
    expect(parseResetTime("Claude AI usage limit reached|1790000000", at)).toBe(1_790_000_000_000);
    expect(parseResetTime("limit resets 2026-11-15T05:30:00Z", at)).toBe(Date.UTC(2026, 10, 15, 5, 30));
    expect(parseResetTime("Usage limit reached. Resets in 2 hours 30 minutes.", at)).toBe(at + 150 * MINUTE);
    expect(parseResetTime("limit reached, try again in 45 minutes", at)).toBe(at + 45 * MINUTE);
    expect(parseResetTime("额度已用完，3小时后重置", at)).toBe(at + 3 * HOUR);
    // 08:00 in Shanghai: 5pm is the same day, 3am is the next one
    expect(parseResetTime("5-hour limit reached, resets 5pm (Asia/Shanghai)", at)).toBe(at + 9 * HOUR);
    expect(parseResetTime("5-hour limit reached, resets 3am (Asia/Shanghai)", at)).toBe(at + 19 * HOUR);
    expect(parseResetTime("usage limit reached", at)).toBeNull();
    expect(parseResetTime("limit reached, resets 5 times", at)).toBeNull();
  });

  it("finds an explicit wait, and nothing else", () => {
    expect(detectWait("编译已提交，等待 10 分钟后继续检查结果。")).toBe(10 * MINUTE);
    expect(detectWait("Deployment started. Waiting for 2 hours before checking.")).toBe(2 * HOUR);
    expect(detectWait("等 90 秒")).toBe(90 * SECOND);
    expect(detectWait("等待 10 分钟后继续吗？")).toBeNull();
    expect(detectWait("wait 5 seconds")).toBeNull();
    expect(detectWait("wait 12 hours")).toBeNull();
    expect(detectWait("all done, 10 minutes of work")).toBeNull();
  });

  it("keeps a boundary list that covers the dangerous verbs", () => {
    for (const word of ["git push origin main", "deploy to production", "部署到线上", "发布新版本", "merge the branch", "发消息给客户", "删除数据库", "充值", "release 1.2"]) {
      expect(BOUNDARY_RE.test(word), word).toBe(true);
    }
    expect(BOUNDARY_RE.test("working on the parser")).toBe(false);
  });

  it("folds workspace folders to one scope", () => {
    expect(workspaceScope("C:\\Proj\\")).toBe("c:/proj");
    expect(workspaceScope("c:/proj")).toBe("c:/proj");
    expect(workspaceScope("/home/Me/proj/")).toBe("/home/Me/proj");
    expect(workspaceScope("/")).toBe("/");
  });
});

describe("transient retry", () => {
  it("sends the fixed text once, 15 seconds after a transient error", async () => {
    const { clock, endTurn, actions, sent } = await ready();
    await endTurn(1, "error", "API Error: 529 overloaded_error");
    expect(actions()).toMatchObject([{ kind: "retry", attempt: 1, status: "pending", turn: 1, dueAt: clock.time + 15 * SECOND }]);
    clock.advance(14 * SECOND);
    await wait(50);
    expect(sent()).toHaveLength(0);
    clock.advance(SECOND);
    await until(() => sent().length === 1, "continue sent");
    expect(sent()[0].args).toMatchObject({ ref: "claude:s1", text: CONTINUE_TEXT });
    expect(actions()[0].status).toBe("sent");
    clock.advance(HOUR);
    await wait(50);
    expect(sent()).toHaveLength(1);
  });

  it("backs off on repeated errors, quadruples rate limits, stops after five, and starts over once a turn ends well", async () => {
    const { clock, endTurn, actions, sent } = await ready();
    const delays: number[] = [];
    for (let turn = 1; turn <= 5; turn += 1) {
      await endTurn(turn, "error", "overloaded");
      const row = actions()[turn - 1];
      expect(row).toMatchObject({ turn, attempt: turn, status: "pending" });
      delays.push(row.dueAt - clock.time);
      clock.advance(HOUR);
      await until(() => sent().length === turn, "sent " + turn);
    }
    expect(delays).toEqual([15_000, 30_000, 60_000, 120_000, 240_000]);
    await endTurn(6, "error", "overloaded");
    expect(actions()[5]).toMatchObject({ status: "skipped", reason: "max_attempts" });
    clock.advance(HOUR);
    await wait(50);
    expect(sent()).toHaveLength(5);

    // a turn that ends well closes the run; the next error is attempt one again
    await endTurn(7, "end");
    expect(actions().filter((row) => row.status === "recovered")).toHaveLength(5);
    await endTurn(8, "error", "429 rate limit exceeded");
    expect(actions()[6]).toMatchObject({ turn: 8, attempt: 1, status: "pending" });
    expect(actions()[6].dueAt - clock.time).toBe(60_000);
  });

  it("records a skip for an error that is not transient, and nothing when the switch is off", async () => {
    const { supervisor, clock, endTurn, actions, sent } = await ready();
    await endTurn(1, "error", "401 unauthorized: invalid api key");
    expect(actions()).toMatchObject([{ status: "skipped", reason: "not_transient" }]);
    supervisor.put("C:/proj", { transientRetry: false });
    await endTurn(2, "error", "overloaded");
    expect(actions()).toHaveLength(1);
    clock.advance(HOUR);
    await wait(50);
    expect(sent()).toHaveLength(0);
  });

  it("does not repeat a turn the device reports twice", async () => {
    const { clock, device, key, f, endTurn, actions, sent } = await ready();
    await endTurn(1, "error", "overloaded");
    const endedAt = f.app.cliHub.lastTurn(key)!.endedAt;
    device.send({ type: "cli.turn", ref: "claude:s1", turn: 1, endedAt, reason: "error", error: "overloaded" });
    await wait(50);
    expect(actions()).toHaveLength(1);
    clock.advance(HOUR);
    await until(() => sent().length === 1, "sent");
    await wait(50);
    expect(sent()).toHaveLength(1);
  });

  it("an interrupted turn is the user's doing and is left alone", async () => {
    const { clock, endTurn, actions, sent } = await ready();
    await endTurn(1, "interrupted");
    expect(actions()).toHaveLength(0);
    clock.advance(HOUR);
    await wait(50);
    expect(sent()).toHaveLength(0);
  });
});

describe("checks before sending", () => {
  const scenarios: Array<{ name: string; reason: string; setup: (ctx: Awaited<ReturnType<typeof ready>>) => Promise<void> | void }> = [
    { name: "the session is running again", reason: "running", setup: (ctx) => ctx.device.sessions([wire("s1", { state: "running" })]) },
    { name: "the session waits for the user", reason: "waiting", setup: (ctx) => ctx.device.sessions([wire("s1", { state: "waiting" })]) },
    { name: "the session lives in a terminal the user holds", reason: "local_session", setup: (ctx) => ctx.device.sessions([wire("s1", { liveIn: "terminal" })]) },
    {
      name: "a permission request is pending", reason: "pending_request",
      setup: (ctx) => ctx.device.send({ type: "cli.request", ref: "claude:s1", id: "r1", kind: "permission", tool: "Bash", summary: "run it", expiresAt: Date.now() + HOUR }),
    },
    { name: "the user typed a moment ago", reason: "recent_input", setup: (ctx) => { ctx.state.items.push({ kind: "user", id: "u2", ts: ctx.clock.time - 30 * SECOND, text: "wait, one more thing" }); } },
    { name: "the transcript moved on after the turn", reason: "activity_after_turn", setup: (ctx) => { ctx.state.items.push({ kind: "assistant", id: "a2", ts: ctx.clock.time + 5 * SECOND, text: "still going" }); } },
    { name: "the last assistant text is about deploying", reason: "boundary", setup: (ctx) => { ctx.state.items.push({ kind: "assistant", id: "a2", ts: ctx.clock.time - 500, text: "Next I will deploy this to production." }); } },
    { name: "the transcript cannot be read", reason: "read_failed", setup: (ctx) => { ctx.state.readFails = true; } },
  ];
  for (const scenario of scenarios) {
    it(`skips when ${scenario.name}`, async () => {
      const ctx = await ready();
      await ctx.endTurn(1, "error", "overloaded");
      await scenario.setup(ctx);
      await wait(100);
      ctx.clock.advance(15 * SECOND);
      await until(() => ctx.actions()[0].status !== "pending", "action settled");
      expect(ctx.actions()[0]).toMatchObject({ status: "skipped", reason: scenario.reason });
      expect(ctx.sent()).toHaveLength(0);
    });
  }

  it("cancels a waiting action when a newer turn arrives", async () => {
    const { clock, endTurn, actions, sent } = await ready();
    await endTurn(1, "error", "overloaded");
    clock.advance(5 * SECOND);
    await endTurn(2, "end");
    expect(actions()[0]).toMatchObject({ status: "cancelled", reason: "newer_turn" });
    clock.advance(HOUR);
    await wait(50);
    expect(sent()).toHaveLength(0);
  });

  it("stops when the switch is turned off while the action waits", async () => {
    const { supervisor, clock, endTurn, actions, sent } = await ready();
    await endTurn(1, "error", "overloaded");
    supervisor.put(undefined, { transientRetry: false });
    expect(actions()[0]).toMatchObject({ status: "cancelled", reason: "disabled" });
    clock.advance(HOUR);
    await wait(50);
    expect(sent()).toHaveLength(0);
  });

  it("does not send again when the device refuses, and marks the action failed", async () => {
    const { clock, device, endTurn, actions, sent } = await ready();
    device.onOp = (message) => message.op === "read" ? { ok: true, result: { items: [], more: false } } : { ok: false, error: { code: "not_in_terminal", message: "no" } };
    await endTurn(1, "error", "overloaded");
    clock.advance(HOUR);
    await until(() => actions()[0].status === "failed", "failed");
    expect(actions()[0].reason).toBe("not_in_terminal");
    clock.advance(HOUR);
    await wait(50);
    expect(sent()).toHaveLength(1);
  });
});

describe("usage limit and wakeup", () => {
  it("waits for the reset time plus a minute, only where the switch is on", async () => {
    const { supervisor, clock, endTurn, actions, sent } = await ready();
    const reset = clock.time + 2 * HOUR;
    const text = `Claude AI usage limit reached|${reset / 1000}`;
    await endTurn(1, "error", text);
    expect(actions()).toHaveLength(0);

    supervisor.put("c:\\PROJ\\", { usageLimit: true });
    await endTurn(2, "error", text);
    expect(actions()).toMatchObject([{ kind: "usage_limit", status: "pending", dueAt: reset + MINUTE }]);
    clock.advance(2 * HOUR);
    await wait(50);
    expect(sent()).toHaveLength(0);
    clock.advance(MINUTE);
    await until(() => sent().length === 1, "continue after reset");
  });

  it("skips a limit that names no reset time or one over a day away", async () => {
    const { supervisor, clock, endTurn, actions, sent } = await ready();
    supervisor.put(undefined, { usageLimit: true });
    await endTurn(1, "error", "usage limit reached");
    await endTurn(2, "error", `usage limit reached|${(clock.time + 30 * HOUR) / 1000}`);
    expect(actions()).toMatchObject([{ status: "skipped", reason: "no_reset_time" }, { status: "skipped", reason: "reset_too_far" }]);
    expect(sent()).toHaveLength(0);
  });

  it("continues after an explicit wait the assistant announced, if wakeup is on", async () => {
    const { supervisor, clock, device, endTurn, actions, sent } = await ready();
    supervisor.put("C:/proj", { wakeup: true });
    device.send({ type: "cli.items", ref: "claude:s1", items: [{ kind: "assistant", id: "a9", ts: clock.time, text: "构建已提交，等待 10 分钟后继续检查结果。" }] });
    await wait(50);
    const endedAt = clock.time;
    await endTurn(1, "end");
    clock.advance(2 * SECOND);
    await until(() => actions().length === 1, "wakeup recorded");
    expect(actions()[0]).toMatchObject({ kind: "wakeup", status: "pending", dueAt: endedAt + 10 * MINUTE });
    clock.advance(10 * MINUTE);
    await until(() => sent().length === 1, "woken");
  });

  it("leaves a finished turn alone when it asks a question, mentions no wait, or wakeup is off", async () => {
    const { supervisor, clock, device, endTurn, actions } = await ready();
    const say = async (id: string, text: string) => {
      device.send({ type: "cli.items", ref: "claude:s1", items: [{ kind: "assistant", id, ts: clock.time, text }] });
      await wait(50);
    };
    await say("a1", "等待 10 分钟后再看。");
    await endTurn(1, "end");
    clock.advance(3 * SECOND);
    await wait(50);
    expect(actions()).toHaveLength(0);
    supervisor.put(undefined, { wakeup: true });
    clock.advance(SECOND);
    await say("a2", "等待 10 分钟后继续吗？");
    await endTurn(2, "end");
    clock.advance(3 * SECOND);
    await wait(50);
    await say("a3", "All done, tests pass.");
    await endTurn(3, "end");
    clock.advance(3 * SECOND);
    await wait(50);
    expect(actions()).toHaveLength(0);
  });
});

describe("settings, persistence and the route", () => {
  it("lets a workspace override the global switches", async () => {
    const { supervisor } = await ready();
    expect(supervisor.settings("C:/proj")).toEqual({ transientRetry: true, usageLimit: false, wakeup: false });
    supervisor.put(undefined, { usageLimit: true });
    supervisor.put("C:/proj", { usageLimit: false, wakeup: true });
    expect(supervisor.settings("C:/proj")).toEqual({ transientRetry: true, usageLimit: false, wakeup: true });
    expect(supervisor.settings("C:/other")).toEqual({ transientRetry: true, usageLimit: true, wakeup: false });
    supervisor.put("C:/proj", null);
    expect(supervisor.settings("C:/proj").wakeup).toBe(false);
  });

  it("re-arms a pending action after a restart, and drops one that went stale while Core was down", async () => {
    const { f, clock, supervisor, endTurn, actions, sent, key } = await ready();
    await endTurn(1, "error", "overloaded");
    supervisor.close();
    const second = new CliAgentSupervisor(f.app.cliHub, f.app.store, clock);
    cleanups.push(() => second.close());
    clock.advance(15 * SECOND);
    await until(() => sent().length === 1, "sent after restart");
    expect(actions()[0].status).toBe("sent");

    await endTurn(2, "error", "overloaded");
    second.close();
    clock.advance(STALE_MS + HOUR);
    const third = new CliAgentSupervisor(f.app.cliHub, f.app.store, clock);
    cleanups.push(() => third.close());
    expect(third.actions(50, key).find((row) => row.turn === 2)).toMatchObject({ status: "cancelled", reason: "stale" });
    expect(clock.pending()).toBe(0);
  });

  it("serves and saves switches over HTTP, for the owner only and with a strict body", async () => {
    const { f } = await ready();
    const first = await f.call("cli-agents/supervision");
    expect(first.status).toBe(200);
    expect(first.data.defaults).toEqual({ transientRetry: true, usageLimit: false, wakeup: false });
    const saved = await f.call("cli-agents/supervision", { cwd: "C:/proj", settings: { wakeup: true } }, "PUT");
    expect(saved.status).toBe(200);
    expect(saved.data.workspaces).toEqual([{ cwd: "C:/proj", settings: { wakeup: true } }]);
    expect((await f.call("cli-agents/supervision", { settings: { usageLimit: true } }, "PUT")).data.global).toEqual({ usageLimit: true });
    expect((await f.call("cli-agents/supervision", { cwd: "C:/proj", settings: null }, "PUT")).data.workspaces).toEqual([]);
    for (const body of [{ settings: { wakeup: "yes" } }, { settings: { other: true } }, { cwd: "relative/dir", settings: {} }, { settings: null }, {}]) {
      expect((await f.call("cli-agents/supervision", body, "PUT")).status, JSON.stringify(body)).toBe(400);
    }
    const anon = await fetch(f.app.origin + "/api/cli-agents/supervision");
    expect(anon.status).toBe(401);
  });
});

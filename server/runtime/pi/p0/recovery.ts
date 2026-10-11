import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { removeTempDir } from "../../../testing/cleanup.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";
import { RecoveryStore, SessionProjection } from "./recovery-store.ts";
import type { WorkerConfig } from "./recovery-worker.ts";

const workerPath = fileURLToPath(new URL("./recovery-worker.ts", import.meta.url));
interface Event { checkpoint?: string; held?: boolean; done?: boolean; error?: string }
interface Exit { code: number | null; signal: NodeJS.Signals | null }

class Worker {
  readonly child: ChildProcess;
  readonly events: Event[] = [];
  readonly exit: Promise<Exit>;
  readonly generation: number;
  private closed = false;
  private stderr = "";
  private wake = new Set<() => void>();
  constructor(store: RecoveryStore, options: Omit<WorkerConfig, "generation">) {
    this.generation = store.claimRun();
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    env.HOME = env.USERPROFILE = options.dir;
    env.PI_CODING_AGENT_DIR = path.join(options.dir, "agent");
    this.child = spawn(process.execPath, ["--experimental-strip-types", workerPath, JSON.stringify({ ...options, generation: this.generation })],
      { cwd: options.dir, env, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8000); });
    this.child.on("message", (event: Event) => { this.events.push(event); this.wake.forEach((fn) => fn()); });
    this.exit = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("close", (code, signal) => {
        this.closed = true;
        store.exited(this.generation);
        this.wake.forEach((fn) => fn());
        resolve({ code, signal });
      });
    });
  }
  async checkpoint(name: string, held = false): Promise<void> {
    const matches = () => this.events.some((event) => event.checkpoint === name && (!held || event.held));
    if (matches()) return;
    await new Promise<void>((resolve, reject) => {
      const inspect = () => {
        const failure = this.events.find((event) => event.error);
        if (matches()) { cleanup(); resolve(); }
        else if (failure || this.closed) { cleanup(); reject(new Error(`worker ${name}: ${failure?.error ?? this.stderr ?? "exited"}`)); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`worker timed out at ${name}: ${this.stderr}`)); }, 30_000);
      const cleanup = () => { clearTimeout(timer); this.wake.delete(inspect); };
      this.wake.add(inspect);
      inspect();
    });
  }
  resume(checkpoint: string): void { this.child.send({ type: "continue", checkpoint }); }
  steer(): void { this.child.send({ type: "steer" }); }
  async kill(): Promise<void> {
    if (!this.closed) this.child.kill("SIGKILL");
    await this.boundedExit();
  }
  private async boundedExit(): Promise<Exit> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.exit, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { this.child.kill("SIGKILL"); reject(new Error(`worker exit timeout: ${this.stderr}`)); }, 30_000);
      })]);
    } finally { clearTimeout(timer); }
  }
  async done(): Promise<void> {
    const result = await this.boundedExit();
    assert.equal(result.code, 0, this.events.find((event) => event.error)?.error ?? this.stderr);
    assert.ok(this.events.some((event) => event.done), "worker completion evidence missing");
  }
}

export interface RecoveryEvidence { crash: string; approval: string; inputs: string }

async function requestReached(fake: FakeModel, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (fake.requests.length < count) {
    assert.ok(Date.now() < deadline, "worker request did not reach the fake server");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function runRecoveryCases(): Promise<RecoveryEvidence> {
  const tempRoot = path.resolve(tmpdir());
  const root = mkdtempSync(path.join(tempRoot, "nex-p0-recovery-"));
  const stores: RecoveryStore[] = [];
  const workers: Worker[] = [];
  const servers: FakeModel[] = [];
  const releases: Array<() => void> = [];
  const fixture = async (name: string) => {
    const dir = path.join(root, name);
    mkdirSync(dir);
    const store = new RecoveryStore(path.join(dir, "core.db")); stores.push(store);
    const fake = await startFakeModel(); servers.push(fake);
    const start = (extra: Partial<WorkerConfig> & { approval?: boolean } = {}) => {
      const { approval, ...config } = extra;
      if (approval !== undefined) store.setApprovalRequired(approval);
      const worker = new Worker(store, { dir, origin: fake.origin, now: 1_700_000_000_000, ...config });
      workers.push(worker);
      return worker;
    };
    const snapshot = () => {
      const projection = new SessionProjection(path.join(dir, "projection.db"));
      try { return projection.load(path.join(dir, "work")); } finally { projection.close(); }
    };
    return { dir, store, fake, start, snapshot };
  };
  try {
    const crash = await fixture("crash");
    const input = crash.store.accept("first", null, "perform the transactional broker operation");
    crash.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "call_stable", name: "broker", args: '{"label":"once"}' }] });
    const orphan = crash.start({ holdAt: "assistant-projected" });
    await orphan.checkpoint("assistant-projected", true);
    assert.equal(crash.store.calls().length, 0);
    assert.equal(crash.store.effectCount(), 0);
    await orphan.kill();
    const w1 = crash.start({ holdAt: "core-result" });
    await w1.checkpoint("core-result", true);
    assert.equal(crash.store.effectCount(), 1);
    const call = crash.store.calls()[0];
    assert.equal(crash.snapshot().getEntries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult").length, 0);
    await w1.kill(); // no throw converted into a tool error by the SDK
    const w2 = crash.start({ holdAt: "sdk-result" });
    await w2.checkpoint("sdk-result", true);
    assert.equal(crash.store.calls()[0].sdk_entry, null);
    await w2.kill(); // result persisted; Core has not acknowledged delivery
    crash.fake.scripts.push({ kind: "openai-text", text: "restored successfully" });
    const w3 = crash.start({ holdAt: "turn-settled" });
    await w3.checkpoint("turn-settled", true);
    await w3.kill(); // model answer persisted; input consumption not committed
    const w4 = crash.start(); await w4.done();
    assert.equal(crash.store.effectCount(), 1);
    assert.equal(crash.store.calls()[0].id, call.id);
    assert.equal(crash.store.calls()[0].args, call.args);
    const results = crash.snapshot().getEntries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
    assert.equal(results.length, 1);
    assert.equal(crash.store.calls()[0].sdk_entry, results[0].id);
    assert.equal(crash.store.inputs()[0].state, "consumed");
    assert.equal(crash.fake.requests.length, 2, "settled answer must not trigger another model request");
    assert.equal(crash.store.task()!.state, "succeeded");
    assert.equal(crash.store.accept("first", null, input.text).id, input.id, "ACK retry must work after task completion");
    assert.throws(() => crash.store.accept("first", null, "changed"), /409/);
    assert.throws(() => crash.store.execute(call.id, w1.generation), /stale/);

    const approval = await fixture("approval");
    approval.store.accept("first", null, "operation requiring approval");
    approval.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "call_approved", name: "broker", args: '{"label":"approved-once"}' }] });
    const waiting = approval.start({ approval: true });
    await waiting.checkpoint("approval-wait");
    const wait = approval.store.task()!;
    const proposed = approval.store.calls()[0];
    assert.equal(approval.store.effectCount(), 0);
    assert.equal(wait.release_after! - wait.wait_started!, 60_000);
    assert.equal(approval.store.releaseDue(wait.release_after! - 1), false);
    assert.equal(approval.store.releaseDue(wait.release_after!), true);
    assert.throws(() => approval.store.claimRun(), /not claimable/);
    await waiting.kill();
    assert.equal(approval.store.task()!.run_state, "released");
    assert.equal(approval.store.task()!.state, "awaiting_approval");
    assert.throws(() => approval.store.execute(proposed.id, waiting.generation), /stale|suspended/);
    assert.throws(() => approval.store.approve(proposed.id, '{}'), /identity conflict/);
    approval.store.approve(proposed.id, proposed.args);
    approval.fake.scripts.push({ kind: "openai-text", text: "approved operation complete" });
    const resumed = approval.start(); await resumed.done();
    assert.notEqual(resumed.generation, waiting.generation);
    assert.equal(approval.store.effectCount(), 1);
    assert.equal(approval.store.calls()[0].id, proposed.id);
    assert.equal(approval.store.calls()[0].entry_id, proposed.entry_id);
    assert.equal(approval.store.calls()[0].args, proposed.args);
    assert.equal(approval.store.task()!.state, "succeeded");

    const shortApproval = await fixture("short-approval");
    shortApproval.store.accept("first", null, "approve within grace period");
    shortApproval.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "call_short", name: "broker", args: '{"label":"short-wait"}' }] },
      { kind: "openai-text", text: "completed in same run" });
    const preProposal = shortApproval.start({ approval: true, holdAt: "assistant-projected" });
    await preProposal.checkpoint("assistant-projected", true);
    await preProposal.kill();
    const shortWorker = shortApproval.start(); // persisted policy still requires approval
    await shortWorker.checkpoint("approval-wait");
    const shortCall = shortApproval.store.calls()[0];
    assert.equal(shortApproval.store.effectCount(), 0);
    shortApproval.store.approve(shortCall.id, shortCall.args);
    shortWorker.child.send({ type: "approved", callId: shortCall.id });
    await shortWorker.done();
    assert.equal(shortApproval.store.effectCount(), 1);
    assert.equal(shortApproval.store.task()!.generation, shortWorker.generation);

    const inputs = await fixture("inputs");
    const first = inputs.store.accept("first", null, "first durable input");
    const projected = inputs.start({ holdAt: "input-projected" });
    await projected.checkpoint("input-projected", true);
    assert.equal(inputs.store.inputs()[0].state, "pending");
    assert.equal(inputs.fake.requests.length, 0);
    await projected.kill();
    assert.equal(inputs.store.accept("first", null, first.text).id, first.id);
    let releaseResponse!: () => void;
    const waitResponse = new Promise<void>((resolve) => { releaseResponse = resolve; });
    releases.push(releaseResponse);
    inputs.fake.scripts.push({ kind: "openai-text", text: "first answer", waitFor: waitResponse });
    const streaming = inputs.start();
    await streaming.checkpoint("model-request");
    await requestReached(inputs.fake, 1);
    const steering = inputs.store.accept("steer", first.task_id, "cancel");
    assert.equal(steering.kind, "steer"); // text is never a cancel command
    streaming.steer(); await streaming.checkpoint("steer-queued");
    await streaming.kill(); // queued only in SDK memory; durable inbox survives
    releaseResponse();
    inputs.fake.scripts.push({ kind: "openai-text", text: "both inputs consumed" }, { kind: "openai-text", text: "late input consumed" });
    const recovered = inputs.start({ holdAt: "before-finish" });
    await recovered.checkpoint("before-finish", true);
    const before = inputs.store.task()!;
    const late = inputs.store.accept("late", first.task_id, "message at completion boundary");
    assert.equal(late.kind, "steer");
    assert.equal(inputs.store.finish(before.version, recovered.generation), false);
    recovered.resume("before-finish");
    await recovered.done();
    assert.equal(inputs.store.task()!.state, "succeeded");
    assert.deepEqual(inputs.store.inputs().map((row) => row.state), ["consumed", "consumed", "consumed"]);
    const entries = inputs.snapshot().getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "nex.input");
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map((entry) => entry.type === "custom_message" ? (entry.details as { inputId: string }).inputId : ""), [first.id, steering.id, late.id]);
    const lastRequest = inputs.fake.requests.at(-1)!.body;
    assert.ok(lastRequest.includes(first.text) && lastRequest.includes(steering.text) && lastRequest.includes(late.text));
    assert.equal(inputs.store.accept("late", first.task_id, late.text).id, late.id);
    assert.throws(() => inputs.store.accept("stale", first.task_id, "new"), /409/);

    // Exercise real SDK steering without a restart as well as recovery of its
    // volatile queue. Both routes must persist the same stable input identity.
    const live = await fixture("live-steering");
    const liveFirst = live.store.accept("first", null, "initial live input");
    let releaseLive!: () => void;
    const liveGate = new Promise<void>((resolve) => { releaseLive = resolve; });
    releases.push(releaseLive);
    live.fake.scripts.push({ kind: "openai-text", text: "initial answer", waitFor: liveGate }, { kind: "openai-text", text: "steered answer" });
    const liveWorker = live.start();
    await requestReached(live.fake, 1);
    const liveSteer = live.store.accept("steer", liveFirst.task_id, "additional live instruction");
    liveWorker.steer();
    await liveWorker.checkpoint("steer-queued");
    releaseLive();
    await liveWorker.done();
    assert.equal(live.fake.requests.length, 2);
    assert.ok(live.fake.requests[1].body.includes(liveSteer.text));
    assert.deepEqual(live.store.inputs().map((row) => row.state), ["consumed", "consumed"]);
    assert.equal(live.snapshot().getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "nex.input").length, 2);

    const fence = await fixture("paused-request");
    fence.store.accept("first", null, "request paused before dispatch");
    const fencedWorker = fence.start({ holdAt: "model-request" });
    await fencedWorker.checkpoint("model-request", true);
    fence.store.db.prepare("UPDATE task SET state='paused',version=version+1 WHERE singleton=1").run();
    fencedWorker.resume("model-request");
    await assert.rejects(() => fencedWorker.done(), /model did not finish successfully/);
    assert.equal(fence.fake.requests.length, 0);
    assert.equal(fence.store.inputs()[0].state, "applied");

    return {
      crash: "hardKills=4 orphanProposalRecovered=1 effects=1 sdkResults=1 resultAckRecovered=1 settledReplyReused=1 staleRunBlocked=1 pausedRequestBlocked=1",
      approval: "releaseDeltaMs=60000 earlyRelease=0 workerExited=1 preApprovalEffects=0 resumedNewRun=1 sameCall=1 effects=1 shortApprovalSameRun=1 policySurvivesRestart=1",
      inputs: "firstInputCrashRecovered=1 ackRetry=1 queuedSteerCrashRecovered=1 uniqueInputs=3 consumed=3 finishRaceGuarded=1 textNotCommand=1 liveSteerConsumed=1",
    };
  } finally {
    releases.forEach((release) => release());
    for (const worker of workers) await worker.kill();
    for (const fake of servers) await fake.close();
    stores.forEach((store) => store.close());
    assert.equal(path.dirname(path.resolve(root)), tempRoot);
    assert.ok(path.basename(root).startsWith("nex-p0-recovery-"));
    await removeTempDir(root);
  }
}

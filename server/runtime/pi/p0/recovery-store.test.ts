import { afterEach, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RecoveryStore, SessionProjection } from "./recovery-store.ts";

const stores: Array<{ close(): void }> = [];
afterEach(() => { stores.splice(0).forEach((store) => store.close()); });
function fixture() {
  const store = new RecoveryStore(":memory:"); stores.push(store);
  const input = store.accept("first", null, "first input");
  store.setApprovalRequired(true);
  const generation = store.claimRun();
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "provider-call", name: "broker", arguments: { label: "once" } }],
    api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const call = store.propose(manager, "provider-call", { label: "once" }, generation, 1000);
  return { store, input, generation, call };
}

it("persists a first custom input before any model or native user message", () => {
  const projection = new SessionProjection(":memory:"); stores.push(projection);
  const manager = projection.load(process.cwd());
  const entryId = manager.appendCustomMessageEntry("nex.input", "first input", false, { inputId: "stable-id" });
  projection.save(manager);
  const reopened = projection.load(process.cwd());
  expect(reopened.getSessionId()).toBe(manager.getSessionId());
  expect(reopened.getEntry(entryId)).toMatchObject({ type: "custom_message", details: { inputId: "stable-id" }, content: "first input" });
  expect(reopened.buildSessionContext().messages).toHaveLength(1);
});

it("blocks duplicate workers and execution before approval, then fences the old generation", () => {
  const { store, generation, call } = fixture();
  expect(() => store.claimRun()).toThrow("not claimable");
  expect(() => store.execute(call.id, generation)).toThrow("suspended");
  expect(store.releaseDue(60_999)).toBe(false);
  expect(store.releaseDue(61_000)).toBe(true);
  store.approve(call.id, call.args);
  expect(() => store.claimRun()).toThrow("not claimable");
  store.exited(generation);
  const next = store.claimRun();
  expect(() => store.execute(call.id, generation)).toThrow("stale");
  expect(store.execute(call.id, next).id).toBe(call.id);
  expect(store.execute(call.id, next).id).toBe(call.id);
  expect(store.effectCount()).toBe(1);
});

it("new input invalidates pending approval instead of interpreting consent text as approval", () => {
  const { store, input, call } = fixture();
  const supplement = store.accept("supplement", input.task_id, "同意");
  expect(supplement.kind).toBe("supplement");
  expect(store.task()?.state).toBe("paused");
  expect(store.calls()[0].state).toBe("cancelled");
  expect(() => store.approve(call.id, call.args)).toThrow("no longer valid");
  expect(store.effectCount()).toBe(0);
});

it("does not invalidate approval when merely retrying the original input ACK", () => {
  const { store, input, call } = fixture();
  expect(store.accept("first", null, input.text).id).toBe(input.id);
  expect(store.task()?.state).toBe("awaiting_approval");
  expect(store.calls()[0].id).toBe(call.id);
  expect(store.calls()[0].state).toBe("pending");
});

it("new input cancels an approved call before execution, including while the worker is releasing", () => {
  const { store, input, generation, call } = fixture();
  store.releaseDue(61_000);
  store.approve(call.id, call.args);
  const supplement = store.accept("new-after-approval", input.task_id, "use a different file");
  expect(supplement.kind).toBe("supplement");
  expect(store.calls()[0].state).toBe("cancelled");
  expect(() => store.execute(call.id, generation)).toThrow("suspended");
  expect(store.task()?.state).toBe("paused");
  expect(store.effectCount()).toBe(0);
});

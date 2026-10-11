import { describe, expect, it, vi } from "vitest";
import { recordBrokerCall, type BrokerState, type ToolSource } from "./broker-state.ts";
import { createFixtureFetch } from "./network.ts";

const source: ToolSource = { runtimeSessionId: "session", assistantEntryId: "entry", providerToolCallId: "call" };
const empty = (): BrokerState => ({ count: 0, calls: {}, executes: 0 });

describe("fixture tool identity", () => {
  it("replays a persisted source once and preserves its Core call id after reload", () => {
    const state = empty();
    const first = recordBrokerCall(state, source, { label: "once" });
    const reopened: BrokerState = JSON.parse(JSON.stringify(state));
    expect(recordBrokerCall(reopened, source, { label: "once" })).toEqual({ callId: first.callId, deduped: true });
    expect(reopened.count).toBe(1);
  });

  it.each(["runtimeSessionId", "assistantEntryId", "providerToolCallId"] as const)("keeps identical arguments independent when %s differs", (field) => {
    const state = empty();
    const first = recordBrokerCall(state, source, { label: "once" });
    const second = recordBrokerCall(state, { ...source, [field]: "different" }, { label: "once" });
    expect(second.deduped).toBe(false);
    expect(second.callId).not.toBe(first.callId);
    expect(state.count).toBe(2);
  });

  it("rejects argument substitution on a replay without changing the receipt", () => {
    const state = empty();
    recordBrokerCall(state, source, { label: "once" });
    const before = JSON.stringify(state);
    expect(() => recordBrokerCall(state, source, { label: "changed" })).toThrow("different arguments");
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("fixture network isolation", () => {
  it.each([
    "https://api.example.org/v1", "http://127.0.0.1:81230/v1",
    "http://127.0.0.1:8124/v1", "http://localhost:8123/v1",
    "http://127.0.0.1:8123@api.example.org/v1",
    "http://user:pass@127.0.0.1:8123/v1",
  ])("refuses %s without invoking the transport", async (url) => {
    const dispatch = vi.fn<typeof fetch>();
    const guarded = createFixtureFetch("http://127.0.0.1:8123", dispatch);
    await expect(guarded(url)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("forces redirect rejection for strings, URL and Request inputs", async () => {
    const dispatch = vi.fn<typeof fetch>().mockResolvedValue(new Response("fixture"));
    const guarded = createFixtureFetch("http://127.0.0.1:8123", dispatch);
    for (const input of ["http://127.0.0.1:8123/v1", new URL("http://127.0.0.1:8123/v1"), new Request("http://127.0.0.1:8123/v1")]) {
      await guarded(input, { redirect: "follow", method: "POST" });
      expect(dispatch).toHaveBeenLastCalledWith(input, { redirect: "error", method: "POST" });
    }
  });
});

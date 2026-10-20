// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { State } from "./api";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), api: fixture.api }));
vi.mock("./auth", () => ({ useAccount: () => ({ status: {}, logout: vi.fn() }), AccountControls: () => null }));
import { AgentDesktop } from "./AgentDesktop";

let root: Root, container: HTMLDivElement;
const sync = { cursor: 1, privacyEpoch: 1, coreId: "fixture", bootId: "boot" };
let state: State;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
  state = {
    sync, bots: [{ id: "agent", name: "Fixture", instructions: "" }],
    conversations: [], approvals: [], memories: [], delegations: [], devices: [], tasks: [], onlineDevices: [],
    routines: [], occurrences: [], journal: [], dataDir: "", address: "", lanEnabled: false,
    node: { status: "", origin: "", root: "", exec: false, connected: false, unknownCalls: [] },
  };
  localStorage.clear();
  localStorage.setItem("nexbot.selectedAgent", "agent");
  fixture.api.mockReset().mockImplementation(async (route: string) => {
    if (route === "state") return state;
    if (route.startsWith("agents/messages")) return { sync, messages: [], streaming: [], hasMore: false };
    return {};
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(AgentDesktop)); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function composer() { return container.querySelector<HTMLTextAreaElement>(".composer textarea")!; }
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(composer(), text);
    composer().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function enter(options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", ...options });
  await act(async () => { composer().dispatchEvent(event); });
  return event;
}

describe("Personal composer (Web, Electron and Android WebView)", () => {
  it("expands the real model settings in the notice and keeps the conversation and draft", async () => {
    await type("保留的草稿");
    const toggle = container.querySelector<HTMLButtonElement>(".model-chooser-notice button")!;
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".model-chooser-notice [data-model-settings]")).not.toBeNull();
    expect(container.querySelector(".preferences-page")).toBeNull();
    expect(composer().value).toBe("保留的草稿");
    await act(async () => { toggle.click(); });
    expect(container.querySelector("[data-model-settings]")).toBeNull();
    expect(composer().value).toBe("保留的草稿");
  });

  it("does not submit an IME confirmation or Shift+Enter, and sends after the 150ms guard", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    await type("中文消息");
    await enter({ isComposing: true });
    await act(async () => { composer().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); });
    vi.mocked(Date.now).mockReturnValue(2_149);
    await enter();
    expect(fixture.api.mock.calls.some(([route]) => route === "agents/input")).toBe(false);
    vi.mocked(Date.now).mockReturnValue(2_150);
    expect((await enter({ shiftKey: true })).defaultPrevented).toBe(false);
    expect(fixture.api.mock.calls.some(([route]) => route === "agents/input")).toBe(false);
    await enter();
    expect(fixture.api).toHaveBeenCalledWith("agents/input", expect.objectContaining({ text: "中文消息" }));
  });
});

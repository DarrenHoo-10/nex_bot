// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { State } from "./api";
const fixture = vi.hoisted(() => ({ api: vi.fn(), listModels: vi.fn() }));
vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), api: fixture.api, listModels: fixture.listModels }));
import { ModelVisibility } from "./ModelVisibility";

const models = ["claude-opus-4-7", "claude-opus-5", "gpt-5", "gpt-5-mini"];
const state = (selection: string[] | null) => ({ config: { provider_id: "openai", endpoint: "https://api.example.test/v1", default_model: "gpt-5" }, modelVisibility: { models: selection, version: 3 } }) as unknown as State;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.api.mockReset(); fixture.listModels.mockReset();
  fixture.listModels.mockResolvedValue({ models, hasMore: false });
  fixture.api.mockImplementation(async (_route: string, body: { models: string[] | null }) => ({ models: body.models, version: 4 }));
  // The test DOM has no popover API.
  HTMLElement.prototype.showPopover ??= function () {}; HTMLElement.prototype.hidePopover ??= function () {};
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

async function open(selection: string[] | null) {
  await act(async () => root.render(createElement(ModelVisibility, { state: state(selection), refresh: async () => {}, active: true, scope: { provider: "openai", endpoint: "https://api.example.test/v1" } })));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="选择显示的模型"]')!.click());
}
const bulk = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".model-list-bulk button")].find(button => button.textContent === label)!;
const search = async (text: string) => {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索模型"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); });
};

describe("显示的模型 select all / none", () => {
  it("clears every model with 全不选 and shows them all again with 全选", async () => {
    await open(["gpt-5"]);
    await act(async () => bulk("全不选").click());
    expect(fixture.api).toHaveBeenLastCalledWith("models/visibility", { provider: "openai", endpoint: "https://api.example.test/v1", models: [], version: 3 });
    await act(async () => bulk("全选").click());
    expect(fixture.api).toHaveBeenLastCalledWith("models/visibility", expect.objectContaining({ models: null }));
  });
  it("applies to the search results only while searching", async () => {
    await open(["gpt-5"]);
    await search("opus");
    await act(async () => bulk("全选").click());
    expect(new Set(fixture.api.mock.lastCall![1].models)).toEqual(new Set(["gpt-5", "claude-opus-4-7", "claude-opus-5"]));
  });
  it("disables 全选 when everything shown is already selected", async () => {
    await open(null);
    expect(bulk("全选").disabled).toBe(true);
    expect(bulk("全不选").disabled).toBe(false);
  });
});

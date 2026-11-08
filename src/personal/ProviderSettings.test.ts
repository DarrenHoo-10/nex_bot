// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection, State } from "./api";
const fixture = vi.hoisted(() => ({ api: vi.fn(), listConnectionModels: vi.fn() }));
vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), api: fixture.api, listConnectionModels: fixture.listConnectionModels }));
import { ProviderSettings } from "./ProviderSettings";
import { ModelMenu, type ModelChoice } from "./components/ModelMenu";
import { ImageModelSettings } from "./ImageModelSettings";

const connection = (patch: Partial<Connection> = {}): Connection => ({ id: "default", name: "CPA", provider: "anthropic", endpoint: "https://api.example.test/cpa", defaultModel: "claude-opus-5-5", enabled: true, isDefault: true, configured: true, version: 3, models: null, modelsVersion: 2, options: {}, ...patch });
const second = connection({ id: "zhipu", name: "智谱", provider: "openai", endpoint: "https://api.example.test/zhipu/v1", defaultModel: "glm-5.3", isDefault: false, version: 1, models: ["glm-5.3", "glm-5.3-air"], modelsVersion: 4, options: { "glm-5.3": { imageInput: true, reasoning: ["low", "high"], version: 1 } } });
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.api.mockReset(); fixture.listConnectionModels.mockReset();
  fixture.listConnectionModels.mockResolvedValue({ models: ["claude-opus-5-5", "claude-sonnet-5-5", "grok-4.7-build-fast"], hasMore: false });
  fixture.api.mockImplementation(async (route: string, body: Record<string, unknown>) => route === "models/visibility" ? { models: body.models, version: 3 } : route === "connections/save" ? { id: "new-one" } : route === "models/limits" ? { manual: { contextWindow: null, maxOutputTokens: null }, automatic: { contextWindow: 200000, maxOutputTokens: 32000 }, capabilities: { reasoning: true, imageInput: true } } : {});
  HTMLElement.prototype.showPopover ??= function () {}; HTMLElement.prototype.hidePopover ??= function () {};
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const refresh = vi.fn(async () => {});
const mount = (connections: Connection[]) => act(async () => root.render(createElement(ProviderSettings, { state: { connections } as unknown as State, refresh, active: true })));
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label)!;
const type = async (input: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });

describe("设置 → 模型: providers", () => {
  it("lists providers, shows the chosen one and adds a new one", async () => {
    await mount([connection(), second]);
    expect([...container.querySelectorAll(".provider-list button")].map(item => item.textContent)).toEqual(["CPA默认", "智谱", "添加供应商"]);
    expect(container.querySelector(".provider-heading h3")?.textContent).toBe("CPA");
    await act(async () => button("智谱").click());
    expect(container.querySelector(".provider-heading h3")?.textContent).toBe("智谱");
    await act(async () => button("添加供应商").click());
    const [name, endpoint] = [...container.querySelectorAll<HTMLInputElement>(".provider-form input:not([type=password])")];
    await type(name, "新供应商"); await type(endpoint, "https://api.example.test/new/v1");
    await type(container.querySelector<HTMLInputElement>(".provider-form input[type=password]")!, "synthetic-key");
    await act(async () => container.querySelector<HTMLFormElement>(".provider-form")!.requestSubmit());
    expect(fixture.api).toHaveBeenCalledWith("connections/save", { name: "新供应商", provider: "openai", endpoint: "https://api.example.test/new/v1", apiKey: "synthetic-key" });
  });

  it("enables models per provider with 全选 / 全不选 and sets the default model", async () => {
    await mount([connection(), second]);
    expect(fixture.listConnectionModels).toHaveBeenCalledWith("default");
    expect(container.querySelector(".provider-models-bar")?.textContent).toContain("3 个模型 · 已启用 3");
    await act(async () => button("全不选").click());
    expect(fixture.api).toHaveBeenLastCalledWith("models/visibility", { connectionId: "default", models: [], version: 2 });
    await act(async () => button("全选").click());
    expect(fixture.api).toHaveBeenLastCalledWith("models/visibility", expect.objectContaining({ connectionId: "default", models: null }));
    await act(async () => button("设为默认模型：grok-4.7-build-fast").click());
    expect(fixture.api).toHaveBeenLastCalledWith("connections/save", expect.objectContaining({ id: "default", version: 3, defaultModel: "grok-4.7-build-fast" }));
  });

  it("edits a model's image input, limits and reasoning levels, starting from the catalog", async () => {
    await mount([connection()]);
    await act(async () => button("编辑 claude-sonnet-5-5").click());
    const checks = () => Object.fromEntries([...container.querySelectorAll<HTMLLabelElement>(".provider-model-checks label")].map(label => [label.textContent, label.querySelector("input")!.checked]));
    expect(checks()).toEqual({ "支持图片输入": true, "低": true, "中": true, "高": true, "很高": false, "最高": false });
    await act(async () => [...container.querySelectorAll<HTMLLabelElement>(".provider-model-checks label")].find(label => label.textContent === "最高")!.querySelector("input")!.click());
    await type(container.querySelector<HTMLInputElement>(".provider-model-limits input")!, "500000");
    await act(async () => container.querySelector<HTMLFormElement>(".provider-model-editor")!.requestSubmit());
    expect(fixture.api).toHaveBeenCalledWith("connections/model", { connectionId: "default", model: "claude-sonnet-5-5", version: 0, imageInput: true, reasoning: ["low", "medium", "high", "max"], contextWindow: "500000", maxOutputTokens: null });
  });

  it("keeps the default provider enabled and undeletable", async () => {
    await mount([connection(), second]);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="启用供应商"]')!.disabled).toBe(true);
    await act(async () => button("更多操作").click());
    expect(button("删除供应商").disabled).toBe(true);
  });
});

describe("Provider-reported model names", () => {
  const proxy = connection({ names: { "claude-fable-5-dd-6.4-korg": "Grok 4.6" } });
  it("shows the name with the id under it in settings, and searches both", async () => {
    fixture.listConnectionModels.mockResolvedValue({ models: ["claude-fable-5-dd-6.4-korg", "claude-opus-5-5"], hasMore: false, names: { "claude-opus-5-5": "Claude Opus 5.5" } });
    await mount([proxy]);
    const labels = () => [...container.querySelectorAll(".provider-model-label")].map(label => [label.querySelector(".provider-model-name")!.textContent, label.querySelector(".provider-model-id")?.textContent ?? null]);
    expect(labels()).toEqual([["Grok 4.6", "claude-fable-5-dd-6.4-korg"], ["Claude Opus 5.5", "claude-opus-5-5"]]);
  });
  it("shows the name in the chat menu and still saves the id", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(createElement(ModelMenu, { connections: [{ ...proxy, models: ["claude-fable-5-dd-6.4-korg"] }], choice: { connectionId: "default", model: "", reasoning: null }, onChange, label: "驱动模型" })));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="驱动模型"]')!.click());
    const row = [...document.querySelectorAll<HTMLButtonElement>(".model-menu-list .model-menu-row")].find(item => item.title === "claude-fable-5-dd-6.4-korg")!;
    expect(row.textContent).toBe("Grok 4.6");
    await act(async () => row.click());
    expect(onChange).toHaveBeenCalledWith({ connectionId: "default", model: "claude-fable-5-dd-6.4-korg", reasoning: null });
  });
});

describe("生图模型", () => {
  it("uses an OpenAI-compatible provider that is not the default one", async () => {
    const openai = connection({ id: "cpa", name: "cpa", provider: "openai", isDefault: false, imageModels: { models: [], version: 0 } });
    fixture.listConnectionModels.mockResolvedValue({ models: ["gpt-image-2", "glm-5.3"], hasMore: false });
    fixture.api.mockImplementation(async (_route: string, body: { models: string[] }) => ({ models: body.models, version: 1 }));
    await act(async () => root.render(createElement(ImageModelSettings, { state: { connections: [connection(), openai] } as unknown as State, refresh, active: true })));
    expect(container.querySelector(".preferences-status")?.textContent).toBe("已选 0 个");
    expect(fixture.listConnectionModels).toHaveBeenCalledWith("cpa");
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="选择生图模型"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLElement>(".model-option")].find(option => option.textContent === "gpt-image-2")!.click());
    expect(fixture.api).toHaveBeenCalledWith("models/images", { connectionId: "cpa", models: ["gpt-image-2"], version: 0 });
  });
  it("asks for an OpenAI-compatible provider when there is none", async () => {
    await act(async () => root.render(createElement(ImageModelSettings, { state: { connections: [connection()] } as unknown as State, refresh, active: true })));
    expect(container.querySelector(".preferences-status")?.textContent).toBe("需要 OpenAI 兼容的供应商");
  });
});

describe("Chat model menu", () => {
  const open = async (choice: ModelChoice, onChange = vi.fn()) => {
    await act(async () => root.render(createElement(ModelMenu, { connections: [connection(), second], choice, onChange, label: "驱动模型" })));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="驱动模型"]')!.click());
    return onChange;
  };
  const rows = () => [...document.querySelectorAll(".model-menu-list .model-menu-row")].map(row => row.textContent);

  it("lists the provider's models, switches provider and picks a model", async () => {
    const onChange = await open({ connectionId: "default", model: "", reasoning: null });
    expect(document.querySelector(".model-menu-provider")?.textContent).toBe("CPAAnthropic");
    expect(rows()).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "grok-4.7-build-fast"]);
    expect(document.querySelector(".model-menu-effort")).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>(".model-menu-provider")!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".model-menu-row")].find(row => row.textContent?.startsWith("智谱"))!.click());
    expect(rows()).toEqual(["glm-5.3视觉", "glm-5.3-air"]);
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".model-menu-row")].find(row => row.textContent === "glm-5.3-air")!.click());
    expect(onChange).toHaveBeenCalledWith({ connectionId: "zhipu", model: "glm-5.3-air", reasoning: null });
  });

  it("offers only the model's reasoning levels and saves the slider when released", async () => {
    const onChange = await open({ connectionId: "zhipu", model: "glm-5.3", reasoning: "max" });
    expect([...document.querySelectorAll(".model-menu-stops span")].map(stop => stop.textContent)).toEqual(["关闭", "低", "高"]);
    expect(document.querySelector(".model-menu-effort-label strong")?.textContent).toBe("高");
    const slider = document.querySelector<HTMLInputElement>('input[aria-label="思考强度"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "1"); slider.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => { slider.dispatchEvent(new Event("pointerup", { bubbles: true })); });
    expect(onChange).toHaveBeenCalledWith({ connectionId: "zhipu", model: "glm-5.3", reasoning: "low" });
  });
});

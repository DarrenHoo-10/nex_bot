// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RetrievalView } from "./RetrievalSettings";

const f = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./api", () => ({ api: f.api }));
import { RetrievalSettings, retrievalStatus } from "./RetrievalSettings";

const empty = { version: 0, default: null, custom: null };
const initial: RetrievalView = {
  embedding: { source: "default", model: "Qwen/Qwen3-Embedding-8B", version: 0, default: { model: "Qwen/Qwen3-Embedding-8B" }, custom: null },
  rerank: { source: "disabled", ...empty },
};
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  f.api.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(createElement(RetrievalSettings, { active: true })));
const form = (label: string) => host.querySelector<HTMLFormElement>(`form[aria-label="${label}"]`)!;
const submit = (target: HTMLFormElement) => act(async () => { target.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
const fill = (target: HTMLFormElement, values: Record<string, string>) => { for (const [name, value] of Object.entries(values)) (target.elements.namedItem(name) as HTMLInputElement).value = value; };

it("labels the effective source per item, and shows a default by its model name only", () => {
  expect(retrievalStatus(initial.embedding)).toBe("默认 · Qwen/Qwen3-Embedding-8B");
  expect(retrievalStatus(initial.rerank)).toBe("未启用");
  expect(retrievalStatus({ source: "custom", model: "", format: "tei", ...empty })).toBe("自定义 · TEI");
});
it("shows the two models with their own fields, no address or key for a default, and no explanatory text", async () => {
  f.api.mockResolvedValue(initial);
  await render();
  expect(f.api).toHaveBeenCalledWith("memory/retrieval");
  expect(host.querySelector("h3")!.textContent).toBe("记忆检索");
  expect(Array.from(host.querySelectorAll("h4")).map((item) => item.textContent)).toEqual(["向量模型", "重排模型"]);
  const embedding = form("向量模型"), rerank = form("重排模型");
  expect(embedding.textContent).toContain("默认 · Qwen/Qwen3-Embedding-8B");
  expect(rerank.textContent).toContain("未启用");
  for (const name of ["baseUrl", "model", "dimensions", "apiKey", "enabled"]) expect(embedding.elements.namedItem(name), name).toBeTruthy();
  expect(embedding.elements.namedItem("format")).toBeNull();
  for (const name of ["baseUrl", "model", "format", "apiKey", "enabled"]) expect(rerank.elements.namedItem(name), name).toBeTruthy();
  expect(rerank.elements.namedItem("dimensions")).toBeNull();
  expect((embedding.elements.namedItem("baseUrl") as HTMLInputElement).value).toBe("");
  expect(host.querySelector("p")).toBeNull();
  expect(Array.from(host.querySelectorAll("button")).some((button) => button.textContent === "使用默认")).toBe(false);
});
it("saves one item with the version it showed, then shows the stored settings without the key", async () => {
  f.api.mockResolvedValueOnce(initial);
  await render();
  const saved: RetrievalView = { ...initial, embedding: { source: "custom", model: "my-embed", version: 1, default: initial.embedding.default, custom: { enabled: true, baseUrl: "https://embed.example/v1", model: "my-embed", dimensions: 1024, hasKey: true } } };
  f.api.mockResolvedValueOnce(saved);
  fill(form("向量模型"), { baseUrl: "https://embed.example/v1", model: "my-embed", dimensions: "1024", apiKey: "sk-typed" });
  await submit(form("向量模型"));
  expect(f.api).toHaveBeenLastCalledWith("memory/retrieval", { kind: "embedding", version: 0, enabled: true, baseUrl: "https://embed.example/v1", model: "my-embed", apiKey: "sk-typed", dimensions: 1024 });
  expect(host.textContent).toContain("自定义 · my-embed");
  expect(host.textContent).toContain("已保存");
  const embedding = form("向量模型");
  expect((embedding.elements.namedItem("baseUrl") as HTMLInputElement).value).toBe("https://embed.example/v1");
  expect((embedding.elements.namedItem("apiKey") as HTMLInputElement).value).toBe("");
  expect((embedding.elements.namedItem("apiKey") as HTMLInputElement).placeholder).toBe("留空保留已保存的 Key");
  expect(host.textContent).not.toContain("sk-typed");
  // The other item is untouched.
  expect(host.textContent).toContain("未启用");
});
it("sends the rerank format and shows the server's reason when the test request fails", async () => {
  f.api.mockResolvedValueOnce(initial);
  await render();
  f.api.mockRejectedValueOnce(new Error("测试请求失败：重排服务返回 500"));
  fill(form("重排模型"), { baseUrl: "https://rerank.example/v1", model: "", format: "tei" });
  await submit(form("重排模型"));
  expect(f.api).toHaveBeenLastCalledWith("memory/retrieval", { kind: "rerank", version: 0, enabled: true, baseUrl: "https://rerank.example/v1", model: "", apiKey: "", format: "tei" });
  expect(host.querySelector('[role="alert"]')!.textContent).toBe("测试请求失败：重排服务返回 500");
  expect(host.textContent).not.toContain("已保存");
});
it("returns to the default through a reset when custom settings exist", async () => {
  const custom: RetrievalView = { ...initial, embedding: { source: "custom", model: "my-embed", version: 3, default: initial.embedding.default, custom: { enabled: true, baseUrl: "https://embed.example/v1", model: "my-embed", dimensions: null, hasKey: false } } };
  f.api.mockResolvedValueOnce(custom);
  await render();
  f.api.mockResolvedValueOnce(initial);
  const reset = Array.from(form("向量模型").querySelectorAll("button")).find((button) => button.textContent === "使用默认")!;
  await act(async () => reset.click());
  expect(f.api).toHaveBeenLastCalledWith("memory/retrieval", { kind: "embedding", version: 3, reset: true });
  expect(host.textContent).toContain("默认 · Qwen/Qwen3-Embedding-8B");
});

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CoreView } from "./CoreMemoryEditor";

const f = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./api", async () => ({ ...(await vi.importActual<object>("./api")), api: f.api }));
import { CoreMemoryEditor, parseAbout, parseTopics, topicLine } from "./CoreMemoryEditor";

const bots = [{ id: "b1", name: "助手甲" }, { id: "b2", name: "助手乙" }];
const initial: CoreView = {
  limit: 1500, tokens: 42,
  bot: { version: 3, content: { about: ["称呼：小明"], topics: [{ title: "部署", line: "周五上线", ref: "memory:abc" }] } },
  workspace: { version: 0, content: { about: [], topics: [] } },
};
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  f.api.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (active = true) => act(async () => root.render(createElement(CoreMemoryEditor, { bots, active })));
const form = (label: string) => host.querySelector<HTMLFormElement>(`form[aria-label="${label}"]`)!;
const area = (target: HTMLFormElement, name: string) => target.elements.namedItem(name) as HTMLTextAreaElement;
const submit = (target: HTMLFormElement) => act(async () => { target.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });

it("reads topic lines as the rendered '标题 — 一句话 (memory:<id>)' and back", () => {
  const topics = [{ title: "部署", line: "周五上线", ref: "memory:abc" }, { title: "咖啡", line: "喜欢拿铁 — 少糖", ref: "" }];
  expect(topics.map(topicLine)).toEqual(["部署 — 周五上线 (memory:abc)", "咖啡 — 喜欢拿铁 — 少糖"]);
  expect(parseTopics(topics.map(topicLine).join("\n"))).toEqual(topics);
  expect(parseTopics("- 部署 — 周五上线 (episode:e-1)\n\n")).toEqual([{ title: "部署", line: "周五上线", ref: "episode:e-1" }]);
  expect(() => parseTopics("只有标题")).toThrow("标题 — 一句话");
  expect(parseAbout("- 甲\n\n乙 \r\n")).toEqual(["甲", "乙"]);
});

it("shows the stored lines of the chosen assistant and of the workspace, with the token use, and no explanatory text", async () => {
  f.api.mockResolvedValue(initial);
  await render();
  expect(f.api).toHaveBeenCalledWith("memory/core?botId=b1");
  expect(host.querySelector("h3")!.textContent).toBe("核心记忆");
  expect(host.textContent).toContain("42 / 1500 Token");
  expect(Array.from(host.querySelectorAll("h4")).map((item) => item.textContent)).toEqual(["助手甲", "共享"]);
  expect(area(form("助手甲"), "about").value).toBe("称呼：小明");
  expect(area(form("助手甲"), "topics").value).toBe("部署 — 周五上线 (memory:abc)");
  expect(area(form("共享"), "about").value).toBe("");
  expect(host.querySelector("p")).toBeNull();
  // Another assistant loads its own memory.
  f.api.mockResolvedValue({ ...initial, bot: { version: 0, content: { about: [], topics: [] } } });
  await act(async () => { const select = host.querySelector<HTMLSelectElement>("select")!; select.value = "b2"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(f.api).toHaveBeenLastCalledWith("memory/core?botId=b2");
  expect(area(form("助手乙"), "about").value).toBe("");
});

it("saves one scope with the version it showed and then shows what was stored", async () => {
  f.api.mockResolvedValueOnce(initial);
  await render();
  const saved: CoreView = { ...initial, tokens: 60, bot: { version: 4, content: { about: ["称呼：小明", "语言：中文"], topics: [{ title: "部署", line: "周五晚上线", ref: "memory:abc" }] } } };
  f.api.mockResolvedValueOnce(saved);
  area(form("助手甲"), "about").value = "称呼：小明\n语言：中文";
  area(form("助手甲"), "topics").value = "部署 — 周五晚上线 (memory:abc)";
  await submit(form("助手甲"));
  expect(f.api).toHaveBeenLastCalledWith("memory/core", { botId: "b1", scope: "bot", about: ["称呼：小明", "语言：中文"], topics: [{ title: "部署", line: "周五晚上线", ref: "memory:abc" }], version: 3 });
  expect(host.textContent).toContain("60 / 1500 Token"); expect(host.textContent).toContain("已保存");
  expect(area(form("助手甲"), "about").value).toBe("称呼：小明\n语言：中文");
  // The workspace is saved on its own, with its own version.
  f.api.mockResolvedValueOnce({ ...saved, workspace: { version: 1, content: { about: ["全员共享"], topics: [] } } });
  area(form("共享"), "about").value = "全员共享";
  await submit(form("共享"));
  expect(f.api).toHaveBeenLastCalledWith("memory/core", { botId: "b1", scope: "workspace", about: ["全员共享"], topics: [], version: 0 });
  expect(area(form("共享"), "about").value).toBe("全员共享");
});

it("shows the server's refusal (cap or stale version) and a line that is not a topic without saving it", async () => {
  f.api.mockResolvedValueOnce(initial);
  await render();
  f.api.mockRejectedValueOnce(new Error("核心记忆超过 1500 Token（改后约 1700）。请合并相近的行"));
  await submit(form("助手甲"));
  expect(host.querySelector("[role=alert]")!.textContent).toContain("超过 1500 Token");
  expect(area(form("助手甲"), "about").value).toBe("称呼：小明");
  f.api.mockClear();
  area(form("助手甲"), "topics").value = "只有标题没有说明";
  await submit(form("助手甲"));
  expect(f.api).not.toHaveBeenCalled();
  expect(host.querySelector("[role=alert]")!.textContent).toContain("标题 — 一句话");
});

it("loads nothing while its page is not shown", async () => {
  await render(false);
  expect(f.api).not.toHaveBeenCalled();
});

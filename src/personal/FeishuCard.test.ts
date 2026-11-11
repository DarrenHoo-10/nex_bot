import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { FeishuCard } from "./FeishuCard";
import type { State } from "./api";

vi.mock("./api", () => ({ api: vi.fn() }));

function render(bots: State["bots"], financeBotId?: string) {
  return renderToStaticMarkup(createElement(FeishuCard, {
    state: { bots, feishu: { apps: [] } },
    financeBotId, refresh: async () => {},
  }));
}

it("enables registration for the displayed receiver and prefers the finance role", () => {
  const bots = [{ id: "first", name: "One" }, { id: "finance", name: "Renamed" }];
  expect(render(bots, "finance")).toMatch(/<option value="finance" selected=""/);
  const single = render(bots.slice(0, 1));
  expect(single).toMatch(/<option value="first" selected=""/);
  expect(single).toMatch(/<button class="primary">扫码连接飞书/);
  expect(render([])).toMatch(/<button class="primary" disabled="">扫码连接飞书/);
});

it("renders a low-density Web QR and retains the full provider link for direct opening", () => {
  vi.stubGlobal("window", { location: new URL("https://nexbot.example.test") });
  try {
    const url = "https://accounts.feishu.cn/fixture?addons=" + "x".repeat(1800);
    const job = { stage: "qr", url, scanPath: "/feishu/s/" + "a".repeat(22) };
    const html = renderToStaticMarkup(createElement(FeishuCard, {
      state: { bots: [], feishu: { apps: [], job } }, refresh: async () => {},
    }));
    expect(html).toContain('href="' + url + '"');
    const modulesIncludingMargin = Number(/viewBox="0 0 (\d+) \d+"/.exec(html)?.[1]);
    expect(modulesIncludingMargin).toBeGreaterThan(20);
    expect(modulesIncludingMargin).toBeLessThan(50);
  } finally { vi.unstubAllGlobals(); }
});

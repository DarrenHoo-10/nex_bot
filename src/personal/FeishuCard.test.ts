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

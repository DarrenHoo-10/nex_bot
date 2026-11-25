import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { FeishuCard } from "./FeishuCard";
import type { State } from "./api";

vi.mock("./api", () => ({ api: vi.fn() }));

function render(bots: State["bots"]) {
  return renderToStaticMarkup(createElement(FeishuCard, {
    state: { bots, feishu: { apps: [] } },
    refresh: async () => {},
  }));
}

it("requires an explicit receiver even when there is only one assistant", () => {
  const single = render([{ id: "finance", name: "金融助手" }]);
  expect(single).toContain('<option value="" selected="">请选择助手');
  expect(single).toContain('<option value="finance">金融助手');
  expect(single).toMatch(/<button class="primary" disabled="">扫码创建应用/);
  expect(single).toContain('<button disabled="">使用已有应用');
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

it("lists each connected app with its bot identity and keeps adding behind a button", async () => {
  const { FeishuCard: Card } = await import("./FeishuCard");
  const app = { id: "c1", appId: "cli_one", brand: "feishu", status: "connected", error: null, ownerBound: true, botId: "b", botName: "金融助手", enabled: true, version: 1, userAuthorized: false, userScopes: [], userExpiresAt: null, name: "Nex 金融", avatarUrl: "https://s1-imfile.feishucdn.com/avatar.png", groupCount: 2 };
  const html = renderToStaticMarkup(createElement(Card, { state: { bots: [{ id: "b", name: "金融助手" }], feishu: { apps: [app, { ...app, id: "c2", appId: "cli_two", name: "工作小助手", status: "error", error: "App Secret 已失效" }] } }, refresh: async () => {} }));
  expect(html).toContain("Nex 金融");
  expect(html).toContain('src="https://s1-imfile.feishucdn.com/avatar.png"');
  expect(html).toContain("cli_one · 接收助手 金融助手 · 2 个群");
  expect(html).toContain("App Secret 已失效");
  expect(html).toContain("添加飞书应用");
  expect(html).not.toContain("扫码创建应用");
});

it("summarises a group's reply mode and labels Feishu topics by their group", async () => {
  const { feishuGroupSummary } = await import("./FeishuAppDetail");
  const { topicSource } = await import("./FinanceTopics");
  const group = { chatId: "oc_1", name: "投研群", kind: "group" as const, members: 5, claimed: true, trigger: "ambient" as const, session: "chat-topic" as const, context: "先给结论", version: 2 };
  expect(feishuGroupSummary(group)).toBe("普通群 · 5 人 · 默认应答 · 群聊共享，话题独立 · 已设上下文");
  expect(feishuGroupSummary({ ...group, kind: "topic", claimed: false })).toBe("话题群 · 5 人 · 未开放");
  const topic = { conversationId: "t", title: "x", audience: "public" as const, last_activity_at: 0, message_count: 1, unread_count: 0, activeTask: null };
  expect(topicSource({ ...topic, sourceContext: { channel: "feishu", chatName: "投研群" } })).toBe("飞书 · 投研群");
  expect(topicSource({ ...topic, audience: "private", sourceContext: { channel: "feishu", chatType: "p2p" } })).toBe("飞书私聊");
  expect(topicSource({ ...topic, audience: "private", sourceContext: {} })).toBe("私人话题");
});

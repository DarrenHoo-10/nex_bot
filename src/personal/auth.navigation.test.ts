// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn(), desktop: undefined as undefined | { mode: string } }));
vi.mock("./api", () => ({ api: fixture.api, get desktop() { return fixture.desktop; } }));
import { LoginGate } from "./auth";

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  history.replaceState(null, "", "/");
  fixture.desktop = undefined;
  fixture.api.mockReset().mockResolvedValue({ authenticated: true, initialized: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(createElement(LoginGate, { children: createElement("textarea", { "aria-label": "草稿", defaultValue: "未发送的消息" }) })));
async function navigate(hash: string) {
  await act(async () => { history.pushState(null, "", hash); window.dispatchEvent(new HashChangeEvent("hashchange")); });
}

it("returns home without logout and restores the same draft when reentering the workspace", async () => {
  await render();
  const draft = host.querySelector("textarea")!;
  draft.value = "继续编辑的草稿";
  await navigate("#home");
  expect(host.querySelector(".home")).not.toBeNull();
  expect(draft.parentElement!.style.display).toBe("none");
  expect(host.querySelector(".login-form")).toBeNull();
  expect(host.querySelector('.home-nav-actions a')?.getAttribute("href")).toBe("#workspace");
  await navigate("#platforms");
  expect(host.querySelector(".home")).not.toBeNull();
  await navigate("#workspace");
  expect(host.querySelector(".home")).toBeNull();
  expect(host.querySelector("textarea")).toBe(draft);
  expect(draft.value).toBe("继续编辑的草稿");
  expect(draft.parentElement!.style.display).toBe("contents");
  expect(fixture.api.mock.calls.map(([route]) => route)).toEqual(["auth/status"]);
});
it("restores an authenticated homepage after refresh and still checks session expiry", async () => {
  history.replaceState(null, "", "/#platforms");
  await render();
  expect(host.querySelector(".home")).not.toBeNull();
  fixture.api.mockResolvedValue({ authenticated: false, initialized: true });
  await act(async () => window.dispatchEvent(new Event("nex-session-expired")));
  expect(host.querySelector("textarea")).toBeNull();
  expect(host.querySelector(".login-form")).not.toBeNull();
});
it("keeps native client shells in their workspace even with a homepage fragment", async () => {
  fixture.desktop = { mode: "client" };
  history.replaceState(null, "", "/#home");
  await render();
  expect(host.querySelector(".home")).toBeNull();
  expect(host.querySelector("textarea")?.parentElement!.style.display).toBe("contents");
});

it("uses manifest downloads for all four clients and keeps source links out of the homepage", async () => {
  const downloads = Object.fromEntries(["windows", "android", "mac", "ios"].map((platform, index) => [platform, {
    version: `1.2.${index}`, url: `https://downloads.example.test/${platform}`, publishedAt: "2026-10-25T12:00:00Z",
  }]));
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => downloads } as Response);
  history.replaceState(null, "", "/#home");
  await render();
  for (const { url, version } of Object.values(downloads)) {
    expect(host.querySelector(`.home-platforms a[href="${url}"]`)?.textContent).toContain(version);
  }
  expect(host.querySelectorAll(".home-platforms > a").length).toBe(5);
  expect(host.querySelector('.home-platforms a[href="#workspace"]')).not.toBeNull();
  expect(host.textContent).not.toContain("需从源码构建");
  expect(host.querySelector('a[href*="tree/main/apps/apple"]')).toBeNull();
});

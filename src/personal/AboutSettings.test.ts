// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientUpdateState } from "./api";

const f = vi.hoisted(() => ({ desktop: undefined as undefined | {
  updateState: ReturnType<typeof vi.fn>; checkUpdate: ReturnType<typeof vi.fn>; installUpdate: ReturnType<typeof vi.fn>;
  onUpdateState: (callback: (state: ClientUpdateState) => void) => () => void;
} }));
vi.mock("./api", () => ({ get desktop() { return f.desktop; } }));
import { AboutSettings } from "./AboutSettings";
let root: Root, host: HTMLDivElement, emit: (state: ClientUpdateState) => void;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  f.desktop = {
    updateState: vi.fn().mockResolvedValue({ status: "idle", current: "0.9.14" }),
    checkUpdate: vi.fn().mockResolvedValue({ status: "current", current: "0.9.14" }),
    installUpdate: vi.fn().mockResolvedValue(undefined),
    onUpdateState: callback => { emit = callback; return () => {}; },
  };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(createElement(AboutSettings)));
const click = () => act(async () => host.querySelector("button")!.click());

it("shows the installed version and reports current only after a successful check", async () => {
  await render();
  expect(host.textContent).toContain("0.9.14");
  expect(host.textContent).not.toContain("已是最新版");
  await click();
  expect(f.desktop!.checkUpdate).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("已是最新版");
});
it("disables duplicate checks, follows download progress and requires a separate install click", async () => {
  let resolve!: (state: ClientUpdateState) => void;
  f.desktop!.checkUpdate.mockImplementation(() => new Promise(r => { resolve = r; }));
  await render(); await click();
  expect(host.querySelector("button")!.disabled).toBe(true);
  await act(async () => emit({ status: "downloading", current: "0.9.14", version: "0.9.15", progress: .5 }));
  expect(host.textContent).toContain("50%");
  await act(async () => resolve({ status: "ready", current: "0.9.14", version: "0.9.15" }));
  expect(host.textContent).toContain("新版本 0.9.15 已就绪");
  expect(f.desktop!.installUpdate).not.toHaveBeenCalled();
  await click(); expect(f.desktop!.installUpdate).toHaveBeenCalledTimes(1);
});
it("shows an error and allows retry instead of claiming up to date", async () => {
  f.desktop!.checkUpdate.mockRejectedValueOnce(new Error("离线"));
  await render(); await click();
  expect(host.textContent).toContain("离线");
  expect(host.textContent).not.toContain("已是最新版");
  expect(host.querySelector("button")!.disabled).toBe(false);
  await click(); expect(host.textContent).toContain("已是最新版");
  expect(host.textContent).not.toContain("离线");
});
it("does not overwrite a newer event with a stale initial state", async () => {
  let resolve!: (state: ClientUpdateState) => void;
  f.desktop!.updateState.mockImplementation(() => new Promise(r => { resolve = r; }));
  await render();
  await act(async () => emit({ status: "ready", current: "0.9.14", version: "0.9.15" }));
  await act(async () => resolve({ status: "idle", current: "0.9.14" }));
  expect(host.textContent).toContain("立即更新");
});
it("identifies the web edition without inventing a client version or update button", async () => {
  f.desktop = undefined; await render();
  expect(host.textContent).toContain("网页版");
  expect(host.textContent).not.toContain("当前版本");
  expect(host.querySelector("button")).toBeNull();
});
it("shows the version of an unsupported installation without offering a broken check", async () => {
  f.desktop!.updateState.mockResolvedValue({ status: "unsupported", current: "0.9.14-local" });
  await render();
  expect(host.textContent).toContain("0.9.14-local");
  expect(host.querySelector("button")).toBeNull();
});

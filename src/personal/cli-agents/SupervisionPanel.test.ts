// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliApiError } from "./api";

const fixture = vi.hoisted(() => ({ fetchSupervision: vi.fn(), saveSupervision: vi.fn() }));
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), ...fixture }));

import { SupervisionPanel } from "./SupervisionPanel";

let root: Root;
let container: HTMLDivElement;

const view = (settings: Partial<Record<"transientRetry" | "usageLimit" | "wakeup", boolean>> = {}, extra: { overrides?: number; pending?: number } = {}) =>
  ({ settings: { transientRetry: true, usageLimit: false, wakeup: false, ...settings }, overrides: 0, pending: 0, ...extra });
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const click = (element: Element | null) => act(async () => { (element as HTMLElement).click(); });
const gear = () => container.querySelector<HTMLButtonElement>("button[aria-label=自动处理设置]")!;
const switches = () => [...container.querySelectorAll<HTMLElement>("[role=switch]")];
const states = () => switches().map((entry) => entry.getAttribute("aria-checked"));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.fetchSupervision.mockReset();
  fixture.saveSupervision.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function openPanel() {
  await act(async () => { root.render(createElement(SupervisionPanel)); });
  await click(gear());
  await flush();
}

describe("supervision panel", () => {
  it("reads nothing until it is opened, then shows the real state of each switch", async () => {
    fixture.fetchSupervision.mockResolvedValue(view({ usageLimit: true }));
    await act(async () => { root.render(createElement(SupervisionPanel)); });
    expect(fixture.fetchSupervision).not.toHaveBeenCalled();
    expect(container.querySelector("[role=dialog]")).toBeNull();
    await click(gear());
    await flush();
    expect(fixture.fetchSupervision).toHaveBeenCalledTimes(1);
    expect([...container.querySelectorAll(".cli-switch-row span")].map((entry) => entry.textContent)).toEqual(["临时错误后自动继续", "额度恢复后继续", "唤醒"]);
    expect(states()).toEqual(["true", "true", "false"]);
    expect(container.querySelector("p")).toBeNull();
  });

  it("saves the flipped switch and shows what Core answers", async () => {
    fixture.fetchSupervision.mockResolvedValue(view());
    fixture.saveSupervision.mockResolvedValue(view({ wakeup: true }));
    await openPanel();
    await click(switches()[2]);
    await flush();
    expect(fixture.saveSupervision).toHaveBeenCalledWith({ wakeup: true });
    expect(states()).toEqual(["true", "false", "true"]);
  });

  it("turns a switch off with the opposite value", async () => {
    fixture.fetchSupervision.mockResolvedValue(view());
    fixture.saveSupervision.mockResolvedValue(view({ transientRetry: false }));
    await openPanel();
    await click(switches()[0]);
    await flush();
    expect(fixture.saveSupervision).toHaveBeenCalledWith({ transientRetry: false });
    expect(states()[0]).toBe("false");
  });

  it("keeps the old state and says why when saving fails", async () => {
    fixture.fetchSupervision.mockResolvedValue(view());
    fixture.saveSupervision.mockRejectedValue(new CliApiError("x", "disabled", 403));
    await openPanel();
    await click(switches()[1]);
    await flush();
    expect(states()).toEqual(["true", "false", "false"]);
    expect(container.querySelector("[role=alert]")?.textContent).toContain("重试");
    expect(container.querySelector("[role=alert]")?.textContent?.length).toBeGreaterThan(2);
  });

  it("offers a retry when reading fails", async () => {
    fixture.fetchSupervision.mockRejectedValueOnce(new CliApiError("x", "device_offline", 502));
    await openPanel();
    expect(switches()).toHaveLength(0);
    expect(container.querySelector("[role=alert]")?.textContent).toContain("电脑离线");
    fixture.fetchSupervision.mockResolvedValue(view());
    await click([...container.querySelectorAll("button")].find((entry) => entry.textContent === "重试") ?? null);
    await flush();
    expect(switches()).toHaveLength(3);
  });

  it("reports pending actions and folders with their own settings", async () => {
    fixture.fetchSupervision.mockResolvedValue(view({}, { pending: 2, overrides: 1 }));
    await openPanel();
    expect(container.querySelector(".cli-supervision-status")?.textContent).toBe("2 项待执行1 个目录单独设置");
  });

  it("closes on Escape and on a click elsewhere", async () => {
    fixture.fetchSupervision.mockResolvedValue(view());
    await openPanel();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(container.querySelector("[role=dialog]")).toBeNull();
    await click(gear());
    await flush();
    expect(container.querySelector("[role=dialog]")).not.toBeNull();
    await act(async () => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    expect(container.querySelector("[role=dialog]")).toBeNull();
  });
});

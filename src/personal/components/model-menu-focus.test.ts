// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Connection } from "../api";
import { CliModelMenu } from "../cli-agents/CliModelMenu";
import { ModelMenu } from "./ModelMenu";
import { ModelPicker } from "./ModelPicker";

const { state } = vi.hoisted(() => ({ state: { compact: false } }));
vi.mock("./use-compact-composer", () => ({ useCompactComposer: () => state.compact }));
vi.mock("../cli-agents/api", async (original) => ({
  ...await original<typeof import("../cli-agents/api")>(),
  fetchModels: async () => ({ models: models.map((id) => ({ id, label: id })) }),
}));

const models = Array.from({ length: 12 }, (_, index) => `fixture-${index}`);
const connection: Connection = {
  id: "fixture", name: "Fixture", provider: "openai", endpoint: "https://fixture.example.test",
  defaultModel: models[0], enabled: true, configured: true, isDefault: true, version: 1,
  models, modelsVersion: 1, options: {},
};
const noop = () => {};
const menus = [
  { name: "NexAgent", make: () => createElement(CliModelMenu, { deviceId: "fixture", engine: "claude", live: true, choice: { model: "", effort: "" }, onChange: noop }) },
  { name: "供应商模型", make: () => createElement(ModelMenu, { connections: [connection], choice: { connectionId: connection.id, model: "", reasoning: null }, onChange: noop }) },
  { name: "模型设置", make: () => createElement(ModelPicker, { value: models[0], models, onChange: noop }) },
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  HTMLElement.prototype.showPopover ??= function () {};
  HTMLElement.prototype.hidePopover ??= function () {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

it.each(menus)("opens $name on a compact layout without entering the search field", async ({ make }) => {
  state.compact = true;
  await act(async () => { root.render(make()); });
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
  await act(async () => { trigger.click(); });
  const panel = container.querySelector('[role="dialog"]');
  const search = panel?.querySelector<HTMLInputElement>('input[aria-label="搜索模型"]');
  expect(search).toBeTruthy();
  expect(document.activeElement).toBe(panel);
  search?.focus();
  expect(document.activeElement).toBe(search);
  await act(async () => { search?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it.each(menus.slice(1))("preserves desktop search focus in $name", async ({ make }) => {
  state.compact = false;
  await act(async () => { root.render(make()); });
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
  await act(async () => { trigger.click(); });
  expect(document.activeElement).toBe(container.querySelector('input[aria-label="搜索模型"]'));
});

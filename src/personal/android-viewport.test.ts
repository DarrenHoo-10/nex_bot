import { expect, it, vi } from "vitest";
import { installViewportHeight } from "./android-viewport";

function fakeHost(innerHeight: number, visual?: number) {
  const listeners = new Map<string, () => void>(), visualListeners = new Map<string, () => void>();
  const host = {
    innerHeight, addEventListener: (type: string, fn: () => void) => { listeners.set(type, fn); },
    visualViewport: visual === undefined ? null : { height: visual, addEventListener: (type: string, fn: () => void) => { visualListeners.set(type, fn); } },
  };
  return { host, listeners, visualListeners };
}
const rootStyle = () => { const values = new Map<string, string>(); return { style: { setProperty: (name: string, value: string) => { values.set(name, value); } } as unknown as CSSStyleDeclaration, values }; };

it("publishes one percent of the height and follows resizes", () => {
  const { host, listeners } = fakeHost(800), root = rootStyle();
  installViewportHeight(host as never, root);
  expect(root.values.get("--nex-vh")).toBe("8px");
  host.innerHeight = 500; listeners.get("resize")!();
  expect(root.values.get("--nex-vh")).toBe("5px");
});
it("prefers the visual viewport, which shrinks with the keyboard", () => {
  const { host, visualListeners } = fakeHost(800, 480), root = rootStyle();
  installViewportHeight(host as never, root);
  expect(root.values.get("--nex-vh")).toBe("4.8px");
  (host.visualViewport as { height: number }).height = 760; visualListeners.get("resize")!();
  expect(root.values.get("--nex-vh")).toBe("7.6px");
});
it("never publishes a zero height, which would collapse the layout again", () => {
  const { host } = fakeHost(0), root = rootStyle(), set = vi.spyOn(root.style, "setProperty");
  installViewportHeight(host as never, root);
  expect(set).not.toHaveBeenCalled();
});

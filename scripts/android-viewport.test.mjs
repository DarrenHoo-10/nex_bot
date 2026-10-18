import { expect, it } from "vitest";
import { androidViewportUnits, rewriteViewportUnits } from "./android-viewport.mjs";

const v = "calc(var(--nex-vh, 1vh) * ";

it("rewrites every vertical viewport unit to the published height", () => {
  expect(rewriteViewportUnits("height: 100dvh;")).toBe(`height: ${v}100);`);
  expect(rewriteViewportUnits("a{max-height:92dvh}b{min-height:100svh}c{top:12vh}d{x:50lvh}")).toBe(`a{max-height:${v}92)}b{min-height:${v}100)}c{top:${v}12)}d{x:${v}50)}`);
  expect(rewriteViewportUnits("max-height: min(360px, calc(100dvh - 220px));")).toBe(`max-height: min(360px, calc(${v}100) - 220px));`);
  expect(rewriteViewportUnits("height: 12.5dvh")).toBe(`height: ${v}12.5)`);
});

it("leaves widths, other units and unrelated names alone", () => {
  const css = "width: min(650px, calc(100vw - 32px)); height: 50%; --uvh: 3px; font: 16px/1.5 x;";
  expect(rewriteViewportUnits(css)).toBe(css);
});

it("the plugin only touches stylesheets", () => {
  const plugin = androidViewportUnits();
  expect(plugin.enforce).toBe("pre");
  expect(plugin.transform("const x = '100dvh'", "/src/a.ts")).toBeNull();
  expect(plugin.transform("a{color:red}", "/src/a.css")).toBeNull();
  expect(plugin.transform("a{height:100dvh}", "/src/a.css?inline").code).toContain("--nex-vh");
});

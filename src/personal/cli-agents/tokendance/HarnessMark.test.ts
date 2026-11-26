// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HarnessMark } from "./HarnessMark";
import { resolveHarnessBrand } from "./harnessBrand";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("HarnessMark", () => {
  it("resolves Antigravity aliases to the agy harness brand", () => {
    for (const key of ["agy", "antigravity", "Antigravity CLI", "google-antigravity"]) {
      const brand = resolveHarnessBrand(key);
      expect(brand.id).toBe("agy");
      expect(brand.known).toBe(true);
    }
  });

  it("renders the Antigravity SVG mark instead of the fallback letter A", () => {
    act(() => {
      root.render(
        createElement(
          "div",
          null,
          createElement(HarnessMark, { agentId: "agy", size: "sm" }),
          createElement(HarnessMark, { agentId: "antigravity", size: "md" }),
        ),
      );
    });

    const marks = Array.from(container.querySelectorAll(".harness-mark"));
    expect(marks).toHaveLength(2);
    for (const mark of marks) {
      expect(mark.getAttribute("data-harness")).toBe("agy");
      expect(mark.querySelector("svg")).not.toBeNull();
      expect(mark.querySelector("b")).toBeNull();
    }

    const clipIds = marks.map((mark) => mark.querySelector("clipPath")?.getAttribute("id"));
    expect(clipIds[0]).toBeTruthy();
    expect(clipIds[1]).toBeTruthy();
    expect(clipIds[0]).not.toBe(clipIds[1]);
  });
});

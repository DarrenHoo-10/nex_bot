// The app-wide `button` rule (personal.css) centres flex content. Tree rows are
// buttons, so without an override a short title drifts right and the tree
// looks indented at random. Vitest does not load CSS, so this reads the file.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./workbench.css", import.meta.url)), "utf8");
/** The declarations of the first rule written exactly as `selector{…}`. */
function rule(selector: string): string {
  const start = css.indexOf(selector + "{");
  return start < 0 ? "" : css.slice(start + selector.length + 1, css.indexOf("}", start));
}

describe("workbench tree styles", () => {
  it("starts every session row at the left edge whatever the title length", () => {
    const row = rule(".na-stage .cli-app .cli-row .cli-row-main");
    expect(row).toContain("justify-content:flex-start");
    expect(row).toContain("flex:1");
  });
});

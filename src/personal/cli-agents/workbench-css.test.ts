// The app-wide `button` rule (personal.css) centres flex content. Tree rows are
// buttons, so without an override a short title drifts right and the tree
// looks indented at random. Vitest does not load CSS, so this reads the file.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./workbench.css", import.meta.url)), "utf8");
const themeCss = readFileSync(fileURLToPath(new URL("../theme.css", import.meta.url)), "utf8");
/** The declarations of the first rule written exactly as `selector{…}`. */
function rule(selector: string, source = css): string {
  const start = source.indexOf(selector + "{");
  return start < 0 ? "" : source.slice(start + selector.length + 1, source.indexOf("}", start));
}

describe("workbench tree styles", () => {
  it("starts every session row at the left edge whatever the title length", () => {
    const row = rule(".na-stage .cli-app .cli-row .cli-row-main");
    expect(row).toContain("justify-content:flex-start");
    expect(row).toContain("flex:1");
  });

  it("indents the earlier-history toggle to align with session rows on desktop and touch", () => {
    const older = rule(".na-stage .cli-app .na-older");
    expect(older).toContain("padding:0 6px 0 19px");
    expect(themeCss).toMatch(/\.na-stage\s+\.cli-app\s+\.na-older\s*\{[^}]*padding:\s*2px 8px 2px 25px/);
    expect(themeCss).toMatch(/@media\s*\(pointer:\s*coarse\)\s*\{\s*\.na-stage\s+\.cli-app\s+\.na-older\s*\{[^}]*min-height:\s*36px/);
  });
});

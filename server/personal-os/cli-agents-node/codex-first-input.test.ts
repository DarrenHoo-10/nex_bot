import { describe, expect, it } from "vitest";
import { codexEmptyComposer } from "./codex-first-input.ts";

const prompt = "› Ask Codex to do anything";
const status = "  GPT-6.2-Astra xhigh fast · D:\\work\\example · Example session";
const shortcuts = "  ← for agents · ? for shortcuts";
const warning = "⚠ 2 warnings · f2 to view";
const hints = `${shortcuts}                       ${warning}`;

describe("Codex empty input box", () => {
  it.each([
    ["two-line footer with warnings", [status, hints]],
    ["compact footer", [status, shortcuts]],
    ["separate warning row", [status, warning]],
    ["warning on the model row", [`${status}    ${warning}`]],
    ["shortcut-only footer", ["  ? for shortcuts"]],
    ["context footer", ["  92% context left", hints]],
    ["status split before its path", ["  GPT-6.2-Astra xhigh fast ·", "  D:\\work\\example · Example session", hints]],
  ] as const)("recognizes %s", (_layout, footer) => {
    expect(codexEmptyComposer([prompt, "", ...footer].join("\r\n"), 120)).not.toBeNull();
  });

  it("accepts an indented title continuation only at the terminal margin", () => {
    const screen = [prompt, status, "  continued title", hints].join("\n");
    expect(codexEmptyComposer(screen, status.length)).not.toBeNull();
    expect(codexEmptyComposer(screen, 120)).toBeNull();
  });

  it.each([
    ["single-line draft", ["› keep my draft", status, hints]],
    ["multiline draft starting with placeholder text", [prompt, "  keep my second line", status, hints]],
    ["indented chevron in a draft", ["› keep this", `  ${prompt}`, status, hints]],
    ["footer-like draft", [prompt, status, shortcuts, status, hints]],
    ["history above a picker", [prompt, status, "› 1. Trust this folder", hints]],
    ["approval overlay", [prompt, status, hints, "  Enter to confirm · Esc to cancel"]],
    ["running turn", ["Working · esc to interrupt", prompt, status, hints]],
    ["unknown overlay", [prompt, status, "  something else has the keyboard", hints]],
    ["warning without an idle footer", [prompt, warning]],
  ] as const)("refuses %s", (_reason, lines) => {
    expect(codexEmptyComposer(lines.join("\n"), 120)).toBeNull();
  });
});

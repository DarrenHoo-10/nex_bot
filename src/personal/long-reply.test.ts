import { describe, expect, it } from "vitest";
import { DOCUMENT_LINES, replyLayout } from "./long-reply";

describe("replyLayout", () => {
  it("keeps short plain replies as bubbles", () => {
    expect(replyLayout("好的，已经处理完了。\n\n还有别的需要吗？").document).toBe(false);
  });
  it("turns headings h1-h4 into a document, but not h5 or hashtags", () => {
    for (const level of [1, 2, 3, 4]) expect(replyLayout(`${"#".repeat(level)} 标题\n正文`).document).toBe(true);
    expect(replyLayout("##### 太深\n正文").document).toBe(false);
    expect(replyLayout("#标签 不是标题").document).toBe(false);
  });
  it("ignores headings inside code fences", () => {
    expect(replyLayout("```md\n# 示例\n```").document).toBe(false);
  });
  it("counts lines and wraps long ones", () => {
    const rows = (count: number) => Array.from({ length: count }, (_, index) => `- 第 ${index} 项`).join("\n");
    expect(replyLayout(rows(DOCUMENT_LINES)).document).toBe(false);
    expect(replyLayout(rows(DOCUMENT_LINES + 1)).document).toBe(true);
    expect(replyLayout("汉".repeat(42 * DOCUMENT_LINES + 1)).document).toBe(true);
  });
  it("does not count charts or HTML previews as text", () => {
    const chart = "```chart\n" + "{}\n".repeat(30) + "```";
    const html = "```html-preview\n" + "<p>x</p>\n".repeat(30) + "```";
    expect(replyLayout(`结果如下\n${chart}\n${html}`).document).toBe(false);
    expect(replyLayout(`## 结果\n${chart}`).document).toBe(true);
  });
  it("counts ordinary code blocks", () => {
    expect(replyLayout("```ts\n" + "const a = 1;\n".repeat(13) + "```").document).toBe(true);
  });
});

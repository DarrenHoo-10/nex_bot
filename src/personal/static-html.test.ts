// @vitest-environment node
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { describe, expect, it } from "vitest";
import { rehypeStaticHTML, staticHTMLLink, staticHTMLStyle } from "./static-html";

const render = (source: string) => renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeRaw, rehypeStaticHTML], children: source }));

describe("static message HTML", () => {
  it("renders inline HTML mixed with Markdown and entity text", () => {
    const html = render('普通 **加粗** 和 <span style="color:red;font-weight:bold">红色 &amp; 文字</span><br>下一行');
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain('<span style="color:red;font-weight:bold">红色 &amp; 文字</span><br/>');
  });
  it("retains static table layout, spans and list markup", () => {
    const html = render('<table><tr><th colspan="2">标题</th></tr><tr><td align="right">1</td><td><b>2</b></td></tr></table>\n\n<ul><li>事项</li></ul>');
    expect(html).toContain('<th colSpan="2">标题</th>');
    expect(html).toContain('<td style="text-align:right">1</td>');
    expect(html).toContain("<li>事项</li>");
  });
  it("preserves GFM tables/tasks and keeps HTML examples as code", () => {
    const html = render('| A | B |\n|---|---|\n|1|2|\n\n- [x] 完成\n\n```html\n<script>example</script>\n```');
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox" disabled="" checked=""');
    expect(html).toContain('&lt;script&gt;example&lt;/script&gt;');
  });
  it("removes executable, interactive and embedded subtrees and all handlers", () => {
    const html = render('<div onclick="boom()"><script>secret()</script><style>body{display:none}</style><iframe src="https://evil.test"></iframe><form><input value="x"></form><svg onload="boom()"><foreignObject>x</foreignObject></svg><p>安全</p></div>');
    expect(html).toContain("<p>安全</p>");
    expect(html).not.toMatch(/script|secret|style|iframe|form|input|svg|onload|onclick/);
  });
  it("does not allow CSS fetches, overlays, dangerous URLs or foreign images", () => {
    const html = render('<p style="position:fixed;inset:0;background-image:url(https://evil.test);color:blue">文字</p><a href="jav&#x61;script:alert(1)">链接</a><img src="https://evil.test/pixel" alt="外图">');
    expect(html).toContain('style="color:blue"');
    expect(html).not.toMatch(/position|url\(|evil|href=|<img/);
    expect(html).toContain("外图");
    expect(staticHTMLLink("https://user:pass@example.test")).toBe(false);
    expect(staticHTMLLink("//example.test")).toBe(false);
    expect(staticHTMLLink("https://example.test/path")).toBe(true);
    expect(staticHTMLStyle("color:red;background-color:#fff;font-size:999px;--x:red;color:var(--x)")).toBe("color:red;background-color:#fff");
  });
  it("keeps authenticated attachment URLs and makes all checkboxes read-only", () => {
    const html = render('<img src="/api/attachments/fixture-1" alt="图"><input type="checkbox" checked><input type="password"><a href="/api/attachments/fixture-1">下载</a>');
    expect(html).toContain('src="/api/attachments/fixture-1"');
    expect(html).toContain('href="/api/attachments/fixture-1"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("password");
  });
  it("handles partial markup during streaming", () => {
    const source = '<table><tr><td><b>中文</b></td></tr></table>';
    for (let i = 0; i <= source.length; i++) expect(() => render(source.slice(0, i))).not.toThrow();
  });
});

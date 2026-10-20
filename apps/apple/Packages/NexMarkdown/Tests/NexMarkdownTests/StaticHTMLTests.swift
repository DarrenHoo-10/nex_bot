import XCTest
@testable import NexMarkdown

final class StaticHTMLTests: XCTestCase {
    func testMixedInlineHTMLAndMarkdown() throws {
        let html = try XCTUnwrap(ChatDocument("普通 **加粗** <span style=\"color:red;font-weight:bold\">红色 &amp; 文字</span><br>下一行").staticHTML)
        XCTAssertTrue(html.contains("<strong>加粗</strong>"))
        XCTAssertTrue(html.contains("color:red;font-weight:bold"))
        XCTAssertTrue(html.contains("红色 &amp; 文字"))
        XCTAssertFalse(html.contains("&lt;span"))
    }

    func testHTMLTablesListsSpansAndStyles() {
        let html = StaticHTML.sanitize("<table><tr><th colspan=2>标题</th></tr><tr><td align=right>1</td><td><b>2</b></td></tr></table><ul><li>事项</li></ul>")
        XCTAssertTrue(html.contains("colspan=\"2\""))
        XCTAssertTrue(html.contains("align=\"right\""))
        XCTAssertTrue(html.contains("<li>事项</li>"))
    }

    func testActiveContentAndResourcesAreRemoved() {
        let html = StaticHTML.sanitize("<div onclick=boom()><script>secret()</script><style>body{display:none}</style><iframe src=https://evil.test></iframe><form><input></form><svg onload=boom()>x</svg><p>安全</p></div>")
        XCTAssertTrue(html.contains("<p>安全</p>"))
        for word in ["script", "secret", "style", "iframe", "form", "input", "svg", "onload", "onclick"] { XCTAssertFalse(html.contains(word), word) }
    }

    func testStyleAndURLAllowlist() {
        let html = StaticHTML.sanitize("<p style=\"position:fixed;background-image:url(https://evil.test);color:blue\">文字</p><a href=\"jav&#x61;script:alert(1)\">链接</a><img src=https://evil.test alt=外图>")
        XCTAssertTrue(html.contains("color:blue"))
        for word in ["position", "url(", "evil", "href=", "<img"] { XCTAssertFalse(html.contains(word), word) }
        XCTAssertTrue(html.contains("外图"))
        XCTAssertFalse(StaticHTML.safeLink("https://user:pass@example.test"))
        XCTAssertFalse(StaticHTML.safeLink("//example.test"))
        XCTAssertTrue(StaticHTML.safeLink("https://example.test/path"))
        XCTAssertEqual(StaticHTML.style("color:red;background-color:#fff;font-size:999px;--x:red;color:var(--x)"), "color:red;background-color:#fff")
    }

    func testCodeExamplesDoNotActivateHTMLRenderer() {
        XCTAssertNil(ChatDocument("```html\n<b>示例</b>\n```").staticHTML)
        XCTAssertNil(ChatDocument("`<span>示例</span>`").staticHTML)
        XCTAssertNil(ChatDocument("普通 Markdown **文字**").staticHTML)
    }

    func testCheckboxesAreReadOnlyAndPartialMarkupIsHandled() throws {
        let html = StaticHTML.sanitize("<input type=checkbox checked><input type=password>")
        XCTAssertTrue(html.contains("disabled"))
        XCTAssertFalse(html.contains("password"))
        let source = "<table><tr><td><b>中文</b></td></tr></table>"
        for end in source.indices { _ = ChatDocument(String(source[..<end])).staticHTML }
        let mixed = try XCTUnwrap(ChatDocument("<b>任务</b>\n\n- [x] 完成").staticHTML)
        XCTAssertTrue(mixed.contains("checkbox"))
        XCTAssertTrue(mixed.contains("checked"))
        let quoted = try XCTUnwrap(ChatDocument("<b>任务</b>\n\n> - [x] 完成\n> - \\[x] 原文").staticHTML)
        XCTAssertTrue(quoted.contains("checkbox"))
        XCTAssertTrue(quoted.contains("checked"))
        XCTAssertTrue(quoted.contains("[x] 原文"))
    }

    func testWrapperDisallowsScriptsNetworkAndForms() {
        let html = StaticHTML.document(fragment: "<b>安全</b>", fontSize: 14, dark: true)
        for policy in ["default-src 'none'", "script-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"] { XCTAssertTrue(html.contains(policy)) }
        XCTAssertTrue(html.contains("color-scheme:dark"))
    }
}

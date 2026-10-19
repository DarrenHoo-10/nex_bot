import XCTest
@testable import NexMarkdown

final class ChartTests: XCTestCase {
    func testChartFencesUseSharedRenderer() {
        for type in ["bar", "histogram", "line", "pie"] {
            let source = "说明\n\n```chart\n{\"type\":\"\(type)\"}\n```\n\n结论"
            let html = ChatDocument(source).staticHTML
            XCTAssertNotNil(html)
            XCTAssertTrue(html?.contains("class=\"language-chart\"") == true)
            XCTAssertTrue(html?.contains("结论") == true)
        }
        XCTAssertFalse(StaticHTML.chartScript.isEmpty)
        XCTAssertTrue(StaticHTML.chartScript.contains("data-chart-type"))
    }
    func testOtherCodeAndInlineCodeStayLiteral() {
        XCTAssertNil(ChatDocument("```json\n{\"type\":\"pie\"}\n```").staticHTML)
        XCTAssertNil(ChatDocument("`chart` and `<script>bad()</script>`").staticHTML)
        XCTAssertNil(ChatDocument("````text\n```chart\n{}\n```\n````").staticHTML)
    }
    func testMixedHTMLChartAndStreamingStaySanitized() {
        let source = "<b>统计</b><script>bad()</script>\n\n```chart\n{\"title\":\"<img src=x>\"}"
        let html = ChatDocument(source).staticHTML ?? ""
        XCTAssertTrue(html.contains("language-chart"))
        XCTAssertFalse(html.contains("<script"))
        XCTAssertFalse(html.contains("<img"))
        XCTAssertTrue(html.contains("&lt;img"))
        XCTAssertFalse(StaticHTML.sanitize("<code class='other' onclick='bad()'>x</code>").contains("class="))
        XCTAssertTrue(StaticHTML.document(fragment: html, fontSize: 14, dark: true).contains("script-src 'none'"))
    }
}

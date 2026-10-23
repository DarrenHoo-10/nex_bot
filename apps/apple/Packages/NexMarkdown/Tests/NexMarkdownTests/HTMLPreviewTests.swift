import XCTest
@testable import NexMarkdown

final class HTMLPreviewTests: XCTestCase {
    func testExplicitCompleteFences() {
        let parts = HTMLPreview.parts("前文\n\n```html-preview\n<button>你好</button>\n```\n\n后文\n\n~~~~html-preview\n<canvas></canvas>\n~~~~~")
        XCTAssertTrue(parts.contains(.preview(source: "<button>你好</button>", complete: true)))
        XCTAssertTrue(parts.contains(.preview(source: "<canvas></canvas>", complete: true)))
    }
    func testOrdinaryAndNestedCodeRemainLiteral() {
        for source in ["```html\nbad\n```", "````markdown\n```html-preview\nbad\n```\n````", "> ```html-preview\n> bad\n> ```", "- item\n\n  ```html-preview\n  bad\n  ```", "<pre><code class=\"language-html-preview\">bad</code></pre>", "```html-preview example\nbad\n```"] {
            XCTAssertTrue(HTMLPreview.parts(source).allSatisfy { if case .markdown = $0 { return true }; return false }, source)
        }
    }
    func testClosureAndResource() {
        XCTAssertEqual(HTMLPreview.parts("```html-preview\r\nx\r\n```"), [.preview(source: "x", complete: true)])
        XCTAssertEqual(HTMLPreview.parts("~~~~html-preview\nx\n~~~"), [.preview(source: "x\n~~~", complete: false)])
        XCTAssertFalse(HTMLPreview.shell.isEmpty)
        XCTAssertTrue(HTMLPreview.shell.contains("sandbox"))
        XCTAssertTrue(HTMLPreview.shell.contains("nex-html-init"))
    }
}

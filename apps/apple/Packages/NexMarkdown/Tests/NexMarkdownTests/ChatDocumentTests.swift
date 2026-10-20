import XCTest
@testable import NexMarkdown

final class ChatDocumentTests: XCTestCase {
    func testTableAlignmentAndInlineFormatting() throws {
        let document = ChatDocument("""
        | 名称 | 状态 | 数量 |
        | :--- | :---: | ---: |
        | **图片** | ~~旧~~ `新` | 12 |
        """)
        guard case .table(let table) = try XCTUnwrap(document.blocks.first) else { return XCTFail("Expected table") }
        XCTAssertEqual(table.alignments, [.left, .center, .right])
        XCTAssertEqual(table.header, [[.text("名称")], [.text("状态")], [.text("数量")]])
        XCTAssertEqual(table.rows[0][0], [.strong([.text("图片")])])
        XCTAssertEqual(table.rows[0][1], [.strikethrough([.text("旧")]), .text(" "), .code("新")])
    }

    func testEscapedPipesRaggedRowsAndOptionalOuterPipes() throws {
        let document = ChatDocument("名称 | 值\n--- | ---\na\\|b | `x\\|y`\n只有一格\n额外 | 两格 | 忽略")
        guard case .table(let table) = try XCTUnwrap(document.blocks.first) else { return XCTFail("Expected table") }
        XCTAssertEqual(table.rows.count, 3)
        XCTAssertEqual(table.rows[0], [[.text("a|b")], [.code("x|y")]])
        XCTAssertEqual(table.rows[1], [[.text("只有一格")], []])
        XCTAssertEqual(table.rows[2], [[.text("额外")], [.text("两格")]])
    }

    func testTasksKeepStateAndNestedBlocks() throws {
        let document = ChatDocument("- [ ] **待办**\n  - [X] 子项\n- [x] 已完成\n- 普通项目")
        guard case .list(let start, let items) = try XCTUnwrap(document.blocks.first) else { return XCTFail("Expected list") }
        XCTAssertNil(start)
        XCTAssertEqual(items.map(\.checked), [false, true, nil])
        XCTAssertEqual(items[0].blocks.first, .paragraph([.strong([.text("待办")])]))
        guard case .list(_, let nested) = items[0].blocks.last else { return XCTFail("Expected nested list") }
        XCTAssertEqual(nested[0].checked, true)
    }

    func testOrderedTasksAndContinuationParagraphs() throws {
        let document = ChatDocument("3. [ ] 第一步\n\n   补充说明\n\n4. [x] 第二步")
        guard case .list(let start, let items) = try XCTUnwrap(document.blocks.first) else { return XCTFail("Expected ordered list") }
        XCTAssertEqual(start, 3)
        XCTAssertEqual(items.map(\.checked), [false, true])
        XCTAssertEqual(items[0].blocks, [.paragraph([.text("第一步")]), .paragraph([.text("补充说明")])])
    }

    func testTablesAndTasksInsideQuotes() throws {
        let document = ChatDocument("> | A | B |\n> | - | - |\n> | 1 | 2 |\n>\n> - [x] 完成")
        guard case .quote(let blocks) = try XCTUnwrap(document.blocks.first) else { return XCTFail("Expected quote") }
        XCTAssertEqual(blocks.count, 2)
        guard case .table = blocks[0], case .list(_, let items) = blocks[1] else { return XCTFail("Expected nested table/list") }
        XCTAssertEqual(items[0].checked, true, String(describing: items))
    }

    func testCodeDoesNotBecomeTasksOrTables() {
        let text = "| A | B |\n| - | - |\n- [x] literal\n"
        XCTAssertEqual(ChatDocument("~~~text\n" + text + "~~~").blocks, [.code(language: "text", text: text)])
        XCTAssertEqual(ChatDocument("```\n" + text).blocks, [.code(language: nil, text: text)])
    }

    func testQuotedTaskFallbackDoesNotTreatEscapesOrCodeAsCheckboxes() throws {
        let document = ChatDocument("> - \\[x] escaped\n> - `[x]` code\n> - [ ] pending\n> - [X] **done**")
        guard case .quote(let blocks) = try XCTUnwrap(document.blocks.first),
              case .list(_, let items) = blocks.first else { return XCTFail("Expected quoted list") }
        XCTAssertEqual(items.map(\.checked), [nil, nil, false, true])
        XCTAssertEqual(items[2].blocks, [.paragraph([.text("pending")])])
        XCTAssertTrue(items[3].blocks.contains(.paragraph([.text(""), .strong([.text("done")])])))
    }

    func testStreamingSnapshotsAndMalformedTable() {
        let source = "| 名称 | 状态 |\n| --- | --- |\n| **文件** | 完成 |\n\n- [x] 结束"
        for end in source.indices { _ = ChatDocument(String(source[..<end])) }
        let incomplete = ChatDocument("| 名称 | 状态 |\n| --")
        guard case .paragraph = incomplete.blocks.first else { return XCTFail("Incomplete delimiter is text") }
        let invalid = ChatDocument("A | B\n--- | --- | ---\nvalue")
        XCTAssertFalse(invalid.blocks.contains { if case .table = $0 { return true }; return false })
    }

    func testAutolinksReferenceLinksAndStrikethrough() throws {
        let document = ChatDocument("~~旧~~ https://example.test [引用][ref]\n\n[ref]: https://example.test/ref")
        guard case .paragraph(let nodes) = try XCTUnwrap(document.blocks.first) else { return XCTFail("Expected paragraph") }
        XCTAssertTrue(nodes.contains(.strikethrough([.text("旧")])))
        XCTAssertTrue(nodes.contains(.link(destination: "https://example.test", children: [.text("https://example.test")])))
        XCTAssertTrue(nodes.contains(.link(destination: "https://example.test/ref", children: [.text("引用")])))
    }

    func testHeadingLineBreaksEscapesAndLiteralHTML() {
        XCTAssertEqual(ChatDocument("标题\n===").blocks, [.heading(level: 1, content: [.text("标题")])])
        XCTAssertEqual(ChatDocument("一\n二  \n三").blocks, [.paragraph([.text("一"), .text(" "), .text("二"), .text("\n"), .text("三")])])
        XCTAssertEqual(ChatDocument("\\[x] 普通文字").blocks, [.paragraph([.text("[x] 普通文字")])])
        XCTAssertEqual(ChatDocument("<script>alert(1)</script>").blocks, [.literal("<script>alert(1)</script>\n")])
        XCTAssertEqual(ChatDocument("\"plain\" -- ...").blocks, [.paragraph([.text("\"plain\" -- ...")])])
    }

    func testHeaderOnlyAndLargeTable() throws {
        let source = "A | B\n--- | ---\n" + (0..<500).map { "\($0) | value" }.joined(separator: "\n")
        guard case .table(let table) = try XCTUnwrap(ChatDocument(source).blocks.first) else { return XCTFail("Expected table") }
        XCTAssertEqual(table.rows.count, 500)
        guard case .table(let empty) = try XCTUnwrap(ChatDocument("A | B\n--- | ---").blocks.first) else { return XCTFail("Expected header") }
        XCTAssertTrue(empty.rows.isEmpty)
    }
}

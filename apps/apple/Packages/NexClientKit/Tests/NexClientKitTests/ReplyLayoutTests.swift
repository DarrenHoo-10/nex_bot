import XCTest
@testable import NexClientKit

/// Ported from `src/personal/long-reply.test.ts`, plus the outline, grouping and tool-capsule rules.
final class ReplyLayoutTests: XCTestCase {
    private func document(_ source: String) -> Bool { ReplyLayout.of(source).document }

    func testKeepsShortPlainRepliesAsBubbles() {
        XCTAssertFalse(document("好的，已经处理完了。\n\n还有别的需要吗？"))
    }

    func testHeadingsH1ToH4MakeADocumentButNotH5OrHashtags() {
        for level in 1...4 { XCTAssertTrue(document("\(String(repeating: "#", count: level)) 标题\n正文"), "h\(level)") }
        XCTAssertFalse(document("##### 太深\n正文"))
        XCTAssertFalse(document("#标签 不是标题"))
    }

    func testIgnoresHeadingsInsideCodeFences() {
        XCTAssertFalse(document("```md\n# 示例\n```"))
    }

    func testCountsLinesAndWrapsLongOnes() {
        func rows(_ count: Int) -> String { (0..<count).map { "- 第 \($0) 项" }.joined(separator: "\n") }
        XCTAssertFalse(document(rows(ReplyLayout.documentLines)))
        XCTAssertTrue(document(rows(ReplyLayout.documentLines + 1)))
        XCTAssertTrue(document(String(repeating: "汉", count: 42 * ReplyLayout.documentLines + 1)))
        XCTAssertFalse(document(String(repeating: "汉", count: 42 * ReplyLayout.documentLines)))
    }

    func testDoesNotCountChartsOrHTMLPreviewsAsText() {
        let chart = "```chart\n" + String(repeating: "{}\n", count: 30) + "```"
        let html = "```html-preview\n" + String(repeating: "<p>x</p>\n", count: 30) + "```"
        XCTAssertFalse(document("结果如下\n\(chart)\n\(html)"))
        XCTAssertTrue(document("## 结果\n\(chart)"))
    }

    func testCountsOrdinaryCodeBlocks() {
        XCTAssertTrue(document("```ts\n" + String(repeating: "const a = 1;\n", count: 13) + "```"))
    }

    func testToleratesWindowsLineEndingsAndTildeFences() {
        XCTAssertTrue(document("## 标题\r\n正文"))
        XCTAssertFalse(document("~~~md\r\n# 示例\r\n~~~"))
        // A shorter closing run does not end a longer fence.
        XCTAssertFalse(document("````md\n```\n# 仍在围栏内\n```\n````"))
    }

    func testOutlineListsHeadingsOutsideFencesAsPlainText() {
        let source = "# 总览\n正文\n```md\n## 示例\n```\n## **重点** 与 `代码` ##\n### [链接](https://example.test)\n##### 太深\n#标签"
        XCTAssertEqual(ReplyLayout.outline(source), ["总览", "重点 与 代码", "链接"])
        XCTAssertEqual(ReplyLayout.outline("没有标题"), [])
    }

    // MARK: Grouping

    private func message(_ role: String = "assistant", sender: String = "b1", at seconds: Double, direction: String? = nil) -> AgentMessage {
        var row: Row = ["role": .string(role), "sender_bot_id": .string(sender), "created_at": .number((1_760_000_000 + seconds) * 1000)]
        if let direction { row["a2a_direction"] = .string(direction) }
        return AgentMessage(row: row)
    }

    func testGroupsAssistantRepliesFromTheSameAgentWithinFiveMinutes() {
        let utc = TimeZone(identifier: "UTC")!
        let first = message(at: 0)
        XCTAssertTrue(MessageGrouping.joins(first, message(at: 300), timeZone: utc))
        XCTAssertFalse(MessageGrouping.joins(first, message(at: 301), timeZone: utc))
        XCTAssertFalse(MessageGrouping.joins(first, message(at: -1), timeZone: utc))
        XCTAssertFalse(MessageGrouping.joins(first, message(sender: "b2", at: 10), timeZone: utc))
        XCTAssertFalse(MessageGrouping.joins(nil, first, timeZone: utc))
    }

    func testOnlyPlainAssistantRepliesGroup() {
        let utc = TimeZone(identifier: "UTC")!
        XCTAssertFalse(MessageGrouping.joins(message("user", at: 0), message(at: 5), timeZone: utc))
        XCTAssertFalse(MessageGrouping.joins(message(at: 0), message("user", at: 5), timeZone: utc))
        XCTAssertFalse(MessageGrouping.joins(message(at: 0), message(at: 5, direction: "replied"), timeZone: utc))
        XCTAssertFalse(MessageGrouping.joins(message(at: 0, direction: "sent"), message(at: 5), timeZone: utc))
    }

    func testAGroupDoesNotCrossMidnight() {
        let utc = TimeZone(identifier: "UTC")!
        // 1_760_000_000 is 2025-10-09 08:53:20 UTC, so midnight is 54_400 seconds later.
        let late = message(at: 54_300), next = message(at: 54_500)
        XCTAssertFalse(MessageGrouping.joins(late, next, timeZone: utc))
        XCTAssertTrue(MessageGrouping.ends(late, next: next, timeZone: utc))
        XCTAssertTrue(MessageGrouping.ends(late, next: nil, timeZone: utc))
        XCTAssertFalse(MessageGrouping.ends(message(at: 0), next: message(at: 60), timeZone: utc))
    }

    // MARK: Tool capsule

    private func step(_ tool: String, _ status: String = "succeeded") -> ToolStep {
        ToolStep(row: ["tool_name": .string(tool), "status": .string(status)])
    }

    func testToolCapsuleShowsUpToThreeDistinctKinds() {
        let summary = ToolActivity.summary([step("memory.search"), step("memory.read"), step("device.exec"), step("device.read"), step("connector.call"), step("mystery.tool")])
        XCTAssertEqual(summary.symbols, ["brain", "terminal", "folder"])
        XCTAssertEqual(summary.count, 6)
        XCTAssertEqual(summary.failed, 0)
        XCTAssertEqual(ToolActivity.symbol(for: "mystery.tool"), "wrench")
        XCTAssertEqual(ToolActivity.symbol(for: "device.computer"), "display")
    }

    func testToolCapsuleCountsOnlyFailedSteps() {
        let summary = ToolActivity.summary([step("agent.delegate", "failed"), step("routine.run", "rejected"), step("skill.read", "cancelled"), step("html.render", "failed")])
        XCTAssertEqual(summary.failed, 2)
        XCTAssertEqual(ToolActivity.summary([]), .init(symbols: [], count: 0, failed: 0))
    }

    func testClockFormatsHoursAndMinutes() {
        let utc = TimeZone(identifier: "UTC")!
        XCTAssertEqual(TimeFormat.formatClock(Date(timeIntervalSince1970: 1_760_000_000), timeZone: utc), "08:53")
    }
}

import XCTest
@testable import NexClientKit

@MainActor
final class ApprovalRulesTests: XCTestCase {
    func testScopeDecodingDecisionsAndRevocation() async throws {
        let core = StubCore()
        core.handle { request in
            guard request.path == "/api/state" else { return .json(["ok": true]) }
            var state = stateJSON()
            state["approvals"] = [["id": "a1", "bot_id": "b1", "argument_hash": "hash-1", "remember_label": "执行终端命令 · 测试设备"]]
            state["approvalRules"] = [
                ["id": "r1", "bot_id": "b1", "label": "执行终端命令 · 测试设备", "active": true],
                ["id": "r2", "bot_id": "b1", "label": "旧设备", "active": false],
                ["id": "r3", "bot_id": "b2", "label": "另一个 Agent", "active": true],
            ]
            return .json(state)
        }
        let store = WorkspaceStore(client: core.client())
        await store.refresh()
        let approval = try XCTUnwrap(store.approvals.first)
        XCTAssertEqual(approval.rememberLabel, "执行终端命令 · 测试设备")
        XCTAssertEqual(store.approvalRules(botID: "b1").map(\.id), ["r1", "r2"])
        XCTAssertEqual(store.approvalRules(botID: "b1").map(\.isActive), [true, false])

        try await store.decide(approval, allow: true, remember: true)
        try await store.decide(approval, allow: true)
        try await store.decide(approval, allow: false)
        let decisions = core.recorded("/api/approvals")
        XCTAssertEqual(decisions.map { $0.json["remember"] as? Bool }, [true, false, false])
        XCTAssertEqual(decisions.map { $0.json["allow"] as? Bool }, [true, true, false])
        XCTAssertEqual(decisions[0].json["id"] as? String, "a1")
        XCTAssertEqual(decisions[0].json["hash"] as? String, "hash-1")

        let rule = try XCTUnwrap(store.approvalRules(botID: "b1").first)
        core.handle { request in request.path == "/api/state" ? .json(stateJSON()) : .json(["ok": true]) }
        try await store.revokeApprovalRule(rule)
        let revoked = try XCTUnwrap(core.recorded("/api/approvals/revoke").first)
        XCTAssertEqual(revoked.method, "POST")
        XCTAssertEqual(revoked.json["id"] as? String, "r1")
        XCTAssertEqual(revoked.json["botId"] as? String, "b1")
        XCTAssertTrue(store.approvalRules(botID: "b1").isEmpty)
        XCTAssertGreaterThanOrEqual(core.recorded("/api/state").count, 5)
    }

    func testOlderCoreAndFailedRevocation() async throws {
        let core = StubCore()
        core.handle { _ in .json(stateJSON()) }
        let store = WorkspaceStore(client: core.client())
        await store.refresh()
        XCTAssertTrue(store.approvalRules(botID: "b1").isEmpty)
        XCTAssertNil(Approval(row: ["id": "old"]).rememberLabel)
        XCTAssertNil(Approval(row: ["remember_label": ""]).rememberLabel)
        core.handle { _ in .json(["error": "授权不存在"], status: 404) }
        do {
            try await store.revokeApprovalRule(ApprovalRule(row: ["id": "gone", "bot_id": "b1"]))
            XCTFail("A rejected revoke must be reported")
        } catch { XCTAssertEqual((error as? CoreError)?.message, "授权不存在") }
    }

    func testSendingLeavesHistoryAndSignalsScrollBeforeResponse() async throws {
        let core = StubCore()
        core.handle { request in
            switch request.path {
            case "/api/agents/input": return .json(["error": "fixture offline"], status: 503, delay: 0.3)
            case "/api/state": return .json(stateJSON())
            default: return .json(feedJSON([]))
            }
        }
        let store = WorkspaceStore(client: core.client())
        let conversation = store.conversation(for: "b1")
        let empty = await conversation.send()
        XCTAssertFalse(empty)
        XCTAssertEqual(conversation.sendRevision, 0)
        conversation.focusedMessageID = "old-message"
        conversation.draft = "keep this on failure"
        let sending = Task { await conversation.send() }
        for _ in 0..<100 where !conversation.isSending { try await Task.sleep(for: .milliseconds(2)) }
        XCTAssertTrue(conversation.isSending)
        XCTAssertNil(conversation.focusedMessageID)
        XCTAssertEqual(conversation.sendRevision, 1)
        let accepted = await sending.value
        XCTAssertFalse(accepted)
        XCTAssertEqual(conversation.draft, "keep this on failure")
        let retried = await conversation.send()
        XCTAssertFalse(retried)
        XCTAssertEqual(conversation.sendRevision, 2)
        XCTAssertEqual(core.recorded("/api/agents/input")[0].json["clientId"] as? String,
                       core.recorded("/api/agents/input")[1].json["clientId"] as? String)
    }
}

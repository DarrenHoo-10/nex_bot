import XCTest
@testable import NexClientKit

final class FinanceTopicsTests:XCTestCase {
    func testTopicIdentityAudienceAndPreview() throws {
        let topic=try JSONDecoder().decode(FinanceTopic.self,from:Data(#"{"conversationId":"topic-a","title":"收盘","audience":"public","unread_count":2,"message_count":4,"sourceContext":{"channel":"feishu","chatType":"group","chatId":"group-a"},"messages":[{"id":"m1","seq":1,"role":"assistant","content":"公开复盘"}],"activeTask":{"id":"task-a","status":"running"}}"#.utf8))
        XCTAssertEqual(topic.id,"topic-a");XCTAssertEqual(topic.unread,2);XCTAssertEqual(topic.messages.first?.content,"公开复盘")
        XCTAssertEqual(topic.destinationLabel,"飞书 · group-a");XCTAssertEqual(topic.activeTask?.string("id"),"task-a")
    }
    func testStableFirstSendAndQueuedReplyContracts() async throws {
        let core=StubCore()
        core.handle {request in
            if request.path == "/api/agents/finance" {return .json(["botId":"finance"])}
            if request.path == "/api/agents/input" || request.path == "/api/agents/edit" {return .json(["conversationId":"topic-a","messageId":"input-a","taskId":NSNull(),"queued":true],status:202)}
            return .json(["ok":true])
        }
        let client=core.client(),input=TopicInput(botID:"finance",text:"研究",conversationID:nil,clientID:"stable-input")
        let first=try await client.sendTopic(input),replay=try await client.sendTopic(input)
        XCTAssertEqual(first.conversationId,replay.conversationId);XCTAssertTrue(first.queued == true);XCTAssertNil(first.taskId)
        let requests=core.recorded("/api/agents/input")
        XCTAssertEqual(requests.map{$0.json["clientId"] as? String},["stable-input","stable-input"])
        XCTAssertEqual(requests[0].json["newConversation"] as? Bool,true);XCTAssertNil(requests[0].json["conversationId"])
        _ = try await client.sendTopic(TopicInput(botID:"finance",text:"追问",conversationID:"topic-a",clientID:"follow"))
        XCTAssertEqual(core.recorded("/api/agents/input").last?.json["conversationId"] as? String,"topic-a")
        _ = try await client.sendTopic(TopicInput(botID:"finance",text:"修订",conversationID:"topic-a",clientID:"edit",editingMessageID:"input-a"))
        XCTAssertEqual(core.recorded("/api/agents/edit").last?.json["messageId"] as? String,"input-a")
        try await client.cancelTopic(botID:"finance",conversationID:"topic-a")
        try await client.readTopic(botID:"finance",conversationID:"topic-a",seq:9)
        XCTAssertEqual(core.recorded("/api/agents/cancel").last?.json["conversationId"] as? String,"topic-a")
        XCTAssertEqual(core.recorded("/api/agents/read").last?.json["seq"] as? Int,9)
    }
    @MainActor func testDefaultAssistantUsesServerRole() async throws {
        let core=StubCore()
        core.handle {request in
            if request.path == "/api/agents/finance" {return .json(["botId":"finance-role"])}
            return .json(stateJSON(bots: ["first", "finance-role"]))
        }
        let store=WorkspaceStore(client:core.client())
        await store.refresh();await store.loadFinanceAssistant()
        XCTAssertEqual(store.financeBotID,"finance-role");XCTAssertEqual(store.selectedBotID,"finance-role")
        XCTAssertEqual(store.feishuReceiverID(selection: ""), "")
        XCTAssertEqual(store.feishuReceiverID(selection: "first"), "first")
        XCTAssertEqual(store.feishuReceiverID(selection: "deleted"), "")
        XCTAssertEqual(core.recorded("/api/agents/finance").count,1)
        store.stop()
    }

    @MainActor func testHasTopicsRecognisesTopicCountAndFeishuApps() async throws {
        let core = StubCore()
        core.handle { _ in
            .json([
                "sync": syncJSON(),
                "bots": [
                    ["id": "plain", "name": "普通助手", "unread_count": 0, "read_seq": 0, "topic_count": 0, "topic_unread_count": 0],
                    ["id": "forked", "name": "开发专家", "unread_count": 2, "read_seq": 1, "topic_count": 1, "topic_unread_count": 2],
                    ["id": "feishu-bot", "name": "飞书助手", "unread_count": 0, "read_seq": 0, "topic_count": 0, "topic_unread_count": 0],
                ],
                "feishu": [
                    "apps": [
                        ["id": "f1", "appId": "cli_1", "brand": "feishu", "status": "connected", "ownerBound": true, "botId": "feishu-bot", "botName": "飞书助手", "enabled": true, "version": 1],
                    ],
                ],
                "approvals": [], "tasks": [], "routines": [], "devices": [], "conversations": [], "onlineDevices": [], "memories": [],
            ])
        }
        let store = WorkspaceStore(client: core.client())
        await store.refresh()
        XCTAssertFalse(store.hasTopics(for: "plain"))
        XCTAssertTrue(store.hasTopics(for: "forked"))
        XCTAssertEqual(store.bot("forked")?.topicUnreadCount, 2)
        XCTAssertTrue(store.hasTopics(for: "feishu-bot"))
        store.stop()
    }

}

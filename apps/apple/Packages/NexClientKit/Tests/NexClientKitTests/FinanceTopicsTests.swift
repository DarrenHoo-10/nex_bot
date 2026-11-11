import XCTest
@testable import NexClientKit

final class FinanceTopicsTests:XCTestCase {
    func testTopicIdentityAudienceAndPreview() throws {
        let topic=try JSONDecoder().decode(FinanceTopic.self,from:Data(#"{"conversationId":"topic-a","title":"收盘","audience":"public","unread_count":2,"message_count":4,"sourceContext":{"channel":"feishu","chatType":"group","chatId":"group-a"},"messages":[{"id":"m1","seq":1,"role":"assistant","content":"公开复盘"}],"activeTask":{"id":"task-a","status":"running"}}"#.utf8))
        XCTAssertEqual(topic.id,"topic-a");XCTAssertEqual(topic.unread,2);XCTAssertEqual(topic.messages.first?.content,"公开复盘")
        XCTAssertEqual(topic.destinationLabel,"回复到飞书群 · group-a");XCTAssertEqual(topic.activeTask?.string("id"),"task-a")
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
            return .json(stateJSON())
        }
        let store=WorkspaceStore(client:core.client())
        await store.refresh();await store.loadFinanceAssistant()
        XCTAssertEqual(store.financeBotID,"finance-role");XCTAssertEqual(store.selectedBotID,"finance-role")
        XCTAssertEqual(core.recorded("/api/agents/finance").count,1)
        store.stop()
    }

}

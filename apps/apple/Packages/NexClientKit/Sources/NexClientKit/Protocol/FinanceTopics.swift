import Foundation

public struct FinanceTopic: RowBacked, Identifiable {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var id: String { row.string("conversationId") ?? row.string("conversation_id") ?? "" }
    public var title: String { row.string("title") ?? "新话题" }
    public var audience: String { row.string("audience") ?? "private" }
    public var unread: Int { row.int("unread_count") ?? 0 }
    public var replyCount: Int { row.int("message_count") ?? 0 }
    public var messages: [AgentMessage] { row["messages"]?.arrayValue?.compactMap(\.objectValue).map(AgentMessage.init) ?? [] }
    public var activeTask: Row? { row["activeTask"]?.objectValue }
    public var source: Row { row["sourceContext"]?.objectValue ?? [:] }
    public var destinationLabel: String {
        if source.string("chatType") == "group" { return "回复到飞书群 · \(source.string("chatId") ?? "")" }
        if source.string("channel") == "feishu" { return "飞书私聊" }
        return audience == "public" ? "公开话题" : "本人私人话题"
    }
}
public struct FinanceTopicList: Decodable, Sendable { public let topics: [FinanceTopic] }
public struct FinanceAssistant: Decodable, Sendable { public let botId: String }
public struct FinanceTopicTasks: Decodable, Sendable {public let tasks:[AgentTask]}
public struct TopicInputResult: Decodable, Sendable { public let taskId: String?; public let conversationId: String; public let messageId: String; public let queued: Bool? }
/// Retain the whole input on an uncertain response; its identifier and destination must not change on retry.
public struct TopicInput: Encodable, Sendable, Equatable {
    public let botId: String, clientId: String, text: String
    public let messageId: String?
    public let conversationId: String?
    public let newConversation: Bool?
    public init(botID: String, text: String, conversationID: String?, clientID: String = UUID().uuidString, editingMessageID: String? = nil) {
        messageId=editingMessageID; botId = botID; self.text = text; clientId = clientID; conversationId = conversationID; newConversation = conversationID == nil ? true : nil
    }
}
extension CoreClient {
    public func financeAssistant() async throws -> FinanceAssistant { try await get("/api/agents/finance") }
    public func financeTopics(botID: String) async throws -> [FinanceTopic] { let result: FinanceTopicList = try await get("/api/agents/topics", query: [("bot",botID)]); return result.topics }
    public func topicFeed(botID: String, conversationID: String, before: Int? = nil) async throws -> Feed {
        var query = [("bot",botID),("conversationId",conversationID)]
        if let before { query.append(("before",String(before))) }
        return try await get("/api/agents/messages",query:query)
    }
    public func sendTopic(_ input: TopicInput) async throws -> TopicInputResult { try await post(input.messageId == nil ? "/api/agents/input" : "/api/agents/edit",body:input) }
    public func topicTasks(botID:String,conversationID:String) async throws -> [AgentTask] {let result:FinanceTopicTasks=try await get("/api/agents/tasks",query:[("bot",botID),("conversationId",conversationID)]);return result.tasks}
    public func retryTopic(botID:String,conversationID:String,taskID:String,clientID:String) async throws -> TopicInputResult {try await post("/api/agents/retry",body:["botId":botID,"conversationId":conversationID,"taskId":taskID,"clientId":clientID])}
    public func cancelTopic(botID: String, conversationID: String) async throws { try await post("/api/agents/cancel",body:["botId":botID,"conversationId":conversationID]) }
    public func readTopic(botID: String, conversationID: String, seq: Int) async throws { try await post("/api/agents/read",body:["botId":JSONValue.string(botID),"conversationId":.string(conversationID),"seq":.number(Double(seq))]) }
}

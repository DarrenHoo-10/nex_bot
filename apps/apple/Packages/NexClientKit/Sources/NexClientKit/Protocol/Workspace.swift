import Foundation

/// Decodes any JSON object into a ``Row`` and exposes typed accessors over it.
public protocol RowBacked: Codable, Sendable, Hashable, Identifiable {
    var row: Row { get }
    init(row: Row)
}
extension RowBacked {
    public init(from decoder: Decoder) throws { self.init(row: try Row(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try row.encode(to: encoder) }
    public var id: String { row.string("id") ?? "" }
}

/// An agent contact (`bots[]` of `/api/state`, merged with the contact summary).
public struct Bot: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var name: String { row.string("name") ?? id }
    public var instructions: String { row.string("instructions") ?? "" }
    /// Highest message seq the owner has read.
    public var readSeq: Int { row.int("read_seq") ?? 0 }
    /// Non-user messages after `readSeq`.
    public var unreadCount: Int { row.int("unread_count") ?? 0 }
    public var lastMessage: String? { row.string("last_message") }
    public var lastMessageAt: Date? { dateFromMilliseconds(row.double("last_message_at")) }
    /// First visible character, for avatar initials.
    public var initials: String { String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased() }
}

/// A pending approval (`approvals[]`). Decide with the committed ``argumentHash``.
public struct Approval: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var botID: String { row.string("bot_id") ?? "" }
    public var taskID: String { row.string("task_id") ?? "" }
    public var toolName: String { row.string("tool_name") ?? "" }
    public var argumentHash: String { row.string("argument_hash") ?? "" }
    /// Pretty-printed tool arguments (`arguments_json`).
    public var argumentsText: String {
        guard let raw = row.string("arguments_json"), let data = raw.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data) else { return row.string("arguments_json") ?? "" }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? raw
    }
    public var expiresAt: Date? { dateFromMilliseconds(row.double("expires_at")) }
    public var title: String { ToolLabels.approvalTitle(toolName) }
}

/// A task row (`tasks[]`).
public struct AgentTask: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var botID: String { row.string("bot_id") ?? "" }
    public var status: String { row.string("status") ?? "" }
    public var objective: String { row.string("objective") ?? "" }
    public var activeTool: String? { row.string("active_tool") }
    public var createdAt: Date? { dateFromMilliseconds(row.double("created_at")) }
    /// Nil while the task is unfinished.
    public var endedAt: Date? { dateFromMilliseconds(row.double("ended_at")) }
    public var isUnfinished: Bool { row["ended_at"].map { $0 == .null } ?? true }
    /// Short Chinese status phrase, e.g. 执行中 / 等你批准.
    public var phrase: String { ToolLabels.taskPhrase(self) }
}

/// `GET /api/state`. Unknown fields are ignored; open collections stay as ``Row``s.
public struct WorkspaceState: Codable, Sendable {
    public var sync: SyncIdentity
    public var bots: [Bot]
    public var approvals: [Approval]
    public var tasks: [AgentTask]
    public var conversations: [Row]
    public var routines: [Row]
    public var devices: [Row]
    public var delegations: [Row]
    public var onlineDevices: [String]

    public init(sync: SyncIdentity, bots: [Bot] = [], approvals: [Approval] = [], tasks: [AgentTask] = [], conversations: [Row] = [], routines: [Row] = [], devices: [Row] = [], delegations: [Row] = [], onlineDevices: [String] = []) {
        self.sync = sync; self.bots = bots; self.approvals = approvals; self.tasks = tasks; self.conversations = conversations
        self.routines = routines; self.devices = devices; self.delegations = delegations; self.onlineDevices = onlineDevices
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        func rows(_ key: String) -> [Row] { c.lenient(.init(key))?.arrayValue?.compactMap(\.objectValue) ?? [] }
        sync = try c.decode(SyncIdentity.self, forKey: .init("sync"))
        bots = rows("bots").map(Bot.init); approvals = rows("approvals").map(Approval.init); tasks = rows("tasks").map(AgentTask.init)
        conversations = rows("conversations"); routines = rows("routines"); devices = rows("devices"); delegations = rows("delegations")
        onlineDevices = c.lenient(.init("onlineDevices"))?.arrayValue?.compactMap(\.stringValue) ?? []
    }
    /// Newest unfinished task of a bot (tasks arrive unfinished-first, newest first).
    public func unfinishedTask(botID: String) -> AgentTask? { tasks.first { $0.botID == botID && $0.isUnfinished } }
}

/// One step of `tool_steps` on an assistant message.
public struct ToolStep: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var toolName: String { row.string("tool_name") ?? "" }
    public var status: String { row.string("status") ?? "" }
    public var summary: String { row.string("summary") ?? "" }
    public var preview: String { row.string("preview") ?? "" }
    /// Collapsed row label, e.g. 检索记忆.
    public var label: String { ToolLabels.label(for: toolName) }
}

/// A conversation message (`agents/messages`).
public struct AgentMessage: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var seq: Int { row.int("seq") ?? 0 }
    /// `user`, `assistant`, `peer` or `system`.
    public var role: String { row.string("role") ?? "" }
    /// `message`, `request`, `result`, `activity` or `error`.
    public var kind: String { row.string("kind") ?? "" }
    public var content: String { row.string("content") ?? "" }
    public var taskID: String? { row.string("task_id") }
    public var senderBotID: String? { row.string("sender_bot_id") }
    public var createdAt: Date? { dateFromMilliseconds(row.double("created_at")) }
    public var a2aDirection: String? { row.string("a2a_direction") }
    public var a2aPeerID: String? { row.string("a2a_peer_id") }
    public var toolSteps: [ToolStep] { row["tool_steps"]?.arrayValue?.compactMap(\.objectValue).map(ToolStep.init) ?? [] }
    public var isFromUser: Bool { role == "user" }
}

public struct StreamingText: Codable, Sendable, Hashable {
    public var taskId: String
    public var text: String
    public init(taskId: String, text: String) { self.taskId = taskId; self.text = text }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        taskId = c.lenient(.init("taskId"))?.stringValue ?? ""
        text = c.lenient(.init("text"))?.stringValue ?? ""
    }
}

/// `GET /api/agents/messages`
public struct Feed: Codable, Sendable {
    public var messages: [AgentMessage]
    public var streaming: [StreamingText]
    public var sync: SyncIdentity
    public var hasMore: Bool
    public init(messages: [AgentMessage] = [], streaming: [StreamingText] = [], sync: SyncIdentity, hasMore: Bool = false) {
        self.messages = messages; self.streaming = streaming; self.sync = sync; self.hasMore = hasMore
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        sync = try c.decode(SyncIdentity.self, forKey: .init("sync"))
        messages = c.lenient(.init("messages"))?.arrayValue?.compactMap(\.objectValue).map(AgentMessage.init) ?? []
        streaming = (try? c.decodeIfPresent([StreamingText].self, forKey: .init("streaming"))) ?? []
        hasMore = c.lenient(.init("hasMore"))?.boolValue ?? false
    }
}

/// A signed-in client session of this account.
public struct ClientSession: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var sessionID: String { row.string("session_id") ?? "" }
    public var id: String { sessionID }
    /// Device name the session logged in with (`client_name`).
    public var name: String { row.string("client_name") ?? row.string("name") ?? "" }
    public var lastSeenAt: Date? { dateFromMilliseconds(row.double("last_seen_at")) }
    public var createdAt: Date? { dateFromMilliseconds(row.double("created_at")) }
    public var expiresAt: Date? { dateFromMilliseconds(row.double("expires_at")) }
}

/// `GET /api/clients`
public struct ClientSessionList: Codable, Sendable {
    public var sessions: [ClientSession]
    public var currentSessionId: String
    public init(sessions: [ClientSession] = [], currentSessionId: String = "") { self.sessions = sessions; self.currentSessionId = currentSessionId }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        sessions = c.lenient(.init("sessions"))?.arrayValue?.compactMap(\.objectValue).map(ClientSession.init) ?? []
        currentSessionId = c.lenient(.init("currentSessionId"))?.stringValue ?? ""
    }
}

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
    /// Optimistic-concurrency version of the name and instructions (`bots/update`, `bots/archive`).
    public var version: Int { row.int("version") ?? 1 }
    /// Version of the tool policy (`bots/policy`).
    public var policyVersion: Int { row.int("policy_version") ?? 0 }
    /// Granted action ids from `policy_json.tools`, unfiltered, in stored order.
    public var policyTools: [String] { jsonField("policy_json")?["tools"]?.arrayValue?.compactMap(\.stringValue) ?? [] }
    /// Expertise tags from `expertise_json`.
    public var expertise: [String] { jsonField("expertise_json")?.arrayValue?.compactMap(\.stringValue) ?? [] }
    /// Version echoed by `bots/appearance`; 0 while no appearance row exists.
    public var appearanceVersion: Int { row.int("appearance_version") ?? 0 }
    /// Raw `appearance_json` text, nil when the bot has no saved look.
    public var appearanceJSON: String? { row.string("appearance_json") }
    private func jsonField(_ key: String) -> JSONValue? { parseJSONText(row.string(key)) }
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

/// `GET /api/state`. Unknown fields are ignored; collections are typed wrappers over open rows (`row` keeps every column).
public struct WorkspaceState: Codable, Sendable {
    public var sync: SyncIdentity
    public var bots: [Bot]
    public var approvals: [Approval]
    public var tasks: [AgentTask]
    public var conversations: [Row]
    public var routines: [Routine]
    public var occurrences: [RoutineOccurrence]
    public var devices: [Device]
    public var delegations: [Delegation]
    public var onlineDevices: [String]
    public var connectors: [ConnectorView]
    public var memories: [Memory]
    public var journal: [JournalEntry]
    public var usage: [Usage]
    /// Nil until a model is configured.
    public var config: ModelConfig?
    public var node: NodeState?
    public var memoryEngine: MemoryEngineStatus?
    public var memoryPlugin: MemoryPluginState?
    public var directory: [Row]
    public var hostDeviceID: String?
    /// The origin Core sees for this request (`address`).
    public var address: String
    public var dataDir: String
    /// e.g. "Pi 1.0.4".
    public var runtime: String
    public var lanEnabled: Bool
    /// Models the pickers offer for the current connection (`nil` models = all). Absent on older Cores.
    public var modelVisibility: ModelVisibility
    /// `imageModelSelection`: the models offered for image generation (always a list; OpenAI-compatible connections only).
    public var imageModelSelection: ModelVisibility = ModelVisibility(models: [])

    public init(sync: SyncIdentity, bots: [Bot] = [], approvals: [Approval] = [], tasks: [AgentTask] = [], conversations: [Row] = [], routines: [Routine] = [], occurrences: [RoutineOccurrence] = [], devices: [Device] = [], delegations: [Delegation] = [], onlineDevices: [String] = [], connectors: [ConnectorView] = [], memories: [Memory] = [], journal: [JournalEntry] = [], usage: [Usage] = [], config: ModelConfig? = nil, node: NodeState? = nil, memoryEngine: MemoryEngineStatus? = nil, memoryPlugin: MemoryPluginState? = nil, directory: [Row] = [], hostDeviceID: String? = nil, address: String = "", dataDir: String = "", runtime: String = "", lanEnabled: Bool = false, modelVisibility: ModelVisibility = ModelVisibility()) {
        self.sync = sync; self.bots = bots; self.approvals = approvals; self.tasks = tasks; self.conversations = conversations
        self.routines = routines; self.occurrences = occurrences; self.devices = devices; self.delegations = delegations; self.onlineDevices = onlineDevices
        self.connectors = connectors; self.memories = memories; self.journal = journal; self.usage = usage; self.config = config; self.node = node
        self.memoryEngine = memoryEngine; self.memoryPlugin = memoryPlugin; self.directory = directory; self.hostDeviceID = hostDeviceID
        self.address = address; self.dataDir = dataDir; self.runtime = runtime; self.lanEnabled = lanEnabled; self.modelVisibility = modelVisibility
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        func rows(_ key: String) -> [Row] { c.lenient(.init(key))?.arrayValue?.compactMap(\.objectValue) ?? [] }
        func object(_ key: String) -> Row? { c.lenient(.init(key))?.objectValue }
        sync = try c.decode(SyncIdentity.self, forKey: .init("sync"))
        bots = rows("bots").map(Bot.init); approvals = rows("approvals").map(Approval.init); tasks = rows("tasks").map(AgentTask.init)
        conversations = rows("conversations"); routines = rows("routines").map(Routine.init); occurrences = rows("occurrences").map(RoutineOccurrence.init)
        delegations = rows("delegations").map(Delegation.init)
        onlineDevices = c.lenient(.init("onlineDevices"))?.arrayValue?.compactMap(\.stringValue) ?? []
        let online = Set(onlineDevices)
        devices = rows("devices").map { Device(row: $0, online: online.contains($0.string("id") ?? "")) }
        connectors = rows("connectors").map(ConnectorView.init); memories = rows("memories").map(Memory.init)
        journal = rows("journal").map(JournalEntry.init); usage = rows("usage").map(Usage.init)
        config = object("config").map(ModelConfig.init); node = object("node").map(NodeState.init)
        memoryEngine = object("memoryEngine").map(MemoryEngineStatus.init); memoryPlugin = object("memoryPlugin").map(MemoryPluginState.init)
        directory = rows("directory")
        hostDeviceID = c.lenient(.init("hostDeviceId"))?.stringValue
        address = c.lenient(.init("address"))?.stringValue ?? ""; dataDir = c.lenient(.init("dataDir"))?.stringValue ?? ""
        runtime = c.lenient(.init("runtime"))?.stringValue ?? ""; lanEnabled = c.lenient(.init("lanEnabled"))?.boolValue ?? false
        modelVisibility = (try? c.decodeIfPresent(ModelVisibility.self, forKey: .init("modelVisibility"))) ?? ModelVisibility()
        imageModelSelection = (try? c.decodeIfPresent(ModelVisibility.self, forKey: .init("imageModelSelection"))) ?? ModelVisibility(models: [])
        if imageModelSelection.models == nil { imageModelSelection.models = [] }
    }
    /// Newest unfinished task of a bot (tasks arrive unfinished-first, newest first).
    public func unfinishedTask(botID: String) -> AgentTask? { tasks.first { $0.botID == botID && $0.isUnfinished } }
    /// All unfinished tasks of a bot, newest first.
    public func unfinishedTasks(botID: String) -> [AgentTask] { tasks.filter { $0.botID == botID && $0.isUnfinished } }
    public func routines(botID: String) -> [Routine] { routines.filter { $0.botID == botID } }
    /// Up to `limit` newest occurrences of a bot's routines (web 工作 tab: 10).
    public func occurrences(botID: String, limit: Int = 10) -> [RoutineOccurrence] { Array(occurrences.filter { $0.botID == botID }.prefix(limit)) }
    /// Memories shown in a bot's 资料 tab: workspace-shared plus that bot's own.
    public func memories(botID: String) -> [Memory] { memories.filter { $0.isShared || $0.botID == botID } }
    /// The bot's work records (web shows the first 8).
    public func journal(botID: String, limit: Int = 8) -> [JournalEntry] { Array(journal.filter { $0.botID == botID }.prefix(limit)) }
    public func usage(botID: String) -> Usage { usage.first { $0.botID == botID } ?? Usage(row: ["bot_id": .string(botID)]) }
    /// Bound (not revoked) devices.
    public var boundDevices: [Device] { devices.filter(\.isBound) }
    public var onlineDeviceCount: Int { onlineDevices.count }
    public var enabledConnectorCount: Int { connectors.filter(\.enabled).count }
    /// Enabled connectors with at least one tool granted to the bot (web 工作 tab 连接器 list).
    public func connectors(grantedTo botID: String) -> [ConnectorView] {
        connectors.filter { $0.enabled && ($0.grant(for: botID)?.tools.isEmpty == false) }
    }
    public func isHost(_ device: Device) -> Bool { device.id == hostDeviceID }
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

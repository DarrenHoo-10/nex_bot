import Foundation

// MARK: - Request values

/// Avatar choice for `bots/appearance`.
public enum AppearanceChoice: Sendable, Hashable, Encodable {
    case companion(shape: String, color: String)
    case portrait(String)
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        switch self {
        case .companion(let shape, let color):
            try c.encode("companion", forKey: .init("kind")); try c.encode(shape, forKey: .init("shape")); try c.encode(color, forKey: .init("color"))
        case .portrait(let id):
            try c.encode("portrait", forKey: .init("kind")); try c.encode(id, forKey: .init("id"))
        }
    }
}

/// When a routine runs.
public enum RoutineSchedule: Sendable, Hashable {
    /// Every day at "HH:mm" in the routine's time zone.
    case daily(localTime: String)
    case interval(minutes: Int)
    case once(at: Date)
    public var kind: ScheduleKind { switch self { case .daily: .daily; case .interval: .interval; case .once: .once } }
}

/// Body of `routines`. Omit `id` to create; pass `id` and the row's `version` to edit.
public struct RoutineDraft: Sendable, Hashable {
    public var botID: String, name: String, prompt: String
    public var schedule: RoutineSchedule
    public var timeZone: String
    public var id: String?, version: Int?
    public init(botID: String, name: String, prompt: String, schedule: RoutineSchedule, timeZone: String = TimeZone.current.identifier, id: String? = nil, version: Int? = nil) {
        self.botID = botID; self.name = name; self.prompt = prompt; self.schedule = schedule; self.timeZone = timeZone; self.id = id; self.version = version
    }
}

struct RoutineBody: Encodable {
    let botId: String, name: String, prompt: String, scheduleKind: String, timeZone: String
    let localTime: String?, intervalMinutes: Int?, runAt: Int?
    let id: String?, version: Int?
    init(_ d: RoutineDraft) {
        botId = d.botID; name = d.name; prompt = d.prompt; scheduleKind = d.schedule.kind.rawValue; timeZone = d.timeZone; id = d.id; version = d.version
        switch d.schedule {
        case .daily(let t): localTime = t; intervalMinutes = nil; runAt = nil
        case .interval(let m): localTime = nil; intervalMinutes = m; runAt = nil
        case .once(let date): localTime = nil; intervalMinutes = nil; runAt = Int((date.timeIntervalSince1970 * 1000).rounded())
        }
    }
}

/// Body of `connectors/save`. Credential rules are enforced by Core: a non-empty `token` replaces the credential,
/// `clearToken` removes it, otherwise it is kept only while the URL and transport are unchanged.
public struct ConnectorDraft: Sendable, Hashable {
    public var id: String?, version: Int?
    public var name: String, url: String
    /// `http` or `sse`.
    public var transport: String
    public var token: String?
    public var clearToken: Bool?
    public var enabled: Bool?
    public init(id: String? = nil, version: Int? = nil, name: String, url: String, transport: String = "http", token: String? = nil, clearToken: Bool? = nil, enabled: Bool? = nil) {
        self.id = id; self.version = version; self.name = name; self.url = url; self.transport = transport; self.token = token; self.clearToken = clearToken; self.enabled = enabled
    }
}
extension ConnectorDraft: Encodable {}

/// Body of `memory` (save). `documentId` and the row's version (`expectedVersion`) are set when editing.
public struct MemoryDraft: Sendable, Hashable, Encodable {
    public var botId: String, title: String, content: String
    /// `bot` or `workspace`. The scope of an existing memory cannot change.
    public var scope: String
    public var documentId: String?
    public var expectedVersion: Int
    public init(botID: String, title: String, content: String, scope: String = "bot", documentID: String? = nil, expectedVersion: Int = 0) {
        botId = botID; self.title = title; self.content = content; self.scope = scope; documentId = documentID; self.expectedVersion = expectedVersion
    }
}

/// Body of `plugins/memory` and `plugins/memory/test`.
public struct MemoryPluginSettings: Sendable, Hashable, Encodable {
    public var provider = "hindsight"
    public var enabled: Bool
    public var endpoint: String?
    public var token: String?
    public init(enabled: Bool, endpoint: String? = nil, token: String? = nil) { self.enabled = enabled; self.endpoint = endpoint; self.token = token }
}

/// Body of `config`. A blank `apiKey` keeps the stored one.
public struct ModelSettings: Sendable, Hashable, Encodable {
    /// `openai` or `anthropic`.
    public var provider: String
    public var model: String, endpoint: String
    public var apiKey: String?
    public init(provider: String, model: String, endpoint: String, apiKey: String? = nil) { self.provider = provider; self.model = model; self.endpoint = endpoint; self.apiKey = apiKey }
}

// MARK: - Responses

/// `memory/recall` result.
public struct MemoryFact: Sendable, Hashable, Identifiable {
    public var ref: String
    public var refs: [String]
    /// `bot` or `workspace`.
    public var scope: String
    public var text: String
    public var sourceClass: String
    public var id: String { ref }
    /// "共享 · 用户陈述".
    public var caption: String { "\(MemoryLabels.scope(scope)) · \(MemoryLabels.sourceClass(sourceClass))" }
}
public struct MemoryRecall: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    /// `available`, `pending`, `unavailable` or `disabled`.
    public var status: String { row.string("status") ?? "unavailable" }
    public var statusText: String { MemoryLabels.recallStatus(status) }
    public var facts: [MemoryFact] {
        row["facts"]?.arrayValue?.compactMap(\.objectValue).map {
            let ref = $0.string("ref") ?? ""
            let refs = $0["refs"]?.arrayValue?.compactMap(\.stringValue) ?? []
            return MemoryFact(ref: ref, refs: refs.isEmpty ? [ref] : refs, scope: $0.string("scope") ?? "bot", text: $0.string("text") ?? "", sourceClass: $0.string("sourceClass") ?? "")
        } ?? []
    }
}

/// One synthesized answer of `memory/reflect`.
public struct MemoryAnswer: Sendable, Hashable, Identifiable {
    public var scope: String, text: String, refs: [String]
    public var id: String { scope + text }
    /// 共享记忆综合 / 私有记忆综合.
    public var caption: String { scope == "workspace" ? "共享记忆综合" : "私有记忆综合" }
}
public struct MemoryReflection: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    /// `available` or `no_evidence`.
    public var status: String { row.string("status") ?? "no_evidence" }
    public var statusText: String { MemoryLabels.reflectStatus(status) }
    public var answers: [MemoryAnswer] {
        row["answers"]?.arrayValue?.compactMap(\.objectValue).map {
            MemoryAnswer(scope: $0.string("scope") ?? "bot", text: $0.string("text") ?? "", refs: $0["refs"]?.arrayValue?.compactMap(\.stringValue) ?? [])
        } ?? []
    }
}

/// `memory/expand` result: the source text behind a fact.
public struct MemoryExpansion: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var ref: String { row.string("ref") ?? "" }
    public var sourceClass: String { row.string("sourceClass") ?? "" }
    public var content: String { row.string("content") ?? "" }
    public var contentHash: String { row.string("contentHash") ?? "" }
}

/// `memory` (save) result.
public struct MemorySaveResult: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var documentID: String { row.string("documentId") ?? "" }
    public var version: Int { row.int("version") ?? 0 }
}

/// `memory/forget-preview`: what a forget would remove. Pass ``revision`` to `forget`.
public struct ForgetPreview: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    private func list(_ key: String) -> [String] { row[key]?.arrayValue?.compactMap(\.stringValue) ?? [] }
    public var documents: [String] { list("documents") }
    public var messages: [String] { list("messages") }
    public var tasks: [String] { list("tasks") }
    /// Bot ids affected.
    public var bots: [String] { list("bots") }
    public var revision: String { row.string("revision") ?? "" }
    /// The confirmation detail of the web dialog; `botNames` maps ids to names (missing ones show 已归档 Agent).
    public func confirmationDetail(botNames: [String: String]) -> String {
        let names = bots.map { botNames[$0] ?? "已归档 Agent" }
        return "将清理 \(documents.count) 条记忆、\(messages.count) 条消息，并停止及清理 \(tasks.count) 项相关工作。受影响的 Agent：\(names.isEmpty ? "无" : names.joined(separator: "、"))。混合多个来源的回复会整条清理。"
    }
}

/// `memory/forget` result.
public struct ForgetResult: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    /// `completed` or `cleaning`.
    public var status: String { row.string("status") ?? "" }
    public var documents: Int { row.int("documents") ?? 0 }
    public var messages: Int { row.int("messages") ?? 0 }
    public var statusText: String { MemoryLabels.forgetStatus(status) }
}

/// `preview`: a file or a tool call shown in the 资料 tab.
public struct PreviewItem: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    /// `file` or `tool`.
    public var kind: String { row.string("kind") ?? "file" }
    public var isTool: Bool { kind == "tool" }
    public var path: String? { row.string("path") }
    /// Tool-call id for tool previews, else the path.
    public var id: String { row.string("id") ?? path ?? "" }
    /// Raw `title`: the file name, or the tool name for tools.
    public var title: String { row.string("title") ?? "" }
    public var displayTitle: String { isTool ? ToolLabels.label(for: title) : title }
    public var exists: Bool { row.bool("exists") ?? true }
    public var size: Int? { row.int("size") }
    public var updatedAt: Date? { dateFromMilliseconds(row.double("updatedAt")) }
    public var status: String? { row.string("status") }
    /// Pretty tool arguments (tool previews).
    public var arguments: String? { row.string("arguments").map(prettyJSON) }
    public var createdAt: Date? { dateFromMilliseconds(row.double("createdAt")) }
    public var content: String { row.string("content") ?? "" }
    /// Card subtitle: `{path} · {size} B` for files, `{status} · {time}` for tools.
    public var subtitle: String {
        if isTool {
            return [status.map(ToolLabels.statusText), createdAt.map { TimeFormat.formatTime($0) }].compactMap { $0 }.joined(separator: " · ")
        }
        return [path, size.map { "\($0) B" }].compactMap { $0 }.joined(separator: " · ")
    }
    /// Local fallback card when `preview?callId=` fails (web: `暂无输出内容`).
    public static func fallback(step: ToolStep) -> PreviewItem {
        PreviewItem(row: ["kind": .string("tool"), "id": .string(step.id), "title": .string(step.toolName), "status": .string(step.status), "content": .string(step.preview.isEmpty ? "暂无输出内容" : step.preview)])
    }
}

// MARK: - Bodies

struct IDVersion: Encodable { let id: String; let version: Int }
struct BotCreateBody: Encodable { let name: String; let instructions: String? }
struct BotUpdateBody: Encodable { let id: String; let name: String; let instructions: String?; let version: Int; let expertise: [String]? }
struct AppearanceBody: Encodable { let id: String; let appearance: AppearanceChoice; let version: Int }
struct PolicyBody: Encodable { let id: String; let version: Int; let tools: [String] }
struct RoutineToggleBody: Encodable { let id: String; let version: Int; let enabled: Bool }
struct RoutineRunBody: Encodable { let id: String; let clientId: String }
struct ConnectorToggleBody: Encodable { let id: String; let version: Int; let enabled: Bool }
struct ConnectorGrantBody: Encodable { let id: String; let version: Int; let botId: String; let tools: [String] }
struct NameBody: Encodable { let name: String }
struct IDBody: Encodable { let id: String }
struct RootBody: Encodable { let root: String }
struct ReconcileBody: Encodable { let callId: String; let version: Int }
struct BotQuery: Encodable { let botId: String; let query: String }
struct BotRef: Encodable { let botId: String; let ref: String }
struct ForgetBody: Encodable { let botId: String; let query: String; let revision: String }
struct MemoryDeleteBody: Encodable { let id: String; let version: Int }
struct IDResult: Decodable, Sendable {
    let id: String
    init(from decoder: Decoder) throws { id = try decoder.container(keyedBy: AnyKey.self).lenient(.init("id"))?.stringValue ?? "" }
}
struct CountResult: Decodable, Sendable {
    let count: Int
    init(from decoder: Decoder) throws { count = try decoder.container(keyedBy: AnyKey.self).lenient(.init("count"))?.intValue ?? 0 }
}
struct ProviderResult: Decodable, Sendable {
    let provider: String
    init(from decoder: Decoder) throws { provider = try decoder.container(keyedBy: AnyKey.self).lenient(.init("provider"))?.stringValue ?? "" }
}

// MARK: - Client calls

extension CoreClient {
    private func post<T: Decodable & Sendable, B: Encodable>(_ path: String, _ body: B, timeout: TimeInterval, as: T.Type = T.self) async throws -> T {
        try await send(request(path, query: [], body: JSONEncoder().encode(body), timeout: timeout), as: T.self)
    }

    // Agents
    /// `POST /api/bots`. Returns the new bot id.
    public func createBot(name: String, instructions: String? = nil) async throws -> String {
        try await post("/api/bots", body: BotCreateBody(name: name, instructions: instructions), as: IDResult.self).id
    }
    /// `POST /api/bots/update`. `version` is `Bot.version`; `expertise` is only sent when non-nil.
    public func updateBot(id: String, name: String, instructions: String?, version: Int, expertise: [String]? = nil) async throws {
        try await post("/api/bots/update", body: BotUpdateBody(id: id, name: name, instructions: instructions, version: version, expertise: expertise))
    }
    /// `POST /api/bots/appearance`. `version` is `Bot.appearanceVersion`.
    public func updateAppearance(id: String, appearance: AppearanceChoice, version: Int) async throws {
        try await post("/api/bots/appearance", body: AppearanceBody(id: id, appearance: appearance, version: version))
    }
    /// `POST /api/bots/policy`. `version` is `Bot.policyVersion`.
    public func updatePolicy(id: String, version: Int, tools: [String]) async throws {
        try await post("/api/bots/policy", body: PolicyBody(id: id, version: version, tools: tools))
    }
    /// `POST /api/bots/archive`. `version` is `Bot.version`.
    public func archiveBot(id: String, version: Int) async throws { try await post("/api/bots/archive", body: IDVersion(id: id, version: version)) }
    /// `POST /api/resume` for a paused task.
    public func resume(task: String) async throws { try await post("/api/resume", body: TaskBody(taskId: task)) }

    // Routines
    /// `POST /api/routines`. Returns the routine id.
    public func saveRoutine(_ draft: RoutineDraft) async throws -> String { try await post("/api/routines", body: RoutineBody(draft), as: IDResult.self).id }
    public func toggleRoutine(id: String, version: Int, enabled: Bool) async throws {
        try await post("/api/routines/toggle", body: RoutineToggleBody(id: id, version: version, enabled: enabled))
    }
    /// `POST /api/routines/run`. The same `clientID` is idempotent.
    public func runRoutine(id: String, clientID: String) async throws { try await post("/api/routines/run", body: RoutineRunBody(id: id, clientId: clientID)) }

    // Connectors
    /// `POST /api/connectors/save`. Returns the connector id.
    public func saveConnector(_ draft: ConnectorDraft) async throws -> String { try await post("/api/connectors/save", body: draft, as: IDResult.self).id }
    /// `POST /api/connectors/test` (Core waits up to 15 s). Returns the tool count.
    public func testConnector(id: String, version: Int) async throws -> Int {
        try await post("/api/connectors/test", IDVersion(id: id, version: version), timeout: 40, as: CountResult.self).count
    }
    public func grantConnector(id: String, version: Int, botID: String, tools: [String]) async throws {
        try await post("/api/connectors/grant", body: ConnectorGrantBody(id: id, version: version, botId: botID, tools: tools))
    }
    public func toggleConnector(id: String, version: Int, enabled: Bool) async throws {
        try await post("/api/connectors/toggle", body: ConnectorToggleBody(id: id, version: version, enabled: enabled))
    }
    public func deleteConnector(id: String, version: Int) async throws { try await post("/api/connectors/delete", body: IDVersion(id: id, version: version)) }

    // Devices and node
    /// `POST /api/devices`. The token is shown only once.
    public func pairDevice(name: String) async throws -> DevicePairing { try await post("/api/devices", body: NameBody(name: name)) }
    public func revokeDevice(id: String) async throws { try await post("/api/devices/revoke", body: IDBody(id: id)) }
    /// `POST /api/node`: sets the backend-readable directory. Loopback clients only; others get 403.
    public func configureNode(root: String) async throws -> NodeState { try await post("/api/node", body: RootBody(root: root)) }
    /// `POST /api/node/reconcile`. Loopback clients only.
    public func reconcileNode(callID: String, version: Int) async throws { try await post("/api/node/reconcile", body: ReconcileBody(callId: callID, version: version)) }

    // Settings
    /// `POST /api/config`. Refused while any task runs.
    public func saveModel(_ settings: ModelSettings) async throws { try await post("/api/config", body: settings) }
    /// `POST /api/plugins/memory`. Owner only; takes effect after the Core restarts.
    public func saveMemoryPlugin(_ settings: MemoryPluginSettings) async throws -> MemoryPluginState {
        try await post("/api/plugins/memory", settings, timeout: 40)
    }
    /// `POST /api/plugins/memory/test`. Returns the provider id.
    public func testMemoryPlugin(_ settings: MemoryPluginSettings) async throws -> String {
        try await post("/api/plugins/memory/test", settings, timeout: 40, as: ProviderResult.self).provider
    }

    // Memory
    public func saveMemory(_ draft: MemoryDraft) async throws -> MemorySaveResult { try await post("/api/memory", body: draft) }
    public func deleteMemory(id: String, version: Int) async throws { try await post("/api/memory/delete", body: MemoryDeleteBody(id: id, version: version)) }
    public func recallMemory(bot: String, query: String) async throws -> MemoryRecall {
        try await post("/api/memory/recall", BotQuery(botId: bot, query: query), timeout: 40)
    }
    /// `POST /api/memory/reflect`. Calls the model; can take up to 120 s.
    public func reflectMemory(bot: String, query: String) async throws -> MemoryReflection {
        try await post("/api/memory/reflect", BotQuery(botId: bot, query: query), timeout: 130)
    }
    public func expandMemory(bot: String, ref: String) async throws -> MemoryExpansion { try await post("/api/memory/expand", body: BotRef(botId: bot, ref: ref)) }
    public func previewForget(bot: String, query: String) async throws -> ForgetPreview { try await post("/api/memory/forget-preview", body: BotQuery(botId: bot, query: query)) }
    /// `POST /api/memory/forget` with the preview's `revision`.
    public func forget(bot: String, query: String, revision: String) async throws -> ForgetResult {
        try await post("/api/memory/forget", body: ForgetBody(botId: bot, query: query, revision: revision))
    }

    // Preview
    /// `GET /api/preview?path=`.
    public func preview(path: String) async throws -> PreviewItem { try await get("/api/preview", query: [("path", path)]) }
    /// `GET /api/preview?callId=`.
    public func preview(callID: String) async throws -> PreviewItem { try await get("/api/preview", query: [("callId", callID)]) }
}

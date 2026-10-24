import Foundation

/// Parses a JSON text column (`policy_json`, `arguments_json`, ...). Nil for nil, empty or invalid text.
func parseJSONText(_ raw: String?) -> JSONValue? {
    guard let raw, let data = raw.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(JSONValue.self, from: data)
}

/// Pretty-prints JSON text (sorted keys); returns the input unchanged when it is not JSON.
public func prettyJSON(_ raw: String) -> String {
    guard let value = parseJSONText(raw) else { return raw }
    return prettyJSON(value) ?? raw
}
public func prettyJSON(_ value: JSONValue) -> String? {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) }
}

// MARK: - Routines

public enum ScheduleKind: String, Sendable, Codable, CaseIterable {
    case daily, interval, once
    /// Select labels of the web editor.
    public var title: String { switch self { case .daily: "每天"; case .interval: "固定间隔"; case .once: "指定时间执行一次" } }
}

/// `routines[]`: a scheduled prompt of one bot. Echo ``version`` on edit and toggle.
public struct Routine: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var botID: String { row.string("bot_id") ?? "" }
    public var name: String { row.string("name") ?? "" }
    public var prompt: String { row.string("prompt") ?? "" }
    public var scheduleKind: ScheduleKind { ScheduleKind(rawValue: row.string("schedule_kind") ?? "") ?? .daily }
    public var intervalMs: Int { row.int("interval_ms") ?? 0 }
    public var intervalMinutes: Int { intervalMs / 60_000 }
    /// "HH:mm" for daily routines.
    public var localTime: String? { row.string("local_time") }
    public var timeZone: String { row.string("time_zone") ?? TimeZone.current.identifier }
    public var enabled: Bool { row.bool("enabled") ?? false }
    public var nextDueAt: Date? { dateFromMilliseconds(row.double("next_due_at")) }
    public var version: Int { row.int("version") ?? 1 }
    public var createdAt: Date? { dateFromMilliseconds(row.double("created_at")) }
    /// 每天 09:00 · Asia/Shanghai / 每 60 分钟 / 一次性任务.
    public var label: String { routineLabel(self) }
}

/// Port of the web `routineLabel`.
public func routineLabel(_ routine: Routine) -> String {
    switch routine.scheduleKind {
    case .daily: "每天 \(routine.localTime ?? "") · \(routine.timeZone)"
    case .interval: "每 \(routine.intervalMinutes) 分钟"
    case .once: "一次性任务"
    }
}

/// `occurrences[]`: one scheduled or manual run of a routine, joined with the routine's `bot_id` and `name`.
public struct RoutineOccurrence: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var routineID: String { row.string("routine_id") ?? "" }
    public var routineVersion: Int { row.int("routine_version") ?? 0 }
    public var scheduledAt: Date? { dateFromMilliseconds(row.double("scheduled_at")) }
    /// `pending`, `running`, `succeeded`, `failed` or `cancelled`.
    public var status: String { row.string("status") ?? "" }
    public var statusText: String { ToolLabels.statusText(status) }
    public var taskID: String? { row.string("task_id") }
    public var botID: String { row.string("bot_id") ?? "" }
    public var name: String { row.string("name") ?? "" }
    /// "已完成 · 10/17 09:00" as in the web 最近执行 list.
    public var summary: String { "\(statusText) · \(scheduledAt.map { TimeFormat.formatTime($0) } ?? "")" }
}

// MARK: - Connectors

/// One tool of a connector's catalog.
public struct ConnectorTool: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var name: String { row.string("name") ?? "" }
    public var id: String { name }
    public var toolDescription: String { row.string("description") ?? "" }
    /// Web fallback text when empty: 服务未提供工具说明.
    public var displayDescription: String { toolDescription.isEmpty ? "服务未提供工具说明" : toolDescription }
    public var inputSchema: JSONValue? { row["inputSchema"] }
    public var inputSchemaText: String { inputSchema.flatMap(prettyJSON) ?? "" }
}

/// Tools of one connector that one bot may call.
public struct ConnectorGrant: Sendable, Hashable, Codable {
    public var botID: String
    public var tools: [String]
    public init(botID: String, tools: [String]) { self.botID = botID; self.tools = tools }
}

/// `connectors[]`. Never carries the token. Echo ``version`` on every mutation.
public struct ConnectorView: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var provider: String { row.string("provider") ?? "mcp" }
    public var isGmail: Bool { provider == "gmail" }
    public var account: String? { row.string("account") }
    public var name: String { row.string("name") ?? "" }
    public var url: String { row.string("url") ?? "" }
    /// `http` (Streamable HTTP) or `sse`.
    public var transport: String { row.string("transport") == "sse" ? "sse" : "http" }
    public var transportLabel: String { transport == "sse" ? "SSE" : "Streamable HTTP" }
    public var enabled: Bool { row.bool("enabled") ?? true }
    public var version: Int { row.int("version") ?? 1 }
    public var hasToken: Bool { row.bool("hasToken") ?? false }
    public var tools: [ConnectorTool] { row["tools"]?.arrayValue?.compactMap(\.objectValue).map(ConnectorTool.init) ?? [] }
    /// Last successful test time; nil while untested.
    public var checkedAt: Date? { dateFromMilliseconds(row.double("checkedAt")) }
    public var error: String? { row.string("error").flatMap { $0.isEmpty ? nil : $0 } }
    public var grants: [ConnectorGrant] {
        row["grants"]?.arrayValue?.compactMap(\.objectValue).map {
            ConnectorGrant(botID: $0.string("botId") ?? "", tools: $0["tools"]?.arrayValue?.compactMap(\.stringValue) ?? [])
        } ?? []
    }
    public func grant(for botID: String) -> ConnectorGrant? { grants.first { $0.botID == botID } }
    /// List subtitle: 已停用 / 需要检查 / N 个工具 / 尚未测试.
    public var subtitle: String { !enabled ? "已停用" : error != nil ? "需要检查" : checkedAt != nil ? "\(tools.count) 个工具" : "尚未测试" }
    /// Detail chip: 已停用 / 连接异常 / 连接测试通过 / 等待测试.
    public var statusChip: String { !enabled ? "已停用" : isGmail && !hasToken ? "需要重新授权" : error != nil ? "连接异常" : checkedAt != nil ? (isGmail ? "已连接" : "连接测试通过") : "等待测试" }
    public var isReady: Bool { enabled && checkedAt != nil && error == nil && (!isGmail || hasToken) }
    /// `Bearer Token · 已加密保存` or `无需令牌`.
    public var authLabel: String { isGmail ? "搜索和读取邮件" : hasToken ? "Bearer Token · 已加密保存" : "无需令牌" }
}

// MARK: - Devices and node

/// `devices[]`. ``online`` comes from `onlineDevices`.
public struct Device: RowBacked {
    public let row: Row
    public let online: Bool
    public init(row: Row) { self.row = row; online = false }
    public init(row: Row, online: Bool) { self.row = row; self.online = online }
    public var name: String { row.string("name") ?? "" }
    /// `bound` or `revoked`.
    public var status: String { row.string("status") ?? "bound" }
    public var isBound: Bool { status != "revoked" }
    public var isRevoked: Bool { status == "revoked" }
    public var capabilities: JSONValue? { parseJSONText(row.string("capabilities_json")) ?? row["capabilities_json"] }
    /// 已撤销 / 在线 / 离线.
    public var statusText: String { isRevoked ? "已撤销" : online ? "在线" : "离线" }
}

/// `{deviceId, token}` returned once by `devices`. The token is shown only now.
public struct DevicePairing: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var deviceID: String { row.string("deviceId") ?? "" }
    public var token: String { row.string("token") ?? "" }
}

/// A device call interrupted by a restart. It is never replayed; the user confirms it stopped.
public struct UnknownCall: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var callID: String { row.string("call_id") ?? "" }
    public var id: String { callID }
    public var capability: String { row.string("capability") ?? "" }
    public var argumentsJSON: String { row.string("arguments_json") ?? "" }
    public var argumentsText: String { prettyJSON(argumentsJSON) }
    public var version: Int { row.int("version") ?? 0 }
}

/// `node`: the host-device node. Changing it needs a loopback client; remote clients show it read-only.
public struct NodeState: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var id: String { deviceID }
    public var status: String { row.string("status") ?? "" }
    public var origin: String { row.string("origin") ?? "" }
    /// Directory the backend may read; empty when unrestricted.
    public var root: String { row.string("root") ?? "" }
    public var exec: Bool { row.bool("exec") ?? false }
    public var computer: Bool { row.bool("computer") ?? false }
    public var computerSupported: Bool { row.bool("computerSupported") ?? false }
    public var deviceID: String { row.string("deviceId") ?? "" }
    public var connected: Bool { row.bool("connected") ?? false }
    public var unknownCalls: [UnknownCall] { row["unknownCalls"]?.arrayValue?.compactMap(\.objectValue).map(UnknownCall.init) ?? [] }
    /// True when Core runs with `hostDevice:false` (the user brings their own devices).
    public var hosted: Bool { row.bool("hosted") ?? false }
    /// 连接状态：ready · 终端可用 · 窗口控制暂不支持
    public var summary: String {
        "连接状态：\(status) · 终端\(exec ? "可用" : "不可用") · 窗口控制\(computerSupported ? "可用" : "暂不支持")"
    }
}

// MARK: - Model and memory service

/// `config`: the model connection. Absent from the state until configured. The API key is never returned.
public struct ModelConfig: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    /// `openai` or `anthropic`.
    public var providerID: String { row.string("provider_id") ?? "openai" }
    public var endpoint: String { row.string("endpoint") ?? "" }
    public var defaultModel: String { row.string("default_model") ?? "" }
    public var configured: Bool { row.bool("configured") ?? true }
}

/// `memoryEngine`: the semantic memory engine (Hindsight) health.
public struct MemoryEngineStatus: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var provider: String { row.string("provider") ?? "" }
    public var release: String { row.string("release") ?? "" }
    /// `not_installed`, `unavailable` or `connected`.
    public var status: String { row.string("status") ?? "" }
    /// Changes whenever memory content changes; the workbench resets on it.
    public var revision: String { row.string("revision") ?? "" }
    public var forgetting: Int { row.int("forgetting") ?? 0 }
    public var pending: Int { row.int("pending") ?? 0 }
    public var failed: Int { row.int("failed") ?? 0 }
    public var quarantined: Int { row.int("quarantined") ?? 0 }
    public var error: String? { row.string("error") }
    /// The plugin service status, e.g. `starting`.
    public var service: String? { row.string("service") }
    /// The footnote under the memory workbench.
    public var footnote: String {
        var text: String
        if service == "starting" { text = "正在启动语义记忆服务。" }
        else if status == "connected" { text = "Hindsight 语义记忆已连接。" }
        else if status == "not_installed" { text = "未启用记忆插件，可在主设备设置中连接外部服务；目前使用原始记录检索。" }
        else { text = "语义记忆暂不可用，目前使用原始记录检索。" }
        if pending > 0 { text += " \(pending) 项待同步。" }
        if quarantined > 0 { text += " 部分记忆正在清理或更新，旧的派生结果已暂停读取。" }
        return text
    }
}

/// A memory provider available to the plugin (`memoryPlugin.providers[]`).
public struct MemoryProvider: Sendable, Hashable, Codable {
    public var id: String
    public var name: String
    public var protocolName: String
    public init(id: String, name: String, protocolName: String) { self.id = id; self.name = name; self.protocolName = protocolName }
}

/// `memoryPlugin` (also the response of `plugins/memory`). Changes apply after the Core restarts.
public struct MemoryPluginState: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var id: String { provider }
    public var providers: [MemoryProvider] {
        row["providers"]?.arrayValue?.compactMap(\.objectValue).map {
            MemoryProvider(id: $0.string("id") ?? "", name: $0.string("name") ?? "", protocolName: $0.string("protocol") ?? "")
        } ?? []
    }
    public var provider: String { row.string("provider") ?? "hindsight" }
    public var enabled: Bool { row.bool("enabled") ?? false }
    public var endpoint: String { row.string("endpoint") ?? "" }
    public var hasToken: Bool { row.bool("hasToken") ?? false }
    public var restartRequired: Bool { row.bool("restartRequired") ?? false }
    /// `disabled`, `connecting`, `ready` or `unavailable`.
    public var status: String { row.string("status") ?? "" }
    public var error: String? { row.string("error").flatMap { $0.isEmpty ? nil : $0 } }
    /// 未启用 / 连接中 / 已连接 / 连接异常 / 状态未知.
    public var statusLabel: String {
        switch status { case "disabled": "未启用"; case "connecting": "连接中"; case "ready": "已连接"; case "unavailable": "连接异常"; default: "状态未知" }
    }
    /// "HTTP API v1 · 0.10.3" for the current provider.
    public var protocolName: String { providers.first { $0.id == provider }?.protocolName ?? "" }
}

// MARK: - Memory, journal, usage, delegation

/// `memories[]`: a long-term memory document. Echo ``version`` on edit and delete.
public struct Memory: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    /// `bot` (private) or `workspace` (shared with all agents).
    public var scope: String { row.string("scope") ?? "bot" }
    public var isShared: Bool { scope == "workspace" }
    /// Null for workspace memories.
    public var botID: String? { row.string("bot_id") }
    public var title: String { row.string("title") ?? "" }
    public var version: Int { row.int("version") ?? 1 }
    public var updatedAt: Date? { dateFromMilliseconds(row.double("updated_at")) }
    public var content: String { row.string("content") ?? "" }
    /// 所有 Agent 共享 / 仅当前 Agent.
    public var scopeLabel: String { isShared ? "所有 Agent 共享" : "仅当前 Agent" }
}

/// `journal[]`: a finished task's record.
public struct JournalEntry: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var taskID: String { row.string("task_id") ?? "" }
    public var id: String { taskID }
    public var botID: String { row.string("bot_id") ?? "" }
    public var objective: String { row.string("objective") ?? "" }
    public var result: String { row.string("result") ?? "" }
    public var createdAt: Date? { dateFromMilliseconds(row.double("created_at")) }
}

/// `usage[]`: model usage per bot.
public struct Usage: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var botID: String { row.string("bot_id") ?? "" }
    public var id: String { botID }
    public var calls: Int { row.int("calls") ?? 0 }
    public var inputTokens: Int { row.int("input_tokens") ?? 0 }
    public var outputTokens: Int { row.int("output_tokens") ?? 0 }
}

/// `delegations[]`: an agent-to-agent hand-off (`a2a_messages`).
public struct Delegation: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var callID: String { row.string("call_id") ?? "" }
    public var parentTaskID: String { row.string("parent_task_id") ?? "" }
    public var senderBotID: String { row.string("sender_bot_id") ?? "" }
    public var receiverBotID: String { row.string("receiver_bot_id") ?? "" }
    public var childConversationID: String? { row.string("child_conversation_id") }
    public var childTaskID: String? { row.string("child_task_id") }
    public var rootTaskID: String? { row.string("root_task_id") }
    public var depth: Int { row.int("depth") ?? 0 }
    public var status: String { row.string("status") ?? "" }
    public var payload: String? { row.string("payload") }
    public var result: String? { row.string("result") }
    public var createdAt: Date? { dateFromMilliseconds(row.double("created_at")) }
    public var finishedAt: Date? { dateFromMilliseconds(row.double("finished_at")) }
}

extension WorkspaceState {
    /// Port of the web "waiting on a peer" lookup: bots reachable from `botID`'s unfinished tasks through up to three
    /// delegation levels that have a pending approval. Returns the peer bot ids.
    public func peersAwaitingApproval(for botID: String) -> [String] {
        var tasks = Set(unfinishedTasks(botID: botID).map(\.id)), peers: [String] = []
        for _ in 0..<3 {
            var next = Set<String>()
            for d in delegations where tasks.contains(d.parentTaskID) {
                if let child = d.childTaskID { next.insert(child) }
                if let child = d.childTaskID, approvals.contains(where: { $0.taskID == child }), !peers.contains(d.receiverBotID) { peers.append(d.receiverBotID) }
            }
            if next.isEmpty { break }
            tasks = next
        }
        return peers
    }
}

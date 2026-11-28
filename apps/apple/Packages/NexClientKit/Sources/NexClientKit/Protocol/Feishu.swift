import Foundation

/// `feishu.job` / `feishu.userAuth`: 扫码注册或主人授权的在途任务。
public struct FeishuJob: Codable, Sendable, Hashable {
    /// The app a user-auth job belongs to (absent for register jobs and older Cores).
    public let appID: String?
    public let stage: String
    public let url: String?
    /// Relative Core scan path (e.g. `/feishu/scan/...`) used as QR target when available.
    public let scanPath: String?
    public let expiresAt: Date?
    public let error: String?
    public init(row: Row) {
        appID = row.string("id")
        stage = row.string("stage") ?? ""
        url = row.string("url")
        scanPath = row.string("scanPath").flatMap { $0.isEmpty ? nil : $0 }
        expiresAt = dateFromMilliseconds(row.double("expiresAt"))
        error = row.string("error").flatMap { $0.isEmpty ? nil : $0 }
    }
    public var isRunning: Bool { stage == "preparing" || stage == "qr" || stage == "polling" }
    /// Preferred QR payload: Core-hosted scanPath if present and valid, else the direct Feishu URL.
    public func qrValue(origin: CoreOrigin) -> String? {
        if let scanPath, scanPath.hasPrefix("/") {
            let base = origin.url.absoluteString
            let trimmed = base.hasSuffix("/") ? String(base.dropLast()) : base
            return trimmed + scanPath
        }
        return url
    }
}

/// `feishu.apps[]`：一个飞书自建应用绑定一个助手。凭据不下发。
public struct FeishuAppView: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var id: String { row.string("id") ?? "" }
    public var appID: String { row.string("appId") ?? "" }
    public var brand: String { row.string("brand") == "lark" ? "lark" : "feishu" }
    public var status: String { row.string("status") ?? "idle" }
    public var error: String? { row.string("error").flatMap { $0.isEmpty ? nil : $0 } }
    public var ownerBound: Bool { row.bool("ownerBound") ?? false }
    public var botID: String { row.string("botId") ?? "" }
    public var botName: String { row.string("botName") ?? "" }
    public var enabled: Bool { row.bool("enabled") ?? true }
    public var version: Int { row.int("version") ?? 1 }
    public var userAuthorized: Bool { row.bool("userAuthorized") ?? false }
    public var userScopes: [String] { row["userScopes"]?.arrayValue?.compactMap(\.stringValue) ?? [] }
    public var userExpiresAt: Date? { dateFromMilliseconds(row.double("userExpiresAt")) }
    /// The bot's own name in Feishu (from `/bot/v3/info`); nil until the app has connected once.
    public var name: String? { row.string("name").flatMap { $0.isEmpty ? nil : $0 } }
    public var profileStatus: String? { row.string("profileStatus") }
    public var avatarURL: URL? { row.string("avatarUrl").flatMap(URL.init(string:)) }
    public var groupCount: Int { row.int("groupCount") ?? 0 }
    public var displayName: String { name ?? (botName.isEmpty ? appID : botName) }
    public var statusLabel: String {
        switch status {
        case "connected": "已连接"
        case "busy": "已在其他位置连接"
        case "disabled": "已停用"
        case "error": "连接异常"
        default: "未连接"
        }
    }
    public var userAuthLabel: String {
        userAuthorized ? "已授权 · \(userScopes.count) 项权限" : "未授权"
    }
}

/// `feishu` block of the state snapshot. Absent on older Cores.
public struct FeishuState: Codable, Sendable, Hashable {
    public let job: FeishuJob?
    public let userAuth: FeishuJob?
    public let apps: [FeishuAppView]
    public init(row: Row) {
        job = row["job"]?.objectValue.map(FeishuJob.init)
        userAuth = row["userAuth"]?.objectValue.map(FeishuJob.init)
        apps = row["apps"]?.arrayValue?.compactMap(\.objectValue).map(FeishuAppView.init) ?? []
    }
    public var app: FeishuAppView? { apps.first }
    public func app(_ id: String) -> FeishuAppView? { apps.first { $0.id == id } }
    /// True while a register or user-auth job may still change state (drives polling).
    public var needsPolling: Bool { job?.isRunning == true || userAuth?.isRunning == true }
}

/// One Feishu group the app's bot is in, with its reply mode and the owner's context (`GET /api/feishu/groups`).
public struct FeishuGroup: RowBacked {
    public var avatarPath: String? { row.string("avatarUrl") }
    public let row: Row
    public init(row: Row) { self.row = row }
    public var id: String { chatID }
    public var chatID: String { row.string("chatId") ?? "" }
    public var name: String { row.string("name").flatMap { $0.isEmpty ? nil : $0 } ?? chatID }
    /// "topic" for Feishu topic groups: one conversation per topic, no session choice.
    public var isTopicGroup: Bool { row.string("kind") == "topic" }
    public var members: Int? { row.int("members") }
    /// Unclaimed groups cannot run anything until the owner saves their settings.
    public var claimed: Bool { row.bool("claimed") ?? false }
    public var trigger: String { row.string("trigger") ?? "topic" }
    public var session: String { row.string("session") ?? "new-topic" }
    public var context: String { row.string("context") ?? "" }
    public var version: Int { row.int("version") ?? 1 }

    public static let triggers: [(id: String, title: String, hint: String)] = [
        ("always", "必须 @", "只回复 @ 它的消息"),
        ("topic", "话题内免 @", "它参与过的话题里不用 @"),
        ("ambient", "默认应答", "回复所有消息，有人 @ 别人时不插话"),
        ("never", "全部回复", "回复群里每条消息"),
    ]
    public static let sessions: [(id: String, title: String, hint: String)] = [
        ("chat-topic", "群聊共享，话题独立", "直接发的消息共用一个会话，每个话题各一个"),
        ("chat", "整群一个会话", "群里所有消息共用一个会话"),
        ("new-topic", "每次 @ 开新话题", "每次 @ 都新开话题，在话题里继续"),
    ]
    public static let contextLimit = 2000

    public var summary: String { summary(showConnection: true) }

    public func summary(showConnection: Bool) -> String {
        var parts = [isTopicGroup ? "话题群" : "普通群"]
        if let members { parts.append("\(members) 人") }
        if !claimed && showConnection { parts.append("未开放") }
        if claimed {
            parts.append(Self.triggers.first { $0.id == trigger }?.title ?? trigger)
            parts.append(isTopicGroup ? "每个话题一个会话" : Self.sessions.first { $0.id == session }?.title ?? session)
            if !context.isEmpty { parts.append("已设上下文") }
        }
        return parts.joined(separator: " · ")
    }
}
public struct FeishuGroupList: Decodable, Sendable { public let groups: [FeishuGroup]; public let error: String?; public let cacheForMs: Int? }

// MARK: - Shared Feishu delivery, finance channel & outbox reconciliation

public struct FeishuSharedApp: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var id: String { appID }
    public var appID: String { row.string("appId") ?? "" }
    public var brand: String { row.string("brand") ?? "feishu" }
    public var bound: Bool { row.bool("bound") ?? false }
    public var canManageChannel: Bool { row.bool("canManageChannel") ?? false }
    public var status: String? { row.string("status") }
    public var tenantKey: String? { row.string("tenantKey") }
    public var bindingVersion: Int? { row.int("bindingVersion") }
}

public struct FeishuDestination: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var id: String { "\(appID):\(chatID)" }
    public var appID: String { row.string("app_id") ?? "" }
    public var chatID: String { row.string("chat_id") ?? "" }
    public var chatType: String { row.string("chat_type") ?? "" }
    public var enabled: Bool { (row.int("enabled") ?? 0) != 0 || (row.bool("enabled") ?? false) }
}

public struct FeishuSubscription: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var appID: String { row.string("app_id") ?? "" }
    public var chatID: String { row.string("chat_id") ?? "" }
    public var instanceID: String { row.string("instance_id") ?? "" }
    public var kinds: [String] { row["kinds"]?.arrayValue?.compactMap(\.stringValue) ?? [] }
    public var scenarios: [String] { row["scenarios"]?.arrayValue?.compactMap(\.stringValue) ?? [] }
    public var audience: String { row.string("audience") ?? "private" }
    public var enabled: Bool { (row.int("enabled") ?? 0) != 0 || (row.bool("enabled") ?? false) }
    public var version: Int { row.int("version") ?? 0 }
}

public struct FeishuSubscriptionSaveBody: Encodable, Sendable {
    public let appId: String
    public let chatId: String
    public let instanceId: String
    public let kinds: [String]
    public let scenarios: [String]
    public let audience: String
    public let enabled: Bool
    public let version: Int?
    public init(appId: String, chatId: String, instanceId: String, kinds: [String], scenarios: [String], audience: String, enabled: Bool, version: Int? = nil) {
        self.appId = appId; self.chatId = chatId; self.instanceId = instanceId; self.kinds = kinds
        self.scenarios = scenarios; self.audience = audience; self.enabled = enabled; self.version = version
    }
}

public struct FeishuFinanceChannel: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var id: String { appID }
    public var appID: String { row.string("appId") ?? "" }
    public var version: Int { row.int("version") ?? 0 }
    /// `"stock"`, `"paused"`, or `"core"`.
    public var owner: String { row.string("owner") ?? "paused" }
    public var reportsError: String? { row["reports"]?.objectValue?.string("error").flatMap { $0.isEmpty ? nil : $0 } }
    public var ownerLabel: String {
        switch owner {
        case "stock": "nex_stock"
        case "core": "NexBot"
        default: "已暂停"
        }
    }
}

public struct FeishuDeliveryReconciliation: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var id: String { "\(recordedAt?.timeIntervalSince1970 ?? 0):\(action):\(evidence)" }
    public var action: String { row.string("action") ?? "" }
    public var actor: String { row.string("actor") ?? "" }
    public var evidence: String { row.string("evidence") ?? "" }
    public var messageID: String? { row.string("message_id").flatMap { $0.isEmpty ? nil : $0 } }
    public var recordedAt: Date? { dateFromMilliseconds(row.double("recorded_at")) }
}

public struct FeishuDeliveryPart: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var sourceKey: String { row.string("source_key") ?? "" }
    public var appID: String { row.string("app_id") ?? "" }
    public var chatID: String { row.string("chat_id") ?? "" }
    public var conversationID: String { row.string("conversation_id") ?? "" }
    public var part: Int { row.int("part") ?? 0 }
    public var state: String { row.string("state") ?? "" }
    public var operation: String { row.string("operation") ?? "" }
    public var content: String { row.string("content") ?? "" }
    public var attempts: Int { row.int("attempts") ?? 0 }
    public var firstPostAt: Date? { dateFromMilliseconds(row.double("first_post_at")) }
    public var dedupUntil: Date? { dateFromMilliseconds(row.double("dedupUntil")) }
    public var messageID: String? { row.string("message_id").flatMap { $0.isEmpty ? nil : $0 } }
    public var error: String? { row.string("error").flatMap { $0.isEmpty ? nil : $0 } }
    public var reconciliation: [FeishuDeliveryReconciliation] {
        row["reconciliation"]?.arrayValue?.compactMap(\.objectValue).map(FeishuDeliveryReconciliation.init) ?? []
    }
    public var stateLabel: String {
        switch state {
        case "pending": "等待发送"
        case "sending": "正在发送"
        case "sent": "已送达"
        case "cancelled": "已取消"
        case "needs_reconciliation": "待人工对账"
        default: state
        }
    }
    public var previewText: String {
        guard let data = content.data(using: .utf8),
              let parsed = try? JSONDecoder().decode(JSONValue.self, from: data),
              let elements = parsed["elements"]?.arrayValue else { return content }
        let lines = elements.compactMap { $0["content"]?.stringValue }
        return lines.isEmpty ? content : lines.joined(separator: "\n")
    }
}

private struct FeishuAppIDBody: Encodable { let appId: String }
private struct FeishuClaimBody: Encodable { let appId: String; let chatId: String }
private struct FeishuChannelTransferBody: Encodable { let appId: String; let expectedVersion: Int; let owner: String }
private struct FeishuDeliveriesResponse: Decodable, Sendable { let parts: [FeishuDeliveryPart] }
private struct FeishuReconcileBody: Encodable {
    let id: String
    let action: String
    let messageId: String
    let evidence: String
    let confirmedNotDelivered: Bool
}

extension CoreClient {
    public func feishuAccounts() async throws -> [FeishuSharedApp] {
        try await get("/api/feishu/accounts")
    }
    public func feishuAccountBind(appID: String) async throws -> String {
        struct CodeRes: Decodable, Sendable { let code: String }
        return try await post("/api/feishu/accounts/bind", body: FeishuAppIDBody(appId: appID), as: CodeRes.self).code
    }
    public func feishuAccountUnbind(appID: String) async throws {
        try await post("/api/feishu/accounts/unbind", body: FeishuAppIDBody(appId: appID))
    }
    public func feishuAccountClaim(appID: String, chatID: String) async throws {
        try await post("/api/feishu/accounts/claim", body: FeishuClaimBody(appId: appID, chatId: chatID))
    }
    public func feishuDestinations() async throws -> [FeishuDestination] {
        try await get("/api/feishu/destinations")
    }
    public func feishuSubscriptions() async throws -> [FeishuSubscription] {
        try await get("/api/feishu/subscriptions")
    }
    public func saveFeishuSubscription(_ body: FeishuSubscriptionSaveBody) async throws {
        try await post("/api/feishu/subscriptions", body: body)
    }
    public func financeChannel() async throws -> FeishuFinanceChannel {
        try await get("/api/finance/channel")
    }
    public func transferFinanceChannel(appID: String, expectedVersion: Int, owner: String) async throws -> FeishuFinanceChannel {
        try await post("/api/finance/channel", body: FeishuChannelTransferBody(appId: appID, expectedVersion: expectedVersion, owner: owner), as: FeishuFinanceChannel.self)
    }
    public func feishuDeliveries() async throws -> [FeishuDeliveryPart] {
        let res: FeishuDeliveriesResponse = try await get("/api/feishu/deliveries")
        return res.parts
    }
    public func reconcileFeishuDelivery(id: String, action: String, messageID: String, evidence: String, confirmedNotDelivered: Bool) async throws {
        try await post("/api/feishu/deliveries/reconcile", body: FeishuReconcileBody(id: id, action: action, messageId: messageID, evidence: evidence, confirmedNotDelivered: confirmedNotDelivered))
    }
}

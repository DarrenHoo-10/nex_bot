import Foundation

/// `feishu.job` / `feishu.userAuth`: 扫码注册或主人授权的在途任务。
public struct FeishuJob: Codable, Sendable, Hashable {
    /// The app a user-auth job belongs to (absent for register jobs and older Cores).
    public let appID: String?
    public let stage: String
    public let url: String?
    public let expiresAt: Date?
    public let error: String?
    public init(row: Row) {
        appID = row.string("id")
        stage = row.string("stage") ?? ""
        url = row.string("url")
        expiresAt = dateFromMilliseconds(row.double("expiresAt"))
        error = row.string("error").flatMap { $0.isEmpty ? nil : $0 }
    }
    public var isRunning: Bool { stage == "preparing" || stage == "qr" || stage == "polling" }
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

    public var summary: String {
        var parts = [isTopicGroup ? "话题群" : "普通群"]
        if let members { parts.append("\(members) 人") }
        if !claimed { parts.append("未接入") } else {
            parts.append(Self.triggers.first { $0.id == trigger }?.title ?? trigger)
            parts.append(isTopicGroup ? "每个话题一个会话" : Self.sessions.first { $0.id == session }?.title ?? session)
            if !context.isEmpty { parts.append("已设上下文") }
        }
        return parts.joined(separator: " · ")
    }
}
public struct FeishuGroupList: Decodable, Sendable { public let groups: [FeishuGroup]; public let error: String? }

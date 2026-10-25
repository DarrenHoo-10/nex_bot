import Foundation

/// `feishu.job` / `feishu.userAuth`: 扫码注册或主人授权的在途任务。
public struct FeishuJob: Codable, Sendable, Hashable {
    public let stage: String
    public let url: String?
    public let expiresAt: Date?
    public let error: String?
    public init(row: Row) {
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
    /// True while a register or user-auth job may still change state (drives polling).
    public var needsPolling: Bool { job?.isRunning == true || userAuth?.isRunning == true }
}

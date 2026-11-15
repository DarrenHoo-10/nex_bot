import Foundation

public struct ConnectorCatalogEntry: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var name: String { row.string("name") ?? id }
    public var available: Bool { row.bool("available") ?? false }
}

public struct ConnectorOAuthAttempt: Decodable, Sendable, Equatable {
    public let id: String
    /// Web flows (Gmail, a configured GitHub OAuth app) redirect the browser; the device flow has none.
    public let authorizationUrl: String?
    /// Device-code flow (GitHub without a configured OAuth app): the code the user types in.
    public let userCode: String?
    public let verificationUri: String?
    public let expiresAt: Double
}

public struct ConnectorOAuthStatus: Decodable, Sendable {
    public let id: String
    public let status: String
    public let connectorId: String?
    public let error: String?
}

public enum GmailTools {
    public static let names = ["gmail.search", "gmail.read", "gmail.thread"]
    public static func label(_ name: String) -> String {
        switch name {
        case "gmail.search": "搜索邮件"
        case "gmail.read": "读取邮件"
        case "gmail.thread": "读取邮件会话"
        default: name
        }
    }
    public static func detail(_ name: String) -> String {
        switch name {
        case "gmail.search": "按关键词、发件人和时间查找邮件。"
        case "gmail.read": "查看邮件正文与附件信息。"
        case "gmail.thread": "查看同一会话中的往来邮件。"
        default: ""
        }
    }

    /// Authorization opens in the system browser; Core alone receives the callback.
    public static func authorizationURL(_ raw: String, origin: CoreOrigin, allowLoopbackFixture: Bool = false) throws -> URL {
        let failure = CoreError(kind: .unsupported, message: "Google 授权地址无效")
        guard let c = URLComponents(string: raw), let url = c.url,
              c.user == nil, c.password == nil, c.fragment == nil,
              !raw.unicodeScalars.contains(where: { $0.value < 32 }) else { throw failure }
        if c.scheme == "https", c.host == "accounts.google.com", c.port == nil || c.port == 443,
           c.percentEncodedPath == "/o/oauth2/v2/auth" { return url }
        #if DEBUG
        if allowLoopbackFixture, !origin.isHTTPS, origin.host == "127.0.0.1",
           c.scheme == "http", c.host == "127.0.0.1", c.port != nil, c.percentEncodedPath == "/authorize" { return url }
        #endif
        throw failure
    }
}

public enum GithubTools {
    public static let names = [
        "github.repos", "github.pr.list", "github.pr", "github.pr.checks", "github.issues.list", "github.issue",
        "github.notifications", "github.actions.runs", "github.actions.log", "github.search",
        "github.comment", "github.review", "github.merge", "github.issue.create",
    ]
    public static func label(_ name: String) -> String {
        switch name {
        case "github.repos": "列出仓库"
        case "github.pr.list": "列出 PR"
        case "github.pr": "读取 PR"
        case "github.pr.checks": "查看 CI"
        case "github.issues.list": "列出 issue"
        case "github.issue": "读取 issue"
        case "github.notifications": "读取通知"
        case "github.actions.runs": "查看 Actions"
        case "github.actions.log": "查看日志"
        case "github.search": "搜索"
        case "github.comment": "评论"
        case "github.review": "评审"
        case "github.merge": "合并"
        case "github.issue.create": "新建 issue"
        default: name
        }
    }
    public static func detail(_ name: String) -> String {
        switch name {
        case "github.repos": "查看你有权访问的仓库。"
        case "github.pr.list": "查看仓库的 Pull Request。"
        case "github.pr": "查看 PR 详情与评审状态。"
        case "github.pr.checks": "读取 PR 的检查结果与失败日志。"
        case "github.issues.list": "查看仓库的 issue。"
        case "github.issue": "查看 issue 详情。"
        case "github.notifications": "查看未读的 GitHub 通知。"
        case "github.actions.runs": "列出 workflow 运行记录。"
        case "github.actions.log": "读取 workflow job 的日志尾部。"
        case "github.search": "全站搜索 issue 与 PR。"
        case "github.comment": "在 issue 或 PR 下评论。"
        case "github.review": "提交 approve 或 request changes。"
        case "github.merge": "合并一个 PR。"
        case "github.issue.create": "在仓库新建 issue。"
        default: ""
        }
    }

    /// The device page opens in the system browser; the user types the code there.
    public static func verificationURL(_ raw: String, origin: CoreOrigin, allowLoopbackFixture: Bool = false) throws -> URL {
        let failure = CoreError(kind: .unsupported, message: "GitHub 设备页地址无效")
        guard let c = URLComponents(string: raw), let url = c.url,
              c.user == nil, c.password == nil, c.fragment == nil, c.query == nil,
              !raw.unicodeScalars.contains(where: { $0.value < 32 }) else { throw failure }
        if c.scheme == "https", c.host == "github.com", c.port == nil || c.port == 443,
           c.percentEncodedPath == "/login/device" { return url }
        #if DEBUG
        if allowLoopbackFixture, !origin.isHTTPS, origin.host == "127.0.0.1",
           c.scheme == "http", c.host == "127.0.0.1", c.port != nil, c.percentEncodedPath == "/login/device" { return url }
        #endif
        throw failure
    }

    /// A configured GitHub OAuth app redirects through github.com like Google does through accounts.google.com.
    public static func authorizationURL(_ raw: String, origin: CoreOrigin, allowLoopbackFixture: Bool = false) throws -> URL {
        let failure = CoreError(kind: .unsupported, message: "GitHub 授权地址无效")
        guard let c = URLComponents(string: raw), let url = c.url,
              c.user == nil, c.password == nil, c.fragment == nil,
              !raw.unicodeScalars.contains(where: { $0.value < 32 }) else { throw failure }
        if c.scheme == "https", c.host == "github.com", c.port == nil || c.port == 443,
           c.percentEncodedPath == "/login/oauth/authorize" { return url }
        #if DEBUG
        if allowLoopbackFixture, !origin.isHTTPS, origin.host == "127.0.0.1",
           c.scheme == "http", c.host == "127.0.0.1", c.port != nil, c.percentEncodedPath == "/login/oauth/authorize" { return url }
        #endif
        throw failure
    }
}

/// One GitHub watch configuration; the webhook secret is never echoed after creation.
public struct ConnectorMonitor: Codable, Sendable, Equatable {
    public let id: String
    public let connectorId: String
    public let name: String
    public let botId: String
    public let repos: [String]
    public let ciMode: String
    public let mutedRepos: [String]
    public let ignoreBranches: [String]
    public let delivery: String
    public let enabled: Bool
    public let intervalSeconds: Int
    public let webhookConfigured: Bool
    public let lastRunAt: Double?
    public let lastError: String?
    public let version: Int
}

public struct ConnectorMonitorSaved: Codable, Sendable {
    public let monitor: ConnectorMonitor
    public let webhookSecret: String?
    public let webhookPath: String?
}

public struct ConnectorMonitorBody: Encodable {
    public let id: String?
    public let version: Int?
    public let connectorId: String
    public let botId: String
    public let name: String
    public let repos: [String]
    public let ciMode: String
    public let delivery: String
    public let intervalSeconds: Int
    public let mutedRepos: [String]
    public let ignoreBranches: [String]
    public let enableWebhook: Bool
    public let regenerateWebhookSecret: Bool
}

struct ConnectorOAuthStartBody: Encodable { var provider = "gmail"; let id: String?; let version: Int? }
struct ConnectorOAuthIDBody: Encodable { let id: String }
struct ConnectorDisconnectResult: Decodable, Sendable { public let warning: String? }
struct ConnectorGithubTokenBody: Encodable { let provider = "github"; let token: String }
public struct ConnectorSaved: Decodable, Sendable { public let id: String; public let version: Int }

extension CoreClient {
    public func startConnectorAuthorization(provider: String = "gmail", id: String? = nil, version: Int? = nil) async throws -> ConnectorOAuthAttempt {
        try await post("/api/connectors/oauth/start", body: ConnectorOAuthStartBody(provider: provider, id: id, version: version))
    }
    public func connectorAuthorizationStatus(id: String) async throws -> ConnectorOAuthStatus {
        try await get("/api/connectors/oauth/status", query: [("id", id)])
    }
    public func cancelConnectorAuthorization(id: String) async throws {
        try await post("/api/connectors/oauth/cancel", body: ConnectorOAuthIDBody(id: id))
    }
    /// Local removal may succeed even when the provider revocation fails; preserve its warning.
    public func disconnectConnector(id: String, version: Int) async throws -> String? {
        try await post("/api/connectors/delete", body: IDVersion(id: id, version: version), as: ConnectorDisconnectResult.self).warning
    }
    /// Stores a personal access token as the GitHub connector and returns its row identity for the follow-up test.
    public func saveGithubToken(_ token: String) async throws -> ConnectorSaved {
        try await post("/api/connectors/save", body: ConnectorGithubTokenBody(token: token), as: ConnectorSaved.self)
    }
    public func saveGithubMonitor(_ body: ConnectorMonitorBody) async throws -> ConnectorMonitorSaved {
        struct Response: Codable { let id: String; let version: Int; let connectorId: String; let botId: String; let name: String; let repos: [String]; let ciMode: String; let mutedRepos: [String]; let ignoreBranches: [String]; let delivery: String; let enabled: Bool; let intervalSeconds: Int; let webhookConfigured: Bool; let lastRunAt: Double?; let lastError: String?; let webhookSecret: String?; let webhookPath: String? }
        let saved = try await post("/api/connector-monitors/save", body: body, as: Response.self)
        let monitor = ConnectorMonitor(id: saved.id, connectorId: saved.connectorId, name: saved.name, botId: saved.botId, repos: saved.repos, ciMode: saved.ciMode, mutedRepos: saved.mutedRepos, ignoreBranches: saved.ignoreBranches, delivery: saved.delivery, enabled: saved.enabled, intervalSeconds: saved.intervalSeconds, webhookConfigured: saved.webhookConfigured, lastRunAt: saved.lastRunAt, lastError: saved.lastError, version: saved.version)
        return ConnectorMonitorSaved(monitor: monitor, webhookSecret: saved.webhookSecret, webhookPath: saved.webhookPath)
    }
    public func toggleGithubMonitor(id: String, version: Int, enabled: Bool) async throws {
        try await post("/api/connector-monitors/toggle", body: ToggleBody(id: id, version: version, enabled: enabled))
    }
    public func deleteGithubMonitor(id: String, version: Int) async throws {
        try await post("/api/connector-monitors/delete", body: IDVersion(id: id, version: version))
    }
}

public struct ToggleBody: Encodable { public let id: String; public let version: Int; public let enabled: Bool }

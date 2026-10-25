import Foundation

public struct ConnectorCatalogEntry: RowBacked {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var name: String { row.string("name") ?? id }
    public var available: Bool { row.bool("available") ?? false }
}

public struct ConnectorOAuthAttempt: Decodable, Sendable, Equatable {
    public let id: String
    public let authorizationUrl: String
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

struct ConnectorOAuthStartBody: Encodable { let provider = "gmail"; let id: String?; let version: Int? }
struct ConnectorOAuthIDBody: Encodable { let id: String }
struct ConnectorDisconnectResult: Decodable, Sendable { let warning: String? }

extension CoreClient {
    public func startConnectorAuthorization(id: String? = nil, version: Int? = nil) async throws -> ConnectorOAuthAttempt {
        try await post("/api/connectors/oauth/start", body: ConnectorOAuthStartBody(id: id, version: version))
    }
    public func connectorAuthorizationStatus(id: String) async throws -> ConnectorOAuthStatus {
        try await get("/api/connectors/oauth/status", query: [("id", id)])
    }
    public func cancelConnectorAuthorization(id: String) async throws {
        try await post("/api/connectors/oauth/cancel", body: ConnectorOAuthIDBody(id: id))
    }
    /// Local removal may succeed even when Google revocation fails; preserve its warning.
    public func disconnectConnector(id: String, version: Int) async throws -> String? {
        try await post("/api/connectors/delete", body: IDVersion(id: id, version: version), as: ConnectorDisconnectResult.self).warning
    }
}

import Foundation

/// A validated Core root address (port of `coreOrigin` in the Electron shell).
/// HTTPS, or HTTP only for localhost, `[::1]` and private IPv4 ranges; no user info, path, query or fragment.
public struct CoreOrigin: Hashable, Sendable, CustomStringConvertible {
    public static let defaultString = "https://bot.nexorai.com.cn"
    public static let `default` = CoreOrigin(unchecked: defaultString)

    /// Normalized `scheme://host[:port]` without a trailing slash.
    public let string: String
    public var description: String { string }
    public var url: URL { URL(string: string)! }
    public var isHTTPS: Bool { string.hasPrefix("https:") }
    public var host: String { URLComponents(string: string)?.host.map(Self.bareHost) ?? "" }
    public var isPrivateHost: Bool { Self.isPrivate(host: host) }
    /// Account login needs HTTPS, except on private hosts.
    public var allowsPasswordLogin: Bool { isHTTPS || isPrivateHost }

    init(unchecked string: String) { self.string = string }

    public init(_ value: String) throws {
        let invalid = CoreError.invalidOrigin("请填写 HTTPS 或私有网络 HTTP 的 Core 根地址")
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let c = URLComponents(string: trimmed), let scheme = c.scheme?.lowercased(), let rawHost = c.host, !rawHost.isEmpty,
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil, c.path.isEmpty || c.path == "/",
              !trimmed.contains("?"), !trimmed.contains("#")
        else { throw invalid }
        let host = Self.bareHost(rawHost).lowercased()
        guard scheme == "https" || (scheme == "http" && Self.isPrivate(host: host)) else { throw invalid }
        var port = ""
        if let p = c.port, p != (scheme == "https" ? 443 : 80) { port = ":\(p)" }
        string = "\(scheme)://\(host.contains(":") ? "[\(host)]" : host)\(port)"
    }

    static func bareHost(_ host: String) -> String { host.hasPrefix("[") && host.hasSuffix("]") ? String(host.dropFirst().dropLast()) : host }

    static func isPrivate(host: String) -> Bool {
        let h = bareHost(host).lowercased()
        if h == "localhost" || h == "::1" { return true }
        let parts = h.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { p -> Int? in p.allSatisfy(\.isASCII) && !p.isEmpty && p.count <= 3 ? Int(p) : nil }
        guard octets.count == 4, octets.allSatisfy({ $0 <= 255 }) else { return false }
        return octets[0] == 127 || octets[0] == 10 || (octets[0] == 192 && octets[1] == 168) || (octets[0] == 172 && (16...31).contains(octets[1]))
    }
}

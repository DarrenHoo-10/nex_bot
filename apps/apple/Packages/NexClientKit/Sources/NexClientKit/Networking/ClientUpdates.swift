import Foundation
import CryptoKit

/// A newer installer that Core's release manifest offers, with the digest it must match.
public struct ClientUpdateOffer: Sendable, Equatable {
    public var version: String
    public var size: Int
    public var sha256: String
    public var url: URL
    public init(version: String, size: Int, sha256: String, url: URL) { self.version = version; self.size = size; self.sha256 = sha256; self.url = url }

    /// True when `candidate` is a higher x.y.z than `current`; a malformed candidate never is.
    public static func newer(_ candidate: String, than current: String) -> Bool {
        guard let a = parts(candidate) else { return false }
        guard let b = parts(current) else { return true }
        for i in 0..<3 where a[i] != b[i] { return a[i] > b[i] }
        return false
    }
    static func parts(_ version: String) -> [Int]? {
        let p = version.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard p.count == 3, p.allSatisfy({ $0 != nil }), version.allSatisfy({ $0.isNumber || $0 == "." }) else { return nil }
        return p.compactMap { $0 }
    }
}

struct ClientUpdateAnswer: Decodable, Sendable {
    let available: Bool
    let version: String?
    let size: Int?
    let sha256: String?
    let url: String?
}

extension CoreClient {
    /// `GET /api/client/update?platform=&version=`: the newer installer for this platform, or nil when current.
    public func clientUpdate(platform: String, current: String) async throws -> ClientUpdateOffer? {
        let answer: ClientUpdateAnswer = try await get("/api/client/update", query: [("platform", platform), ("version", current)])
        guard answer.available, let version = answer.version, ClientUpdateOffer.newer(version, than: current),
              let size = answer.size, size > 0, size <= 512 * 1024 * 1024,
              let sha = answer.sha256, sha.count == 64, sha.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
              let raw = answer.url, let url = URL(string: raw), url.scheme == "https", url.user == nil, url.password == nil else { return nil }
        return ClientUpdateOffer(version: version, size: size, sha256: sha, url: url)
    }

    /// Downloads the offered installer to `file`, reusing an already verified copy. Nothing is kept unless
    /// its size and SHA-256 match the offer. The signed URL is fetched without the bearer.
    public func downloadUpdate(_ offer: ClientUpdateOffer, to file: URL) async throws -> URL {
        if let existing = try? Data(contentsOf: file), Self.matches(existing, offer) { return file }
        var r = URLRequest(url: offer.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        r.httpShouldHandleCookies = false
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: r, delegate: Self.refuser) } catch { throw CoreError.wrap(error) }
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw CoreError(kind: .http, message: "下载更新失败", status: (response as? HTTPURLResponse)?.statusCode ?? 0) }
        guard Self.matches(data, offer) else { throw CoreError(kind: .http, message: "更新文件校验失败", status: 0) }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: file, options: .atomic)
        return file
    }

    static func matches(_ data: Data, _ offer: ClientUpdateOffer) -> Bool {
        data.count == offer.size && SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() == offer.sha256
    }
}

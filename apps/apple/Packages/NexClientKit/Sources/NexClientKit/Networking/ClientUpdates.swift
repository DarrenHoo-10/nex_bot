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
        guard answer.available else { return nil }
        guard let version = answer.version, ClientUpdateOffer.newer(version, than: current),
              let size = answer.size, size > 0, size <= 512 * 1024 * 1024,
              let sha = answer.sha256, sha.count == 64, sha.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
              let raw = answer.url, let url = URL(string: raw), url.scheme == "https", url.user == nil, url.password == nil else { throw CoreError(kind: .http, message: "更新信息无效", status: 0) }
        return ClientUpdateOffer(version: version, size: size, sha256: sha, url: url)
    }

    /// Streams the offered installer directly to disk (never buffering a 512 MB DMG in RAM), verifies size and SHA-256
    /// incrementally, and reuses an already verified copy. The signed URL is fetched without the bearer.
    public func downloadUpdate(_ offer: ClientUpdateOffer, to file: URL, onProgress: (@Sendable (Double) -> Void)? = nil) async throws -> URL {
        if Self.fileMatches(file, offer) {
            onProgress?(1)
            return file
        }
        var r = URLRequest(url: offer.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1800)
        r.httpShouldHandleCookies = false
        let bytesStream: URLSession.AsyncBytes, response: URLResponse
        do { (bytesStream, response) = try await session.bytes(for: r, delegate: Self.refuser) } catch { throw CoreError.wrap(error) }
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw CoreError(kind: .http, message: "下载更新失败", status: (response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        let fm = FileManager.default
        let dir = file.deletingLastPathComponent()
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let part = dir.appendingPathComponent(file.lastPathComponent + ".part")
        try? fm.removeItem(at: part)
        guard fm.createFile(atPath: part.path, contents: nil), let handle = try? FileHandle(forWritingTo: part) else {
            throw CoreError(kind: .http, message: "无法写入更新文件", status: 0)
        }
        var hasher = SHA256()
        var received = 0
        var buffer = Data()
        buffer.reserveCapacity(65536)
        var lastReported = -1.0
        do {
            for try await byte in bytesStream {
                buffer.append(byte)
                received += 1
                if received > offer.size {
                    try? handle.close()
                    try? fm.removeItem(at: part)
                    throw CoreError(kind: .http, message: "更新文件校验失败", status: 0)
                }
                if buffer.count >= 65536 {
                    hasher.update(data: buffer)
                    try handle.write(contentsOf: buffer)
                    buffer.removeAll(keepingCapacity: true)
                    let fraction = Double(received) / Double(max(1, offer.size))
                    if fraction - lastReported >= 0.01 {
                        lastReported = fraction
                        onProgress?(min(1, fraction))
                    }
                }
            }
            if !buffer.isEmpty {
                hasher.update(data: buffer)
                try handle.write(contentsOf: buffer)
                buffer.removeAll()
            }
            try handle.close()
        } catch {
            try? handle.close()
            try? fm.removeItem(at: part)
            throw CoreError.wrap(error)
        }
        let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        guard received == offer.size && digest == offer.sha256 else {
            try? fm.removeItem(at: part)
            throw CoreError(kind: .http, message: "更新文件校验失败", status: 0)
        }
        try? fm.removeItem(at: file)
        try fm.moveItem(at: part, to: file)
        onProgress?(1)
        return file
    }

    static func matches(_ data: Data, _ offer: ClientUpdateOffer) -> Bool {
        data.count == offer.size && SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() == offer.sha256
    }

    static func fileMatches(_ file: URL, _ offer: ClientUpdateOffer) -> Bool {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: file.path),
              let size = attrs[.size] as? Int, size == offer.size,
              let handle = try? FileHandle(forReadingFrom: file) else { return false }
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try? handle.read(upToCount: 256 * 1024), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined() == offer.sha256
    }
}

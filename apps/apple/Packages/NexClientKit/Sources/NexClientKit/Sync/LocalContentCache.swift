import CryptoKit
import Foundation

actor LocalContentCache {
    static let shared = LocalContentCache()
    private static let maxEntry = 2 * 1024 * 1024
    private static let maxTotal = 32 * 1024 * 1024
    private struct PendingWrite: Sendable {
        var key: String
        var scope: String
        var encode: @Sendable () throws -> Data
    }

    private let manager = FileManager()
    private let root: URL?
    private var active: String?
    private var pending: [PendingWrite] = []
    private var draining = false
    private var clean = false

    init(root: URL? = nil) {
        self.root = root ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("NexBot", isDirectory: true)
            .appendingPathComponent("PrivateContent-v1", isDirectory: true)
    }

    nonisolated static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    func authorize(_ scope: String) {
        guard scope.utf8.count == 64, scope.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }), active != scope else { return }
        active = scope
        pending.removeAll()
        clean = true
        schedule()
    }

    func clear(_ scope: String) {
        guard active == scope else { return }
        active = nil
        pending.removeAll()
        clean = true
        schedule()
    }

    func load<T: Codable & Sendable>(_ type: T.Type, scope: String, key: String) -> T? {
        guard scope == active, let file = file(scope, key),
              let data = try? Data(contentsOf: file), data.count <= Self.maxEntry else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    func enqueue<T: Codable & Sendable>(_ value: T, scope: String, key: String) {
        guard scope == active else { return }
        pending.removeAll { $0.key == key }
        pending.append(PendingWrite(key: key, scope: scope, encode: { try JSONEncoder().encode(value) }))
        if pending.count > 16 { pending.removeFirst() }
        schedule()
    }

    private func schedule() {
        guard !draining else { return }
        draining = true
        Task { await drain() }
    }

    private func drain() async {
        while clean || !pending.isEmpty {
            try? await Task.sleep(for: .milliseconds(250))
            if clean {
                clean = false
                purgeOtherScopes()
            }
            if !pending.isEmpty {
                let write = pending.removeFirst()
                if write.scope == active, let data = try? write.encode(), data.count <= Self.maxEntry,
                   let file = file(write.scope, write.key) {
                    try? manager.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try? data.write(to: file, options: .atomic)
                    trim(file.deletingLastPathComponent())
                }
            }
        }
        draining = false
    }

    private func file(_ scope: String, _ key: String) -> URL? {
        root?.appendingPathComponent(scope, isDirectory: true)
            .appendingPathComponent(Self.digest(key))
    }

    private func purgeOtherScopes() {
        // Also purge disk image preview caches whenever the active privacy scope changes or logs out.
        if let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
            let legacyImages = caches.appendingPathComponent("message-images", isDirectory: true)
            try? manager.removeItem(at: legacyImages)
        }
        guard let root, let folders = try? manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return }
        for folder in folders where folder.lastPathComponent != active { try? manager.removeItem(at: folder) }
    }

    private func trim(_ folder: URL) {
        let keys: Set<URLResourceKey> = [.contentModificationDateKey, .fileSizeKey]
        guard let files = try? manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: Array(keys)) else { return }
        let entries = files.compactMap { url -> (URL, Date, Int)? in
            guard let values = try? url.resourceValues(forKeys: keys), let size = values.fileSize else { return nil }
            return (url, values.contentModificationDate ?? .distantPast, size)
        }.sorted { $0.1 > $1.1 }
        var bytes = 0
        for (index, entry) in entries.enumerated() {
            bytes += entry.2
            if index >= 160 || bytes > Self.maxTotal { try? manager.removeItem(at: entry.0) }
        }
    }
}

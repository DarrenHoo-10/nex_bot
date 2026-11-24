import Foundation
import Testing
@testable import NexClientKit

@Test func localContentSurvivesReopenAndInvalidatesOldScope() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("nex-cache-test-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: folder) }
    let first = LocalContentCache.digest("first"), next = LocalContentCache.digest("next")
    let writer = LocalContentCache(root: folder)
    await writer.authorize(first)
    await writer.enqueue(["synthetic"], scope: first, key: "recent")
    #expect(await writer.load([String].self, scope: first, key: "recent") == nil)
    for _ in 0..<80 {
        if await writer.load([String].self, scope: first, key: "recent") != nil { break }
        try await Task.sleep(for: .milliseconds(25))
    }
    let reopened = LocalContentCache(root: folder)
    #expect(await reopened.load([String].self, scope: first, key: "recent") == nil)
    await reopened.authorize(first)
    #expect(await reopened.load([String].self, scope: first, key: "recent") == ["synthetic"])
    await reopened.enqueue(["stale"], scope: first, key: "queued")
    await reopened.authorize(next)
    #expect(await reopened.load([String].self, scope: first, key: "recent") == nil)
    #expect(await reopened.load([String].self, scope: next, key: "recent") == nil)
    for _ in 0..<80 {
        if !FileManager.default.fileExists(atPath: folder.appendingPathComponent(first).path) { break }
        try await Task.sleep(for: .milliseconds(25))
    }
    #expect(!FileManager.default.fileExists(atPath: folder.appendingPathComponent(first).path))
}

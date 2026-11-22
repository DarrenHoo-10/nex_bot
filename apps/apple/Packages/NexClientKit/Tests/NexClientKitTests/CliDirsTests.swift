import XCTest
@testable import NexClientKit

final class CliPathsTests: XCTestCase {
    func testWindowsAndPosixPaths() {
        XCTAssertEqual(CliPaths.parent("D:\\work\\alpha"), "D:\\work")
        XCTAssertEqual(CliPaths.parent("D:\\work"), "D:\\")
        XCTAssertNil(CliPaths.parent("D:\\"))
        XCTAssertEqual(CliPaths.parent("/Users/me/app"), "/Users/me")
        XCTAssertEqual(CliPaths.parent("/Users"), "/")
        XCTAssertNil(CliPaths.parent("/"))
        XCTAssertEqual(CliPaths.join("D:\\work", "new/app"), "D:\\work\\new\\app")
        XCTAssertEqual(CliPaths.join("/Users/me", "app"), "/Users/me/app")
        XCTAssertEqual(CliPaths.name("D:\\work\\alpha\\"), "alpha")
        XCTAssertEqual(CliPaths.name("D:\\"), "D:\\")
        XCTAssertEqual(CliPaths.crumbs("D:\\work\\alpha").map(\.label), ["D:\\", "work", "alpha"])
        XCTAssertEqual(CliPaths.crumbs("").count, 0)
    }

    func testWhatTheBoxMeans() {
        XCTAssertEqual(CliPaths.read("", current: "D:\\work"), .filter(""))
        XCTAssertEqual(CliPaths.read("alp", current: "D:\\work"), .filter("alp"))
        XCTAssertEqual(CliPaths.read("D:\\other\\x\\", current: "D:\\work"), .path("D:\\other\\x"))
        XCTAssertEqual(CliPaths.read("sub/deeper", current: "D:\\work"), .path("D:\\work\\sub\\deeper"))
        XCTAssertTrue(CliPaths.validName("nex-agent-demo"))
        for bad in ["", "a/b", "a:b", "x.", "x ", "a*b"] { XCTAssertFalse(CliPaths.validName(bad), bad) }
    }

    func testContextUsage() throws {
        let usage = CliContextUsage(used: 776_256, window: 1_000_000)
        XCTAssertEqual(CliContext.level(usage), .high)
        XCTAssertEqual(CliContext.summary(usage), "上下文 78% · 77.6 万 / 100 万")
        XCTAssertEqual(CliContext.level(CliContextUsage(used: 950_000, window: 1_000_000)), .full)
        XCTAssertEqual(CliContext.level(CliContextUsage(used: 5_000)), .none)
        XCTAssertEqual(CliContext.summary(nil), "上下文用量：暂无记录")
        XCTAssertEqual(CliContext.tokens(8123), "8,123")
        XCTAssertEqual(CliContext.tokens(1_000_000), "100 万")
        // a usage this side cannot read is left out, the row stays
        var row = cliSessionJSON()
        row["context"] = ["used": 5100, "window": 200_000]
        row["repoRoot"] = "/work/repo"
        let decoded = try JSONDecoder().decode(CliSession.self, from: JSONSerialization.data(withJSONObject: row))
        XCTAssertEqual(decoded.context, CliContextUsage(used: 5100, window: 200_000))
        XCTAssertEqual(decoded.repoRoot, "/work/repo")
        row["context"] = ["used": "lots"]
        XCTAssertNil(try JSONDecoder().decode(CliSession.self, from: JSONSerialization.data(withJSONObject: row)).context)
    }

    func testListingDecode() throws {
        let json = #"{"path":"D:\\work","parent":"D:\\","exists":true,"git":true,"entries":[{"name":"alpha","path":"D:\\work\\alpha","git":true},{"name":"bad"},{"name":"beta","path":"D:\\work\\beta"}]}"#
        let listing = try JSONDecoder().decode(CliDirListing.self, from: Data(json.utf8))
        XCTAssertEqual(listing.entries.map(\.name), ["alpha", "beta"])
        XCTAssertTrue(listing.git)
        XCTAssertEqual(listing.parent, "D:\\")
    }

    func testActiveSessionsAndWorktreesUnderTheirRepository() {
        let running = cliSession("d1:claude:r", state: .running, at: 30)
        let waiting = cliSession("d1:claude:w", state: .waiting, at: 20)
        let idle = cliSession("d1:claude:i", state: .idle, at: 10)
        var asked = cliSession("d1:claude:a", state: .idle, at: 5)
        XCTAssertEqual(CliSessions.active([idle, waiting, running, asked]).map(\.key), ["d1:claude:r", "d1:claude:w"])
        XCTAssertEqual(CliSessions.active([asked], pending: [asked.key: 1]).map(\.key), [asked.key])
        asked.hidden = true
        XCTAssertTrue(CliSessions.active([asked], pending: [asked.key: 1]).isEmpty)
        var tree = cliSession("d1:claude:t", cwd: "/work/repo/.claude/worktrees/x", at: 40)
        tree.repoRoot = "/work/repo"
        var main = cliSession("d1:claude:m", cwd: "/work/repo", at: 1)
        main.repoRoot = "/work/repo"
        let groups = CliSessions.group(devices: [CliDevice(id: "d1", name: "电脑", online: true)], sessions: [tree, main])
        XCTAssertEqual(groups.first?.folders.map(\.label), ["repo"])
        XCTAssertEqual(groups.first?.folders.first?.sessions.count, 2)
    }
}

@MainActor
final class CliDirsModelTests: XCTestCase {
    func testFoldersComeFromTheComputerAndCreateDirGoesToStart() async throws {
        let stub = StubCore()
        stub.handle { r in
            switch (r.method, r.path) {
            case ("GET", "/api/cli-agents"):
                let device: [String: Any] = ["id": "d1", "name": "办公室", "online": true,
                                             "cliAgents": ["version": 1, "engines": ["claude"], "terminal": ["name": "herdr-core", "version": "1", "ready": true], "features": ["launchOptions", "dirs"]]]
                return .json(["devices": [device], "sessions": [], "requests": []])
            case ("GET", "/api/cli-agents/dirs"):
                return .json(["path": "/work", "parent": "/", "exists": true, "entries": [["name": "app", "path": "/work/app", "git": true]]])
            case ("POST", "/api/cli-agents/start"):
                return .json(["key": "d1:claude:new"])
            default:
                return .json(["items": [], "more": false, "requests": []])
            }
        }
        let client = stub.client()
        let model = CliAgentsModel(client: { client }, defaults: UserDefaults(suiteName: "cli-dirs-\(UUID().uuidString)")!)
        await model.refresh()
        let listing = try await model.dirs(deviceId: "d1", path: "/work")
        XCTAssertEqual(listing.entries.first?.path, "/work/app")
        XCTAssertEqual(stub.recorded("/api/cli-agents/dirs").first?.query, "deviceId=d1&path=/work")
        // an executor without `dirs` lists nothing and takes a typed path as it is
        let unknown = try await model.dirs(deviceId: "old", path: "/x/y")
        XCTAssertEqual(unknown.entries.count, 0)
        XCTAssertTrue(unknown.exists)
        _ = try await client.cliStart(deviceId: "d1", engine: .claude, cwd: "/work/new", createDir: true)
        XCTAssertEqual(stub.recorded("/api/cli-agents/start").last?.json["createDir"] as? Bool, true)
        _ = try await client.cliStart(deviceId: "d1", engine: .claude, cwd: "/work/new", worktreeBranch: "nexagent/x", requestId: "r", createDir: true)
        XCTAssertNil(stub.recorded("/api/cli-agents/start").last?.json["createDir"], "no new folder together with a worktree")
    }
}

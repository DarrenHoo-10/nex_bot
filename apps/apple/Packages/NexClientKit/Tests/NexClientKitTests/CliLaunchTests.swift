import XCTest
@testable import NexClientKit

final class CliLaunchLogicTests: XCTestCase {
    func testBranchNames() {
        let name = CliLaunches.randomBranch()
        XCTAssertTrue(name.hasPrefix("nexagent/"))
        XCTAssertEqual(name.count, "nexagent/".count + 6)
        XCTAssertNil(CliLaunches.branchProblem(name))
        XCTAssertNil(CliLaunches.branchProblem("feature/chat-1.2"))
        XCTAssertEqual(CliLaunches.branchProblem("  "), "需要分支名称")
        for bad in ["login fix", "-x", "a..b", "a//b", "a/", "a.lock", "分支", "a."] { XCTAssertEqual(CliLaunches.branchProblem(bad), "分支名称不合法", bad) }
    }

    func testPlaceholderRowAndKeys() {
        let launch = CliLaunches.make(CliLaunchRequest(deviceId: "d1", engine: .codex, cwd: "/work/app", branch: "nexagent/abc123", message: "修一下登录页\n细节"), now: 5)
        XCTAssertTrue(CliLaunches.isLaunchKey(launch.key))
        XCTAssertFalse(CliLaunches.isLaunchKey("d1:claude:s1"))
        XCTAssertFalse(CliLaunches.isLaunchKey(nil))
        let row = CliLaunches.row(launch)
        XCTAssertEqual(row.title, "修一下登录页")
        XCTAssertEqual(row.state, .running)
        XCTAssertEqual(row.engine, .codex)
        XCTAssertEqual(row.gitBranch, "nexagent/abc123")
        var failed = launch; failed.phase = .failed("x")
        XCTAssertEqual(CliLaunches.row(failed).state, .stopped)
        XCTAssertEqual(CliLaunches.row(CliLaunches.make(CliLaunchRequest(deviceId: "d1", engine: .claude, cwd: "/w"), now: 1)).title, "新会话")
        let switched = CliLaunches.make(CliLaunchRequest(deviceId: "d1", engine: .claude, cwd: "/w", switchBranch: "dev"), now: 2)
        XCTAssertEqual(CliLaunches.row(switched).gitBranch, "dev")
    }

    func testCatalogAndCapabilityDecode() throws {
        let json = #"{"models":[{"id":"auto/claude-opus-5-5[1m]","label":"Opus 5.5","efforts":["low","high"]},{"label":"no id"},{"id":"opus","label":"Opus"}],"current":"opus","currentEffort":"high"}"#
        let catalog = try JSONDecoder().decode(CliModelCatalog.self, from: Data(json.utf8))
        XCTAssertEqual(catalog.models.map(\.id), ["auto/claude-opus-5-5[1m]", "opus"])
        XCTAssertEqual(catalog.current, "opus")
        XCTAssertEqual(CliLaunches.efforts(engine: .claude, models: catalog.models, model: "auto/claude-opus-5-5[1m]"), ["low", "high"])
        XCTAssertEqual(CliLaunches.efforts(engine: .claude, models: catalog.models, model: "opus"), ["low", "medium", "high", "xhigh", "max"])
        let cap = try JSONDecoder().decode(CliCapability.self, from: Data(#"{"version":1,"engines":["claude"],"terminal":{"name":"herdr-core","version":"1","ready":true},"features":["models",3]}"#.utf8))
        XCTAssertEqual(cap.features, ["models"])
        let old = try JSONDecoder().decode(CliCapability.self, from: Data(#"{"version":1,"engines":["claude"],"terminal":{"name":"herdr-core","version":"1","ready":true}}"#.utf8))
        XCTAssertEqual(old.features, [])
    }
}

/// Answers the requests of one launch test; counts what it saw.
private final class LaunchCore: @unchecked Sendable {
    let lock = NSLock()
    var started = false
    var startFailures = 0
    var sendNotFound = 0
    var sends = 0

    func respond(_ r: RecordedRequest) -> StubResponse {
        lock.withLock {
            switch (r.method, r.path) {
            case ("GET", "/api/cli-agents"):
                let device: [String: Any] = ["id": "d1", "name": "办公室", "online": true,
                                             "cliAgents": ["version": 1, "engines": ["claude"], "terminal": ["name": "herdr-core", "version": "1", "ready": true], "features": ["launchOptions", "models"]]]
                return .json(["devices": [device], "sessions": started ? [cliSessionJSON("d1:claude:new1", state: "running")] : [], "requests": []])
            case ("POST", "/api/cli-agents/start"):
                if startFailures > 0 { startFailures -= 1; return .json(["error": "工作树已存在", "code": "invalid"], status: 400) }
                started = true
                return .json(["key": "d1:claude:new1"])
            case ("POST", "/api/cli-agents/send"):
                sends += 1
                if sendNotFound > 0 { sendNotFound -= 1; return .json(["error": "会话不存在", "code": "not_found"], status: 404) }
                return .json(["turn": 1, "started": true])
            case ("GET", "/api/cli-agents/models"):
                return .json(["current": "opus", "models": [["id": "auto/claude-opus-5-5[1m]", "label": "Opus 5.5 · 网关"]]])
            default:
                return .json(["items": [], "more": false, "requests": []])
            }
        }
    }
}

@MainActor
final class CliLaunchModelTests: XCTestCase {
    private func model(_ core: LaunchCore) async -> (CliAgentsModel, StubCore) {
        let stub = StubCore()
        stub.handle { core.respond($0) }
        let client = stub.client()
        let model = CliAgentsModel(client: { client }, defaults: UserDefaults(suiteName: "cli-launch-\(UUID().uuidString)")!)
        model.launchRetryNanos = 10_000_000
        await model.refresh()
        return (model, stub)
    }

    func testLaunchShowsAtOnceThenHandsOverToTheSession() async {
        let core = LaunchCore()
        core.sendNotFound = 2
        let (model, stub) = await model(core)
        let key = model.launch(CliLaunchRequest(deviceId: "d1", engine: .claude, cwd: "/work/app", branch: "nexagent/abc123", message: "修一下登录页", model: "auto/claude-opus-5-5[1m]", effort: "high", baseBranch: "release"))
        // no waiting: the placeholder is listed and selected right away
        XCTAssertEqual(model.selectedKey, key)
        XCTAssertEqual(model.selectedLaunch?.request.message, "修一下登录页")
        XCTAssertEqual(model.displaySessions.first?.key, key)
        await eventually { model.launches.isEmpty }
        XCTAssertEqual(model.selectedKey, "d1:claude:new1")
        XCTAssertEqual(model.echoes["d1:claude:new1"]?.text, "修一下登录页")
        XCTAssertEqual(model.echoes["d1:claude:new1"]?.nativeQueued, false)
        XCTAssertEqual(core.lock.withLock { core.sends }, 3, "a not-yet-listed session is tried again")
        let body = stub.recorded("/api/cli-agents/start").first?.json
        XCTAssertEqual(body?["worktreeBranch"] as? String, "nexagent/abc123")
        XCTAssertEqual(body?["worktreeBaseBranch"] as? String, "release")
        XCTAssertNil(body?["branch"])
        XCTAssertEqual(body?["model"] as? String, "auto/claude-opus-5-5[1m]")
        XCTAssertEqual(body?["effort"] as? String, "high")
        XCTAssertNotNil(body?["requestId"] as? String)
        let sends = stub.recorded("/api/cli-agents/send")
        XCTAssertEqual(sends.last?.json["text"] as? String, "修一下登录页")
        XCTAssertEqual(Set(sends.compactMap { $0.json["requestId"] as? String }).count, 1)
        XCTAssertEqual(Set(sends.compactMap { $0.json["clientMessageId"] as? String }).count, 1)
    }

    func testFailedStartStaysWithARetryOfTheSameRequest() async {
        let core = LaunchCore()
        core.startFailures = 1
        let (model, stub) = await model(core)
        _ = model.launch(CliLaunchRequest(deviceId: "d1", engine: .claude, cwd: "/work/app", branch: "nexagent/abc123"))
        await eventually { if case .failed = model.launches.first?.phase { return true }; return false }
        XCTAssertEqual(model.launches.first?.phase, .failed("工作树已存在"))
        model.retryLaunch(model.launches[0].id)
        await eventually { model.launches.isEmpty }
        let ids = stub.recorded("/api/cli-agents/start").map { $0.json["requestId"] as? String }
        XCTAssertEqual(ids.count, 2)
        XCTAssertEqual(ids[0], ids[1])
        XCTAssertTrue(stub.recorded("/api/cli-agents/send").isEmpty, "no first message, nothing sent")
        XCTAssertEqual(model.selectedKey, "d1:claude:new1")
    }

    func testModelsComeFromTheComputer() async {
        let (model, stub) = await model(LaunchCore())
        let catalog = await model.models(deviceId: "d1", engine: .claude)
        XCTAssertEqual(catalog.models.map(\.label), ["Opus 5.5 · 网关"])
        XCTAssertEqual(stub.recorded("/api/cli-agents/models").first?.query, "deviceId=d1&engine=claude")
        _ = await model.models(deviceId: "d1", engine: .claude)
        XCTAssertEqual(stub.recorded("/api/cli-agents/models").count, 1, "a minute's cache")
        // a computer that cannot list them gets the built-in suggestions
        let unknown = await model.models(deviceId: "d9", engine: .claude)
        XCTAssertEqual(unknown.models.map(\.id), ["fable", "opus", "sonnet", "haiku"])
    }
}

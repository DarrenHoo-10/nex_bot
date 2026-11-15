import XCTest
@testable import NexClientKit

@MainActor
final class GithubConnectorTests: XCTestCase {
    private let deviceURL = "https://github.com/login/device"
    private func githubState(account: String = "octocat", extra: [[String: Any]] = [], monitors: [[String: Any]] = []) -> [String: Any] {
        ["sync": syncJSON(), "connectorCatalog": [["id": "github", "name": "GitHub", "available": true]],
         "connectors": [["id": "gh1", "provider": "github", "name": "GitHub", "account": account, "enabled": true, "hasToken": true, "version": 3, "checkedAt": 1_760_000_000_000, "tools": [["name": "github.repos", "description": "Repos", "inputSchema": [:]]], "grants": []]] + extra,
         "connectorMonitors": monitors]
    }
    private func deviceAttempt(verification: String? = nil, expires: Double? = nil) -> [String: Any] {
        ["id": "attempt-g", "userCode": "ABCD-1234", "verificationUri": verification ?? deviceURL, "expiresAt": expires ?? Date().timeIntervalSince1970 * 1000 + 600_000]
    }
    private func setup(start: [String: Any]? = nil, state: [String: Any]? = nil) async -> (StubCore, WorkspaceStore, ConnectorAuthorization) {
        let core = StubCore(), currentState = state ?? githubState(), response = start ?? deviceAttempt()
        core.handle { r in
            switch r.path {
            case "/api/state": .json(currentState)
            case "/api/connectors/oauth/start": .json(response)
            default: .json(["ok": true])
            }
        }
        let store = WorkspaceStore(client: core.client()); await store.refresh()
        #if DEBUG
        return (core, store, ConnectorAuthorization(workspace: store, provider: "github", allowLoopbackFixture: true))
        #else
        return (core, store, ConnectorAuthorization(workspace: store, provider: "github"))
        #endif
    }
    func testGithubRowDecodesWithGithubLabels() async throws {
        let (_, store, _) = await setup()
        let row = try XCTUnwrap(store.state?.connectors.first { $0.isGithub })
        XCTAssertTrue(row.isGithub); XCTAssertFalse(row.isGmail)
        XCTAssertEqual(row.statusChip, "已连接"); XCTAssertEqual(row.authLabel, "仓库、PR、CI 与 issue")
        XCTAssertTrue(row.isReady)
        var withoutToken = row.row; withoutToken["hasToken"] = .bool(false)
        let broken = ConnectorView(row: withoutToken)
        XCTAssertEqual(broken.statusChip, "需要重新授权"); XCTAssertFalse(broken.isReady)
    }
    func testDeviceFlowStartShowsCodeAndOpensDevicePage() async throws {
        let (core, _, auth) = await setup()
        let url = await auth.start()
        XCTAssertEqual(url?.absoluteString, deviceURL)
        XCTAssertEqual(auth.userCode, "ABCD-1234"); XCTAssertNil(auth.authorizationURL); XCTAssertNil(auth.error)
        let request = try XCTUnwrap(core.recorded("/api/connectors/oauth/start").last)
        XCTAssertEqual(request.json["provider"] as? String, "github")
        auth.cancel()
        try await Task.sleep(for: .milliseconds(50)) // 取消是后台 Task，给它时间落到 stub。
        XCTAssertEqual(core.recorded("/api/connectors/oauth/cancel").count, 1)
    }
    func testDeviceFlowPollConnects() async throws {
        let (core, store, auth) = await setup()
        _ = await auth.start()
        let state = githubState()
        core.handle { r in r.path == "/api/state" ? .json(state) : .json(["id": "attempt-g", "status": "connected", "connectorId": "gh1"]) }
        await auth.poll()
        XCTAssertEqual(auth.connectedID, "gh1"); XCTAssertNil(auth.attempt); XCTAssertNil(auth.userCode); XCTAssertNil(auth.deviceURL)
        XCTAssertEqual(store.state?.connectors.first { $0.isGithub }?.account, "octocat")
    }
    func testUnsafeDevicePageIsRejectedBeforeOpening() async {
        let (core, _, auth) = await setup(start: deviceAttempt(verification: "https://github.com.evil.test/login/device"))
        let url = await auth.start()
        XCTAssertNil(url); XCTAssertNil(auth.attempt); XCTAssertEqual(auth.error, "GitHub 设备页地址无效")
        XCTAssertEqual(core.recorded("/api/connectors/oauth/cancel").count, 1)
    }
    func testGithubWebFlowAuthorizationURLIsValidated() async throws {
        let (core, _, auth) = await setup(start: ["id": "attempt-g", "authorizationUrl": "https://github.com/login/oauth/authorize?state=synthetic", "expiresAt": Date().timeIntervalSince1970 * 1000 + 600_000])
        let url = await auth.start()
        XCTAssertEqual(url?.host, "github.com"); XCTAssertEqual(url?.path, "/login/oauth/authorize")
        XCTAssertNil(auth.userCode); XCTAssertEqual(auth.authorizationURL?.host, "github.com")
        auth.cancel()
        let (core2, _, auth2) = await setup(start: ["id": "attempt-g", "authorizationUrl": "https://github.com.evil.test/login/oauth/authorize", "expiresAt": Date().timeIntervalSince1970 * 1000 + 600_000])
        _ = await auth2.start()
        XCTAssertEqual(auth2.error, "GitHub 授权地址无效"); XCTAssertEqual(core2.recorded("/api/connectors/oauth/cancel").count, 1)
    }
    func testOnlyGithubDevicePagesAreAccepted() throws {
        let origin = try CoreOrigin("https://core.example.test")
        XCTAssertEqual(try GithubTools.verificationURL(deviceURL, origin: origin).host, "github.com")
        XCTAssertEqual(try GithubTools.authorizationURL("https://github.com/login/oauth/authorize?state=s", origin: origin).path, "/login/oauth/authorize")
        for bad in ["https://github.com.evil.test/login/device", "https://user@github.com/login/device", "http://github.com/login/device", "https://github.com:444/login/device", "https://github.com/login/device#x", "https://github.com/login/device?next=1", "https://example.test/", "https://github.com/login/oauth/authorize.evil"] {
            XCTAssertThrowsError(try GithubTools.verificationURL(bad, origin: origin, allowLoopbackFixture: true), bad)
        }
    }
    func testMonitorDecodeAndCRUDBodies() async throws {
        let state = githubState(monitors: [["id": "m1", "connectorId": "gh1", "name": "仓库监视", "botId": "b1", "repos": ["example/nexbot"], "ciMode": "mine", "mutedRepos": [], "ignoreBranches": ["train/*"], "delivery": "notify", "enabled": true, "intervalSeconds": 300, "webhookConfigured": true, "lastRunAt": 1_760_000_000_000.0, "lastError": NSNull(), "version": 2]])
        let (core, store, _) = await setup(state: state)
        XCTAssertEqual(store.githubMonitors.count, 1)
        let monitor = try XCTUnwrap(store.githubMonitors.first)
        XCTAssertEqual(monitor.repos, ["example/nexbot"]); XCTAssertTrue(monitor.webhookConfigured); XCTAssertEqual(monitor.version, 2)
        core.handle { r in
            switch r.path {
            case "/api/connector-monitors/toggle": .json(["ok": true])
            case "/api/connector-monitors/delete": .json(["ok": true])
            case "/api/state": .json(state)
            default: .json(["ok": true])
            }
        }
        try await store.toggleGithubMonitor("m1", enabled: false)
        let toggle = try XCTUnwrap(core.recorded("/api/connector-monitors/toggle").last)
        XCTAssertEqual(toggle.json["version"] as? Int, 2); XCTAssertEqual(toggle.json["enabled"] as? Bool, false)
        try await store.deleteGithubMonitor("m1")
        XCTAssertEqual(core.recorded("/api/connector-monitors/delete").count, 1)
    }
    func testSaveGithubMonitorPostsBodyAndReturnsSecret() async throws {
        let (core, store, _) = await setup(state: githubState())
        core.handle { r in
            switch r.path {
            case "/api/connector-monitors/save": .json(["id": "m1", "version": 1, "connectorId": "gh1", "botId": "b1", "name": "监视", "repos": ["example/nexbot"], "ciMode": "mine", "mutedRepos": [], "ignoreBranches": [], "delivery": "notify", "enabled": true, "intervalSeconds": 300, "webhookConfigured": true, "lastRunAt": NSNull(), "lastError": NSNull(), "webhookSecret": "synthetic-secret", "webhookPath": "/hooks/github/m1"])
            default: .json(["ok": true])
            }
        }
        let saved = try await store.saveGithubMonitor(existing: nil, connectorId: "gh1", botId: "b1", name: "监视", repos: ["example/nexbot"], ciMode: "mine", delivery: "notify", intervalSeconds: 300, mutedRepos: [], ignoreBranches: [], enableWebhook: true, regenerateWebhookSecret: false)
        XCTAssertEqual(saved.webhookSecret, "synthetic-secret")
        XCTAssertEqual(saved.monitor.repos, ["example/nexbot"])
        let request = try XCTUnwrap(core.recorded("/api/connector-monitors/save").last)
        XCTAssertEqual(request.json["connectorId"] as? String, "gh1")
        XCTAssertEqual((request.json["repos"] as? [Any])?.count, 1)
        XCTAssertEqual(request.json["enableWebhook"] as? Bool, true)
    }
    func testPATSavePostsGithubAndTestsTheNewRow() async throws {
        let savedState = githubState(extra: [["id": "gh2", "provider": "github", "name": "GitHub", "enabled": true, "hasToken": true, "version": 1, "checkedAt": 1_760_000_000_000, "tools": [], "grants": []]])
        let (core, store, _) = await setup(state: savedState)
        core.handle { r in
            switch r.path {
            case "/api/state": .json(savedState)
            case "/api/connectors/save": .json(["id": "gh2", "version": 1])
            case "/api/connectors/test": .json(["ok": true, "count": 14])
            default: .json(["ok": true])
            }
        }
        let count = try await store.saveGithubToken("synthetic-pat")
        XCTAssertEqual(count, 14)
        let save = try XCTUnwrap(core.recorded("/api/connectors/save").last)
        XCTAssertEqual(save.json["provider"] as? String, "github")
        XCTAssertEqual(save.json["token"] as? String, "synthetic-pat")
        let test = try XCTUnwrap(core.recorded("/api/connectors/test").last)
        XCTAssertEqual(test.json["id"] as? String, "gh2"); XCTAssertEqual(test.json["version"] as? Int, 1)
    }
}

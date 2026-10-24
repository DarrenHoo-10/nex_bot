import XCTest
@testable import NexClientKit

@MainActor
final class ConnectorOAuthTests: XCTestCase {
    private let googleURL = "https://accounts.google.com/o/oauth2/v2/auth?state=synthetic"
    private var fullState: [String: Any] {
        ["sync": syncJSON(), "connectors": [["id": "legacy", "name": "MCP", "enabled": true, "hasToken": true, "checkedAt": 1_760_000_000_000]]]
    }
    private func snapshot() -> [String: Any] {
        var value = fullState
        value["connectorCatalog"] = [["id": "gmail", "name": "Gmail", "available": true]]
        value["connectors"] = [["id": "mail", "provider": "gmail", "name": "Gmail", "account": "reader@example.test", "enabled": true, "hasToken": true, "version": 8, "checkedAt": 1_760_000_000_000, "tools": [["name": "gmail.read", "description": "Read", "inputSchema": [:]]], "grants": []]]
        return value
    }
    private func attempt(_ url: String? = nil, expires: Double? = nil) -> [String: Any] {
        ["id": "attempt-a", "authorizationUrl": url ?? googleURL, "expiresAt": expires ?? Date().timeIntervalSince1970 * 1000 + 600_000]
    }
    private func setup(start: [String: Any]? = nil, delay: Double = 0) async -> (StubCore, WorkspaceStore, ConnectorAuthorization) {
        let core = StubCore(), state = snapshot(), response = start ?? attempt()
        core.handle { r in
            switch r.path {
            case "/api/state": .json(state)
            case "/api/connectors/oauth/start": .json(response, delay: delay)
            default: .json(["ok": true])
            }
        }
        let store = WorkspaceStore(client: core.client()); await store.refresh()
        return (core, store, ConnectorAuthorization(workspace: store))
    }
    func testCatalogAndProviderDecodeWithoutChangingLegacyMCP() async throws {
        let (_, store, _) = await setup()
        let state = try XCTUnwrap(store.state), mail = try XCTUnwrap(state.connectors.first)
        XCTAssertTrue(state.gmailAvailable); XCTAssertTrue(mail.isGmail); XCTAssertEqual(mail.account, "reader@example.test")
        XCTAssertEqual(mail.statusChip, "已连接"); XCTAssertEqual(mail.authLabel, "搜索和读取邮件")
        let old = try JSONDecoder().decode(WorkspaceState.self, from: JSONSerialization.data(withJSONObject: fullState))
        XCTAssertFalse(old.gmailAvailable); XCTAssertEqual(old.connectors[0].provider, "mcp")
        XCTAssertEqual(old.connectors[0].statusChip, "连接测试通过")
        var row = mail.row; row["hasToken"] = .bool(false)
        XCTAssertEqual(ConnectorView(row: row).statusChip, "需要重新授权")
        XCTAssertFalse(ConnectorView(row: row).isReady)
    }
    func testNewAndReconnectRequestsUseCurrentVersion() async throws {
        let (core, _, auth) = await setup()
        _ = await auth.start(connectorID: "mail")
        let request = try XCTUnwrap(core.recorded("/api/connectors/oauth/start").last)
        XCTAssertEqual(request.json["provider"] as? String, "gmail")
        XCTAssertEqual(request.json["id"] as? String, "mail"); XCTAssertEqual(request.json["version"] as? Int, 8)
        XCTAssertEqual(auth.authorizationURL?.host, "accounts.google.com")
        _ = await auth.start()
        XCTAssertEqual(core.recorded("/api/connectors/oauth/start").count, 1)
        auth.cancel()
    }
    func testOnlyGoogleAuthorizationURLsAreAccepted() throws {
        let origin = try CoreOrigin("https://core.example.test")
        XCTAssertEqual(try GmailTools.authorizationURL(googleURL, origin: origin).host, "accounts.google.com")
        for bad in ["https://accounts.google.com.evil.test/o/oauth2/v2/auth", "https://secret@accounts.google.com/o/oauth2/v2/auth", "http://accounts.google.com/o/oauth2/v2/auth", "https://accounts.google.com:444/o/oauth2/v2/auth", "https://accounts.google.com/o/oauth2/v2/auth#token", "https://example.test/", "file:///tmp/auth", "https://accounts.google.com/o/oauth2/v2/%61uth", "http://127.0.0.1:4321/authorize"] {
            XCTAssertThrowsError(try GmailTools.authorizationURL(bad, origin: origin, allowLoopbackFixture: true))
        }
    }
    func testUnsafeStartIsCancelledBeforeOpeningBrowser() async {
        let (core, _, auth) = await setup(start: attempt("https://untrusted.example.test/"))
        let url = await auth.start()
        XCTAssertNil(url); XCTAssertNil(auth.attempt); XCTAssertEqual(auth.error, "Google 授权地址无效")
        XCTAssertEqual(core.recorded("/api/connectors/oauth/cancel").count, 1)
    }
    func testExpiredStartIsNotOpened() async {
        let (core, _, auth) = await setup(start: attempt(expires: 1000))
        _ = await auth.start()
        XCTAssertNil(auth.attempt); XCTAssertEqual(auth.error, "授权已过期，请重新连接")
        XCTAssertEqual(core.recorded("/api/connectors/oauth/cancel").count, 1)
    }
    func testSuccessfulPollRefreshesMailboxAndStops() async {
        let (core, store, auth) = await setup(); _ = await auth.start()
        let state = snapshot()
        core.handle { r in r.path == "/api/state" ? .json(state) : .json(["id": "attempt-a", "status": "connected", "connectorId": "mail"]) }
        await auth.poll()
        XCTAssertEqual(auth.connectedID, "mail"); XCTAssertNil(auth.attempt); XCTAssertNil(auth.authorizationURL)
        XCTAssertEqual(store.state?.connectors.first?.account, "reader@example.test")
        let status = core.recorded("/api/connectors/oauth/status")
        XCTAssertEqual(status.count, 1); XCTAssertEqual(status.first?.query, "id=attempt-a")
        await auth.poll(); XCTAssertEqual(core.recorded("/api/connectors/oauth/status").count, 1)
    }
    func testDeniedConsentAndMismatchedStatusCannotConnect() async {
        for response in [["id": "attempt-a", "status": "error", "error": "Google 授权未完成"], ["id": "other", "status": "connected", "connectorId": "mail"]] {
            let (core, _, auth) = await setup(); _ = await auth.start()
            core.handle { r in r.path == "/api/connectors/oauth/cancel" ? .json(["ok": true]) : .json(response) }
            await auth.poll()
            XCTAssertNil(auth.connectedID); XCTAssertNil(auth.attempt); XCTAssertNotNil(auth.error)
            XCTAssertEqual(core.recorded("/api/connectors/oauth/cancel").count, 1)
        }
    }
    func testLeavingDuringStartCancelsLateAttempt() async throws {
        let (core, _, auth) = await setup(delay: 0.1)
        let task = Task { await auth.start() }
        try await Task.sleep(for: .milliseconds(25)); auth.cancel()
        let url = await task.value
        XCTAssertNil(url); XCTAssertFalse(auth.busy); XCTAssertNil(auth.error)
        XCTAssertEqual(core.recorded("/api/connectors/oauth/cancel").count, 1)
    }
    func testLeavingDuringPollFencesLateSuccess() async throws {
        let (core, _, auth) = await setup(); _ = await auth.start()
        core.handle { r in r.path == "/api/connectors/oauth/status" ? .json(["id": "attempt-a", "status": "connected", "connectorId": "mail"], delay: 0.1) : .json(["ok": true]) }
        let task = Task { await auth.poll() }
        try await Task.sleep(for: .milliseconds(25)); auth.cancel(); await task.value
        XCTAssertNil(auth.connectedID); XCTAssertNil(auth.attempt)
    }
    func testBrowserFailurePreservesRetryLink() async {
        let (_, _, auth) = await setup(); _ = await auth.start(); auth.failedToOpenBrowser()
        XCTAssertEqual(auth.error, "无法打开浏览器，请重试"); XCTAssertNotNil(auth.authorizationURL)
        auth.cancel(); XCTAssertNil(auth.authorizationURL)
    }
    func testNativeCredentialEditIsRejectedAndDisconnectWarningSurvives() async throws {
        let (core, store, _) = await setup()
        do { _ = try await store.saveConnector(existing: store.state?.connectors.first, name: "bad", url: "https://example.test", transport: "http"); XCTFail("Native credentials were edited") }
        catch { XCTAssertEqual(CoreError.wrap(error).message, "此连接器使用 Google 授权") }
        XCTAssertTrue(core.recorded("/api/connectors/save").isEmpty)
        let state = snapshot()
        core.handle { r in r.path == "/api/state" ? .json(state) : .json(["ok": true, "warning": "已断开本地连接，Google 撤销失败"]) }
        let warning = try await store.disconnectGmail("mail")
        XCTAssertEqual(warning, "已断开本地连接，Google 撤销失败")
        XCTAssertEqual(core.recorded("/api/connectors/delete").last?.json["version"] as? Int, 8)
    }
}

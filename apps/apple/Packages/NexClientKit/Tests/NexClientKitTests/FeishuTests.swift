import XCTest
@testable import NexClientKit

nonisolated(unsafe) private let feishuState: [String: Any] = [
    "sync": syncJSON(),
    "bots": [["id": "b1", "name": "秘书", "version": 1, "policy_version": 1, "policy_json": "{\"tools\":[]}", "expertise_json": "[]"]],
    "connectors": [
        ["id": "c1", "kind": "mcp", "name": "团队库", "url": "http://127.0.0.1:9/mcp", "transport": "http", "enabled": true, "version": 2, "hasToken": false, "tools": [], "error": NSNull(), "grants": []],
        ["id": "c2", "kind": "feishu", "name": "飞书", "url": "https://open.feishu.cn", "transport": "http", "enabled": true, "version": 2, "hasToken": false, "tools": [], "error": NSNull(), "grants": []],
    ],
    "feishu": [
        "job": ["stage": "qr", "url": "https://open.feishu.cn/page/cli?x=1", "expiresAt": 1_760_000_000_000],
        "userAuth": ["stage": "error", "error": "授权账号与应用主人不一致"],
        "apps": [["id": "f1", "appId": "cli_a", "brand": "feishu", "status": "connected", "error": NSNull(), "ownerBound": true, "botId": "b1", "botName": "秘书",
                  "enabled": true, "version": 2, "userAuthorized": true, "userScopes": ["docx:document", "offline_access"], "userExpiresAt": 1_760_000_000_000]],
    ],
]

@MainActor
final class FeishuTests: XCTestCase {
    private func makeStore(_ core: StubCore) -> WorkspaceStore {
        WorkspaceStore(client: core.client(), timing: SyncTiming(debounce: 0.01, fallbackInterval: 100, backoff: Backoff(initial: 0.01, maximum: 0.01)))
    }
    private func loaded(_ response: @escaping @Sendable (RecordedRequest) -> StubResponse = { _ in .json(["ok": true]) }) async -> (StubCore, WorkspaceStore) {
        let core = StubCore()
        core.handle { r in r.path == "/api/state" ? .json(feishuState) : response(r) }
        let store = makeStore(core); await store.refresh()
        return (core, store)
    }

    func testDecodesFeishuState() async throws {
        let (_, store) = await loaded()
        let s = try XCTUnwrap(store.state)
        XCTAssertEqual(s.connectors.first { $0.kind == "feishu" }?.id, "c2")
        XCTAssertEqual(s.connectors.first { $0.kind == "mcp" }?.id, "c1")
        let feishu = try XCTUnwrap(s.feishu)
        XCTAssertEqual(feishu.job?.stage, "qr")
        XCTAssertEqual(feishu.job?.url, "https://open.feishu.cn/page/cli?x=1")
        XCTAssertEqual(feishu.userAuth?.error, "授权账号与应用主人不一致")
        XCTAssertTrue(feishu.job?.isRunning == true)
        XCTAssertTrue(feishu.needsPolling)
        let app = try XCTUnwrap(feishu.app)
        XCTAssertEqual(app.id, "f1"); XCTAssertEqual(app.appID, "cli_a"); XCTAssertEqual(app.brand, "feishu")
        XCTAssertEqual(app.statusLabel, "已连接"); XCTAssertTrue(app.ownerBound); XCTAssertTrue(app.enabled); XCTAssertEqual(app.version, 2)
        XCTAssertEqual(app.botID, "b1"); XCTAssertEqual(app.botName, "秘书")
        XCTAssertTrue(app.userAuthorized); XCTAssertEqual(app.userScopes, ["docx:document", "offline_access"])
        XCTAssertEqual(app.userAuthLabel, "已授权 · 2 项权限")
        XCTAssertNotNil(app.userExpiresAt)
    }

    func testFeishuCalls() async throws {
        let (core, store) = await loaded { r in
            switch r.path {
            case "/api/feishu/save": .json(["id": "f9"])
            case "/api/feishu/bind/start": .json(["code": "123456"])
            default: .json(["ok": true])
            }
        }
        // Core refuses a second register while an app exists; the no-app path is covered below.
        try await store.cancelFeishuRegister()
        XCTAssertEqual(core.recorded("/api/feishu/register/cancel").count, 1)
        let newID = try await store.saveFeishuApp(appID: "cli_x", secret: "s", brand: "lark", botID: "b1")
        XCTAssertEqual(newID, "f9")
        var j = core.recorded("/api/feishu/save")[0].json
        XCTAssertEqual(j["appId"] as? String, "cli_x"); XCTAssertEqual(j["appSecret"] as? String, "s"); XCTAssertEqual(j["brand"] as? String, "lark"); XCTAssertEqual(j["botId"] as? String, "b1")
        let code = try await store.startFeishuBind()
        XCTAssertEqual(code, "123456")
        XCTAssertEqual(core.recorded("/api/feishu/bind/start")[0].json["id"] as? String, "f1")
        try await store.startFeishuUserAuth()
        XCTAssertEqual(core.recorded("/api/feishu/user-auth/start")[0].json["id"] as? String, "f1")
        try await store.cancelFeishuUserAuth()
        XCTAssertEqual(core.recorded("/api/feishu/user-auth/cancel").count, 1)
        try await store.setFeishuEnabled(false)
        j = core.recorded("/api/feishu/toggle")[0].json
        XCTAssertEqual(j["id"] as? String, "f1"); XCTAssertEqual(j["version"] as? Int, 2); XCTAssertEqual(j["enabled"] as? Bool, false)
        try await store.removeFeishu()
        j = core.recorded("/api/feishu/delete")[0].json
        XCTAssertEqual(j["id"] as? String, "f1"); XCTAssertEqual(j["version"] as? Int, 2)
    }

    func testFeishuGuardsWithoutApp() async throws {
        var bare = feishuState; bare["feishu"] = ["job": NSNull(), "userAuth": NSNull(), "apps": []]
        let core = StubCore()
        core.handle { r in r.path == "/api/state" ? .json(bare) : .json(["ok": true]) }
        let store = makeStore(core); await store.refresh()
        await XCTAssertThrowsErrorAsync(try await store.startFeishuBind())
        await XCTAssertThrowsErrorAsync(try await store.setFeishuEnabled(false))
        try await store.startFeishuRegister(botID: "b1") // no app → allowed
        XCTAssertEqual(core.recorded("/api/feishu/register/start").count, 1)
    }
}

@MainActor @discardableResult
private func XCTAssertThrowsErrorAsync<T: Sendable>(_ expression: @autoclosure () async throws -> T, file: StaticString = #filePath, line: UInt = #line) async -> Error? {
    do { _ = try await expression(); XCTFail("Expected error", file: file, line: line); return nil }
    catch { return error }
}

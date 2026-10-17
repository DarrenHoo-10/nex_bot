import XCTest
@testable import NexClientKit

final class AuthTests: XCTestCase {
    func identityJSON(core: String = coreID, loginRequired: Bool = true, initialized: Bool = true, methods: [String] = ["password"], version: Int = 1) -> [String: Any] {
        ["version": version, "coreId": core, "mode": "connected", "loginRequired": loginRequired, "initialized": initialized, "loginMethods": methods]
    }
    func loginCore(core: String = coreID, respondCore: String = coreID, identity: [String: Any]? = nil) -> StubCore {
        let c = StubCore()
        c.handle { r in
            switch r.path {
            case "/api/client/identity": return .json(identity ?? self.identityJSON(core: core))
            case "/api/auth/start": return .json(["transactionId": "t1", "bindingToken": "b1", "stepId": "s1", "challenge": "password", "expiresAt": 1])
            case "/api/auth/respond": return .json(["token": "TOKEN", "coreId": respondCore, "sessionId": "sess", "expiresAt": 1_760_000_000_000])
            default: return .json(["ok": true])
            }
        }
        return c
    }
    func credential(_ core: StubCore, coreId: String = coreID) -> StoredCredential {
        StoredCredential(origin: core.origin.string, name: "Mac", token: "OLD", coreId: coreId, sessionId: "sess", expiresAt: 1)
    }
    func service(_ core: StubCore, saved: StoredCredential? = nil, override: CoreOrigin? = nil) -> (LoginService, InMemoryCredentialStore) {
        let store = InMemoryCredentialStore(saved)
        return (LoginService(store: store, session: core.session, overrideOrigin: override), store)
    }

    func testLoginSequenceAndPasswordNotStored() async throws {
        let core = loginCore()
        let (svc, store) = service(core)
        let conn = try await svc.login(origin: core.origin.string, name: "Mac", account: "a@b.c", password: " pw ")
        XCTAssertEqual(core.recorded().map(\.path), ["/api/client/identity", "/api/auth/start", "/api/auth/respond"])
        XCTAssertEqual(core.recorded("/api/auth/start")[0].json["account"] as? String, "a@b.c")
        let respond = core.recorded("/api/auth/respond")[0].json
        XCTAssertEqual(respond["password"] as? String, " pw ")
        XCTAssertEqual(respond["transactionId"] as? String, "t1"); XCTAssertEqual(respond["bindingToken"] as? String, "b1"); XCTAssertEqual(respond["stepId"] as? String, "s1")
        XCTAssertEqual(conn.credential.token, "TOKEN")
        let saved = try XCTUnwrap(store.load())
        XCTAssertEqual(saved.coreId, coreID); XCTAssertEqual(saved.name, "Mac")
        XCTAssertFalse(String(data: try JSONEncoder().encode(saved), encoding: .utf8)!.contains("pw"))
    }

    func testLoginRevokesIssuedSessionWhenCredentialCannotBeSaved() async throws {
        final class FailingStore: CredentialStore, @unchecked Sendable {
            func load() throws -> StoredCredential? { nil }
            func save(_ credential: StoredCredential) throws { throw CoreError(kind: .unsupported, message: "钥匙串错误 (-34018)") }
            func delete() throws {}
        }
        let core = loginCore()
        let svc = LoginService(store: FailingStore(), session: core.session)
        do { _ = try await svc.login(origin: core.origin.string, name: "n", account: "a", password: "p"); XCTFail() }
        catch let e as CoreError { XCTAssertEqual(e.message, "钥匙串错误 (-34018)") }
        XCTAssertEqual(core.recorded().map(\.path), ["/api/client/identity", "/api/auth/start", "/api/auth/respond", "/api/auth/logout"])
        let hasSaved = await svc.hasSavedLogin
        XCTAssertFalse(hasSaved)
    }

    func testLoginRejectsCoreChangeAndBadIdentities() async throws {
        let changed = loginCore(respondCore: "other")
        let (svc, store) = service(changed)
        do { _ = try await svc.login(origin: changed.origin.string, name: "n", account: "a", password: "p"); XCTFail() }
        catch let e as CoreError { XCTAssertEqual(e.message, "Core 身份在登录期间发生变化") }
        XCTAssertNil(try store.load())
        for (identity, message) in [(identityJSON(version: 2), "Core 不支持客户端协议 v1"), (identityJSON(loginRequired: false), "后端须启用 NexorAI 账号登录"),
                                    (identityJSON(methods: ["one-time-code"]), "后端须启用 NexorAI 账号登录"), (identityJSON(initialized: false), "后端尚未关联账号，请先在服务器运行 init 完成初始化")] {
            let core = loginCore(identity: identity)
            do { _ = try await service(core).0.login(origin: core.origin.string, name: "n", account: "a", password: "p"); XCTFail() }
            catch let e as CoreError { XCTAssertEqual(e.message, message) }
            XCTAssertEqual(core.recorded().map(\.path), ["/api/client/identity"])
        }
    }

    func testPlainHTTPLoginRequiresPrivateHost() async throws {
        let core = loginCore()
        // The stub origin is HTTPS; build an http public origin check through discover on a stub-host http origin.
        let publicHTTP = CoreOrigin(unchecked: "http://\(core.host)")
        do { _ = try await service(core).0.discover(origin: publicHTTP); XCTFail() }
        catch let e as CoreError { XCTAssertTrue(e.message.contains("HTTPS")) }
    }

    func testBootstrapRepointAndResumeRequiresIdentity() async throws {
        let core = loginCore()
        let old = StoredCredential(origin: "https://old.example.com", name: "Mac", token: "OLD", coreId: coreID, sessionId: "s", expiresAt: 1)
        let (svc, store) = service(core, saved: old, override: core.origin)
        let defaults = await svc.bootstrap(deviceName: "x")
        XCTAssertEqual(defaults.origin, core.origin.string); XCTAssertTrue(defaults.hasSavedLogin)
        XCTAssertEqual(try store.load()?.origin, core.origin.string)
        core.handle { r in r.path == "/api/client/identity" ? .json(self.identityJSON()) : .json(["authenticated": true, "coreId": coreID, "sessionId": "s", "expiresAt": 99]) }
        let conn = try await svc.resume()
        XCTAssertEqual(core.recorded().map(\.path), ["/api/client/identity", "/api/session"])
        XCTAssertNil(core.recorded("/api/client/identity")[0].headers["Authorization"], "token is not sent before identity is verified")
        XCTAssertEqual(core.recorded("/api/session")[0].json["token"] as? String, "OLD")
        XCTAssertEqual(conn.credential.expiresAt, 99)
    }

    func testResumeSkipsIdentityOnHTTPSOrigin() async throws {
        let core = StubCore()
        core.handle { _ in .json(["authenticated": true, "coreId": coreID, "sessionId": "sess", "expiresAt": 5]) }
        let (svc, _) = service(core, saved: credential(core))
        _ = await svc.bootstrap(deviceName: "x")
        _ = try await svc.resume()
        XCTAssertEqual(core.recorded().map(\.path), ["/api/session"])
    }

    func testResumeCoreChangeRejectedAndCredentialDeleted() async throws {
        let core = StubCore()
        core.handle { _ in .json(["authenticated": true, "coreId": "different", "sessionId": "sess"]) }
        let (svc, store) = service(core, saved: credential(core))
        _ = await svc.bootstrap(deviceName: "x")
        do { _ = try await svc.resume(); XCTFail() } catch let e as CoreError { XCTAssertEqual(e.status, 409); XCTAssertEqual(e.message, "Core 身份或登录状态不匹配") }
        XCTAssertNil(try store.load())
    }

    func testResumeDeletesCredentialOn401ButKeepsOnNetworkError() async throws {
        let core = StubCore()
        core.handle { _ in .json(["error": "Unauthorized"], status: 401) }
        let (svc, store) = service(core, saved: credential(core))
        _ = await svc.bootstrap(deviceName: "x")
        do { _ = try await svc.resume(); XCTFail() } catch let e as CoreError { XCTAssertEqual(e.status, 401) }
        XCTAssertNil(try store.load())

        let core2 = StubCore()
        core2.handle { _ in .json(["error": "boom"], status: 500) }
        let (svc2, store2) = service(core2, saved: credential(core2))
        _ = await svc2.bootstrap(deviceName: "x")
        do { _ = try await svc2.resume(); XCTFail() } catch { }
        XCTAssertNotNil(try store2.load())
    }

    func testLogoutBestEffortDeletes() async throws {
        let core = StubCore()
        core.handle { _ in StubResponse(status: 500) }
        let (svc, store) = service(core, saved: credential(core))
        _ = await svc.bootstrap(deviceName: "x")
        await svc.logout()
        XCTAssertEqual(core.recorded("/api/auth/logout").count, 1)
        XCTAssertEqual(core.recorded("/api/auth/logout")[0].headers["Authorization"], "Bearer OLD")
        XCTAssertNil(try store.load())
        let h = await svc.hasSavedLogin
        XCTAssertFalse(h)
    }

    @MainActor func testAppModelFlow() async throws {
        let core = loginCore()
        core.handle { r in
            switch r.path {
            case "/api/client/identity": return .json(self.identityJSON())
            case "/api/auth/start": return .json(["transactionId": "t1", "bindingToken": "b1", "stepId": "s1", "challenge": "password", "expiresAt": 1])
            case "/api/auth/respond": return .json(["token": "TOKEN", "coreId": coreID, "sessionId": "sess", "expiresAt": 1])
            case "/api/state": return .json(stateJSON())
            case "/api/events": return .text("")
            default: return .json(["ok": true])
            }
        }
        let store = InMemoryCredentialStore()
        let model = AppModel(options: LaunchOptions(origin: core.origin.string), store: store, session: core.session, deviceName: "Test Mac", timing: SyncTiming(debounce: 0.01, fallbackInterval: 100, backoff: Backoff(initial: 0.01, maximum: 0.01)))
        await model.start()
        XCTAssertEqual(model.phase, .loggedOut(error: nil)); XCTAssertEqual(model.origin, core.origin.string)
        await model.login(account: "a", password: "p")
        XCTAssertEqual(model.phase, .connected); XCTAssertNotNil(model.workspace)
        await model.logout()
        XCTAssertEqual(model.phase, .loggedOut(error: nil)); XCTAssertNil(model.workspace); XCTAssertNil(try store.load())
    }
}

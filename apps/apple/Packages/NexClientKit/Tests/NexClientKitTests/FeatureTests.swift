import XCTest
@testable import NexClientKit

private let fastTiming = SyncTiming(debounce: 0.01, fallbackInterval: 100, backoff: Backoff(initial: 0.01, maximum: 0.01))
private func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

/// Session refresh policy.
@MainActor
final class RefreshTests: XCTestCase {
    final class Core: @unchecked Sendable {
        let lock = NSLock()
        var refreshStatus = 200, refreshCore = coreID, token = "NEW", delay = 0.0
        func handler(_ r: RecordedRequest) -> StubResponse {
            lock.withLock {
                switch r.path {
                case "/api/auth/refresh":
                    if refreshStatus != 200 { return .json(["error": "x"], status: refreshStatus) }
                    return .json(["token": token, "coreId": refreshCore, "sessionId": "sess", "expiresAt": nowMs() + 8 * 3_600_000], delay: delay)
                case "/api/state": return .json(stateJSON())
                case "/api/agents/messages": return .json(feedJSON([]))
                case "/api/events": var held = StubResponse.text(""); held.delay = 2; return held   // a stream that stays open
                default: return .json(["ok": true])
                }
            }
        }
    }
    func make(expiresIn minutes: Double, _ fake: Core = Core()) -> (WorkspaceStore, StubCore, Core, Counter) {
        let core = StubCore(); core.handle(fake.handler)
        let store = WorkspaceStore(client: core.client(token: "OLD"), timing: fastTiming)
        let counter = Counter()
        store.enableSessionRefresh(expiresAt: nowMs() + minutes * 60_000, coreID: coreID) { counter.add($0) }
        return (store, core, fake, counter)
    }
    @MainActor final class Counter { var sessions: [LoginSession] = []; func add(_ s: LoginSession) { sessions.append(s) } }

    func testPolicy() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let ms = now.timeIntervalSince1970 * 1000
        XCTAssertTrue(WorkspaceStore.shouldRefresh(now: now, expiresAt: ms + 29 * 60_000))
        XCTAssertTrue(WorkspaceStore.shouldRefresh(now: now, expiresAt: ms + 30 * 60_000))
        XCTAssertFalse(WorkspaceStore.shouldRefresh(now: now, expiresAt: ms + 31 * 60_000))
        XCTAssertFalse(WorkspaceStore.shouldRefresh(now: now, expiresAt: ms - 1))
    }

    func testNearExpiryRefreshesOnceAndSwapsToken() async throws {
        let (store, core, _, counter) = make(expiresIn: 10)
        await store.refreshSessionIfNeeded()
        let reqs = core.recorded("/api/auth/refresh")
        XCTAssertEqual(reqs.count, 1)
        XCTAssertEqual(reqs[0].method, "POST"); XCTAssertEqual(reqs[0].headers["Authorization"], "Bearer OLD"); XCTAssertEqual(reqs[0].json.count, 0)
        XCTAssertEqual(counter.sessions.map(\.token), ["NEW"])
        XCTAssertEqual(store.client.token, "NEW")
        // The new expiry is 8 h away, so nothing more happens.
        await store.refreshSessionIfNeeded()
        XCTAssertEqual(core.recorded("/api/auth/refresh").count, 1)
        await store.refresh()
        XCTAssertEqual(core.recorded("/api/state").last?.headers["Authorization"], "Bearer NEW")
    }

    func testFarOrExpiredDoesNothing() async {
        for minutes in [120.0, -5] {
            let (store, core, _, counter) = make(expiresIn: minutes)
            await store.refreshSessionIfNeeded()
            XCTAssertEqual(core.recorded("/api/auth/refresh").count, 0); XCTAssertTrue(counter.sessions.isEmpty)
        }
    }

    func testNeverRefreshesConcurrently() async {
        let (store, core, fake, _) = make(expiresIn: 5)
        fake.lock.withLock { fake.delay = 0.15 }
        async let a: Void = store.refreshSessionIfNeeded(); async let b: Void = store.refreshSessionIfNeeded()
        _ = await (a, b)
        XCTAssertEqual(core.recorded("/api/auth/refresh").count, 1)
    }

    func testUnauthorizedEndsSession() async {
        let (store, _, fake, counter) = make(expiresIn: 5)
        fake.lock.withLock { fake.refreshStatus = 401 }
        var ends: [SessionEnd] = []
        store.onSessionEnded = { ends.append($0) }
        await store.refreshSessionIfNeeded()
        XCTAssertEqual(ends.count, 1); XCTAssertTrue(ends[0].deleteCredential)
        XCTAssertEqual(store.client.token, "OLD"); XCTAssertTrue(counter.sessions.isEmpty)
    }

    func testConflictThrottleAndNetworkKeepTokenAndRetry() async {
        for status in [409, 429, 503] {
            let (store, core, fake, counter) = make(expiresIn: 5)
            fake.lock.withLock { fake.refreshStatus = status }
            var ends = 0; store.onSessionEnded = { _ in ends += 1 }
            await store.refreshSessionIfNeeded()
            XCTAssertEqual(ends, 0, "\(status)"); XCTAssertEqual(store.client.token, "OLD"); XCTAssertTrue(counter.sessions.isEmpty)
            fake.lock.withLock { fake.refreshStatus = 200 }
            await store.refreshSessionIfNeeded()   // next tick retries
            XCTAssertEqual(core.recorded("/api/auth/refresh").count, 2); XCTAssertEqual(store.client.token, "NEW")
        }
    }

    func testCoreIDMismatchIsRejected() async {
        let (store, _, fake, counter) = make(expiresIn: 5)
        fake.lock.withLock { fake.refreshCore = "other-core" }
        var ends = 0; store.onSessionEnded = { _ in ends += 1 }
        await store.refreshSessionIfNeeded()
        XCTAssertEqual(store.client.token, "OLD"); XCTAssertTrue(counter.sessions.isEmpty); XCTAssertEqual(ends, 0)
    }

    func testStreamRestartsWithNewBearerAndKeepsContent() async throws {
        let (store, core, _, _) = make(expiresIn: 5)
        store.select("b1")
        store.start()
        try await Task.sleep(for: .milliseconds(150))   // start() itself triggers the check
        XCTAssertEqual(store.client.token, "NEW")
        try await Task.sleep(for: .milliseconds(150))
        let events = core.recorded("/api/events")
        XCTAssertEqual(events.first?.headers["Authorization"], "Bearer OLD")
        XCTAssertEqual(events.last?.headers["Authorization"], "Bearer NEW")
        XCTAssertNotNil(store.state, "content is kept across the swap")
        store.stop()
    }

    func testAppModelPersistsAndPublishesRotatedCredential() async throws {
        let fake = Core(), core = StubCore()
        core.handle { r in
            switch r.path {
            case "/api/client/identity": return .json(["version": 1, "coreId": coreID, "loginRequired": true, "initialized": true, "loginMethods": ["password"]])
            case "/api/auth/start": return .json(["transactionId": "t1", "bindingToken": "b1", "stepId": "s1", "challenge": "password", "expiresAt": 1])
            case "/api/auth/respond": return .json(["token": "TOKEN", "coreId": coreID, "sessionId": "sess", "expiresAt": nowMs() + 10 * 60_000])
            default: return fake.handler(r)
            }
        }
        let store = InMemoryCredentialStore()
        let model = AppModel(options: LaunchOptions(origin: core.origin.string), store: store, session: core.session, deviceName: "Mac", timing: fastTiming)
        await model.start()
        await model.login(account: "a", password: "p")
        XCTAssertEqual(model.phase, .connected)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(core.recorded("/api/auth/refresh").count, 1)
        XCTAssertEqual(core.recorded("/api/auth/refresh")[0].headers["Authorization"], "Bearer TOKEN")
        XCTAssertEqual(model.credential?.token, "NEW")
        XCTAssertGreaterThan(model.credential?.expiresAt ?? 0, nowMs() + 7 * 3_600_000)
        let saved = try XCTUnwrap(store.load())
        XCTAssertEqual(saved.token, "NEW"); XCTAssertEqual(saved.origin, core.origin.string); XCTAssertEqual(saved.name, "Mac"); XCTAssertEqual(saved.coreId, coreID)
        XCTAssertEqual(model.workspace?.client.token, "NEW")
        model.setForeground(false); model.setForeground(true)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(core.recorded("/api/auth/refresh").count, 1, "no second refresh while far from expiry")
        await model.logout()
    }

    func testPersistRefreshedRejectsOtherCore() async throws {
        let store = InMemoryCredentialStore(StoredCredential(origin: "https://x.test", name: "n", token: "OLD", coreId: coreID, sessionId: "s", expiresAt: 1))
        let svc = LoginService(store: store)
        _ = await svc.bootstrap(deviceName: "d")
        do { _ = try await svc.persistRefreshed(LoginSession(token: "N", coreId: "other", sessionId: "s", expiresAt: 2)); XCTFail() } catch {}
        XCTAssertEqual(try store.load()?.token, "OLD")
    }
}

/// Summary state, approval mode, model limits, account initial.
@MainActor
final class CoreFeatureTests: XCTestCase {
    func testSummaryQueryAndTolerantDecoding() async throws {
        let core = StubCore()
        core.handle { r in
            r.path == "/api/state" ? .json(["view": "summary", "sync": syncJSON(), "bots": [["id": "b1", "name": "A"]], "memories": [["id": "m1", "title": "t", "scope": "bot"]]]) : .json(["ok": true])
        }
        let store = WorkspaceStore(client: core.client(), timing: fastTiming)
        await store.refresh()
        XCTAssertEqual(core.recorded("/api/state")[0].query, "view=summary")
        XCTAssertEqual(store.state?.memories.first?.content, ""); XCTAssertEqual(store.state?.journal.count, 0)
        _ = try await core.client().state(view: .full)
        XCTAssertEqual(core.recorded("/api/state")[1].query, "")
        _ = try await core.client().state()
        XCTAssertEqual(core.recorded("/api/state")[2].query, "")
    }

    func testApprovalModeDecodingAndAction() async throws {
        let core = StubCore()
        core.handle { r in
            switch r.path {
            case "/api/state":
                var s = stateJSON(); s["bots"] = [["id": "b1", "name": "A", "approval_setting": "full", "approval_setting_version": 3], ["id": "b2", "name": "B"]]
                return .json(s)
            default: return .json(["ok": true])
            }
        }
        let store = WorkspaceStore(client: core.client(), timing: fastTiming)
        await store.refresh()
        XCTAssertEqual(store.bot("b1")?.approvalMode, .full); XCTAssertEqual(store.bot("b1")?.approvalModeVersion, 3)
        XCTAssertEqual(store.bot("b2")?.approvalMode, .standard); XCTAssertEqual(store.bot("b2")?.approvalModeVersion, 0)
        XCTAssertEqual(ApprovalMode.standard.title, "标准权限"); XCTAssertEqual(ApprovalMode.full.title, "完全权限")
        let before = core.recorded("/api/state").count
        try await store.setApprovalMode(botID: "b1", mode: .standard)
        let body = core.recorded("/api/bots/approval-mode")[0].json
        XCTAssertEqual(body["id"] as? String, "b1"); XCTAssertEqual(body["mode"] as? String, "standard"); XCTAssertEqual(body["version"] as? Int, 3)
        XCTAssertGreaterThan(core.recorded("/api/state").count, before)
    }

    func limitsJSON(manualContext: Any = NSNull(), refresh: String? = nil) -> [String: Any] {
        var j: [String: Any] = ["manual": ["contextWindow": manualContext, "maxOutputTokens": NSNull()], "contextWindow": 400_000, "maxOutputTokens": 128_000,
                                "matched": "openai/gpt-5", "status": "matched", "source": ["contextWindow": "manual", "maxOutputTokens": "models.dev"], "updatedAt": 1_760_000_000_000,
                                "automatic": ["contextWindow": 272_000, "maxOutputTokens": 128_000, "source": ["contextWindow": "models.dev", "maxOutputTokens": "models.dev"]]]
        if let refresh { j["refresh"] = refresh }
        return j
    }

    func testModelLimitsDecodingAndRequests() async throws {
        let core = StubCore()
        core.handle { r in r.path.hasPrefix("/api/models/limits") ? .json(self.limitsJSON(manualContext: 400_000, refresh: r.path.hasSuffix("refresh") ? "failed" : nil)) : .json(["ok": true]) }
        let c = core.client()
        let info = try await c.modelLimits(provider: "openai", endpoint: "https://api.example.com/v1", model: "gpt-5")
        let q = core.recorded("/api/models/limits")[0].json
        XCTAssertEqual(q["provider"] as? String, "openai"); XCTAssertEqual(q["endpoint"] as? String, "https://api.example.com/v1"); XCTAssertEqual(q["model"] as? String, "gpt-5"); XCTAssertNil(q["force"])
        XCTAssertEqual(info.contextWindow, 400_000); XCTAssertEqual(info.maxOutputTokens, 128_000)
        XCTAssertEqual(info.manual.contextWindow, 400_000); XCTAssertNil(info.manual.maxOutputTokens)
        XCTAssertEqual(info.source.contextWindow, .manual); XCTAssertEqual(info.source.maxOutputTokens, .modelsDev)
        XCTAssertEqual(info.status, .matched); XCTAssertEqual(info.matched, "openai/gpt-5"); XCTAssertNotNil(info.updatedAt)
        XCTAssertEqual(info.automatic.contextWindow, 272_000); XCTAssertEqual(info.automatic.source.contextWindow, .modelsDev)
        XCTAssertNil(info.refresh); XCTAssertEqual(ModelLimitSource.manual.label, "手动配置")
        let refreshed = try await c.refreshModelLimits(provider: "openai", endpoint: "https://api.example.com/v1", model: "gpt-5", force: true)
        let rb = core.recorded("/api/models/limits/refresh")[0].json
        XCTAssertEqual(rb["force"] as? Bool, true); XCTAssertEqual(refreshed.refresh, "failed"); XCTAssertTrue(refreshed.refreshFailed)
        let store = WorkspaceStore(client: c, timing: fastTiming)
        let before = core.recorded("/api/state").count
        _ = try await store.modelLimits(provider: "openai", endpoint: "e", model: "m"); _ = try await store.refreshModelLimits(provider: "openai", endpoint: "e", model: "m")
        XCTAssertEqual(core.recorded("/api/state").count, before, "reads do not refresh")
        XCTAssertEqual(core.recorded("/api/models/limits/refresh")[1].json["force"] as? Bool, false)
    }

    func testModelLimitsLenientDefaults() throws {
        let info = try JSONDecoder().decode(ModelLimitInfo.self, from: Data(#"{"status":"weird","source":{"contextWindow":"x"}}"#.utf8))
        XCTAssertEqual(info.contextWindow, ModelLimits.defaultContextWindow); XCTAssertEqual(info.maxOutputTokens, ModelLimits.defaultMaxOutputTokens)
        XCTAssertEqual(ModelLimits.defaultContextWindow, 256_000); XCTAssertEqual(ModelLimits.defaultMaxOutputTokens, 32_000)
        XCTAssertEqual(info.status, .unknown); XCTAssertEqual(info.source.contextWindow, .default); XCTAssertNil(info.manual.contextWindow)
    }

    func testSaveModelTriStateEncoding() async throws {
        let core = StubCore(); core.handle { _ in .json(["ok": true]) }
        let c = core.client()
        try await c.saveModel(ModelSettings(provider: "openai", model: "m", endpoint: "https://x.test/v1", apiKey: "k"))
        var raw = String(data: core.recorded("/api/config")[0].body, encoding: .utf8)!
        XCTAssertFalse(raw.contains("contextWindow")); XCTAssertFalse(raw.contains("maxOutputTokens"))
        try await c.saveModel(ModelSettings(provider: "openai", model: "m", endpoint: "https://x.test/v1", contextWindow: .automatic, maxOutputTokens: .manual(64_000)))
        let body = core.recorded("/api/config")[1]
        raw = String(data: body.body, encoding: .utf8)!
        XCTAssertTrue(raw.contains(#""contextWindow":null"#)); XCTAssertEqual(body.json["maxOutputTokens"] as? Int, 64_000); XCTAssertNil(body.json["apiKey"])
        XCTAssertTrue(body.json.keys.contains("contextWindow"))
        let store = WorkspaceStore(client: c, timing: fastTiming)
        try await store.saveModel(provider: "anthropic", model: "m", endpoint: "https://x.test", contextWindow: .manual(2048))
        let b3 = core.recorded("/api/config")[2].json
        XCTAssertEqual(b3["contextWindow"] as? Int, 2048); XCTAssertFalse(b3.keys.contains("maxOutputTokens"))
    }

    func testLimitParsing() throws {
        XCTAssertEqual(try ModelLimits.parse("", field: .contextWindow), .automatic)
        XCTAssertEqual(try ModelLimits.parse(" 4096 ", field: .contextWindow), .manual(4096))
        XCTAssertEqual(try ModelLimits.parse("1", field: .maxOutputTokens), .manual(1))
        for (text, field, message) in [("1023", ModelLimits.Field.contextWindow, "上下文窗口须为 1,024 至 10,000,000 的整数"), ("1.5", .contextWindow, "上下文窗口须为 1,024 至 10,000,000 的整数"),
                                       ("0", .maxOutputTokens, "最大输出 Token 须为 1 至 10,000,000 的整数"), ("10000001", .maxOutputTokens, "最大输出 Token 须为 1 至 10,000,000 的整数")] {
            XCTAssertThrowsError(try ModelLimits.parse(text, field: field)) { XCTAssertEqual(($0 as? CoreError)?.message, message) }
        }
        XCTAssertEqual(LimitSetting(nil), .automatic); XCTAssertEqual(LimitSetting(5), .manual(5))
    }

    func testAccountInitial() {
        XCTAssertEqual(AccountStatus(authenticated: true, displayName: "演示账号").initial, "演")
        XCTAssertEqual(AccountStatus(authenticated: true, displayName: "  alice").initial, "a")
        XCTAssertEqual(AccountStatus(authenticated: true, displayName: nil).initial, "N")
        XCTAssertEqual(AccountStatus(authenticated: true, displayName: "  ").initial, "N")
    }
}

/// Attachments: upload, download, link parsing and send/retry semantics.
@MainActor
final class AttachmentTests: XCTestCase {
    final class Core: @unchecked Sendable {
        let lock = NSLock()
        var uploads = 0, failInput = 0, failUpload: Int?, inputStatus = 200
        func handler(_ r: RecordedRequest) -> StubResponse {
            lock.withLock {
                switch r.path {
                case "/api/attachments":
                    uploads += 1
                    if let f = failUpload, f == uploads { return .json(["error": "文件编码无效"], status: 400) }
                    let name = r.json["name"] as? String ?? ""
                    return .json(["id": "att\(uploads)", "botId": r.json["botId"] as? String ?? "", "name": name, "mime": "application/pdf", "size": 3])
                case "/api/agents/input":
                    if failInput > 0 { failInput -= 1; return .json(["error": "无法连接 Core"], status: 503) }
                    return .json(["ok": true], status: 202)
                case "/api/state": return .json(stateJSON())
                case "/api/events": return .text("")
                case "/api/agents/messages": return .json(feedJSON([]))
                default:
                    if r.path.hasPrefix("/api/attachments/") {
                        return StubResponse(status: 200, headers: ["Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20v1.pdf"], body: Data([1, 2, 3]))
                    }
                    return .json(["ok": true])
                }
            }
        }
    }
    func make() -> (WorkspaceStore, ConversationStore, StubCore, Core) {
        let core = StubCore(), fake = Core(); core.handle(fake.handler)
        let store = WorkspaceStore(client: core.client(), timing: fastTiming)
        return (store, store.conversation(for: "b1"), core, fake)
    }

    func testUploadRequestAndChecks() async throws {
        let core = StubCore(), fake = Core(); core.handle(fake.handler)
        let c = core.client()
        let a = try await c.uploadAttachment(botID: "b1", name: "报告.pdf", data: Data([1, 2, 3]))
        let r = core.recorded("/api/attachments")[0]
        XCTAssertEqual(r.method, "POST"); XCTAssertEqual(r.json["botId"] as? String, "b1"); XCTAssertEqual(r.json["name"] as? String, "报告.pdf")
        XCTAssertEqual(r.json["data"] as? String, Data([1, 2, 3]).base64EncodedString()); XCTAssertEqual(r.headers["Authorization"], "Bearer tok")
        XCTAssertEqual(a, ChatAttachment(id: "att1", botID: "b1", name: "报告.pdf", mime: "application/pdf", size: 3))
        for data in [Data(), Data(count: 5 * 1024 * 1024 + 1)] {
            do { _ = try await c.uploadAttachment(botID: "b1", name: "x", data: data); XCTFail() } catch { XCTAssertEqual((error as? CoreError)?.message, "文件不能超过 5 MB") }
        }
        XCTAssertEqual(core.recorded("/api/attachments").count, 1)
        _ = try await c.uploadAttachment(botID: "b1", name: "max", data: Data(count: 5 * 1024 * 1024))
        XCTAssertEqual(core.recorded("/api/attachments").count, 2)
    }

    func testDownloadParsesFilename() async throws {
        let core = StubCore(), fake = Core(); core.handle(fake.handler)
        let (data, name) = try await core.client().downloadAttachment(id: "abc-1")
        XCTAssertEqual(data, Data([1, 2, 3])); XCTAssertEqual(name, "报告 v1.pdf")
        let r = core.recorded("/api/attachments/abc-1")[0]
        XCTAssertEqual(r.method, "GET"); XCTAssertEqual(r.headers["Authorization"], "Bearer tok")
        XCTAssertEqual(CoreClient.dispositionFilename(#"attachment; filename="a b.txt""#), "a b.txt")
        XCTAssertNil(CoreClient.dispositionFilename(nil))
        do { _ = try await core.client().downloadAttachment(id: "../x"); XCTFail() } catch { XCTAssertEqual((error as? CoreError)?.status, 404) }
        core.handle { _ in .json(["error": "附件不存在或不可访问"], status: 400) }
        do { _ = try await core.client().downloadAttachment(id: "z"); XCTFail() } catch { XCTAssertEqual((error as? CoreError)?.message, "附件不存在或不可访问") }
    }

    func testLinkParsing() {
        let parsed = AttachmentLink.parse("看这个\n\n[报告.pdf](/api/attachments/abc-123)\n[b.png](/api/attachments/d_4)")
        XCTAssertEqual(parsed.links, [AttachmentLink(id: "abc-123", name: "报告.pdf"), AttachmentLink(id: "d_4", name: "b.png")])
        XCTAssertEqual(parsed.body, "看这个")
        let only = AttachmentLink.parse("\n\n[a](/api/attachments/x1)")
        XCTAssertEqual(only.links.map(\.id), ["x1"]); XCTAssertEqual(only.body, "")
        let plain = AttachmentLink.parse("hello [x](https://e.com)\n- list")
        XCTAssertTrue(plain.links.isEmpty); XCTAssertEqual(plain.body, "hello [x](https://e.com)\n- list")
        let middle = AttachmentLink.parse("[a](/api/attachments/x1)\n后面还有文字")
        XCTAssertTrue(middle.links.isEmpty); XCTAssertEqual(middle.body, "[a](/api/attachments/x1)\n后面还有文字")
        XCTAssertTrue(AttachmentLink.parse("[bad[name](/api/attachments/x1)").links.isEmpty)
        XCTAssertTrue(AttachmentLink.parse("").links.isEmpty)
    }

    func testAddRemoveAndLimits() async {
        let (_, conv, core, fake) = make()
        await conv.addAttachment(name: "a.pdf", data: Data([1, 2, 3]))
        XCTAssertEqual(conv.attachments.count, 1); XCTAssertEqual(conv.attachments[0].attachment?.id, "att1"); XCTAssertEqual(conv.attachments[0].name, "a.pdf")
        XCTAssertTrue(conv.canSend, "files alone can be sent")
        await conv.addAttachment(name: "big", data: Data(count: 5 * 1024 * 1024 + 1))
        XCTAssertEqual(conv.sendError, "文件不能超过 5 MB"); XCTAssertEqual(conv.attachments.count, 1)
        for i in 0..<4 { await conv.addAttachment(name: "f\(i)", data: Data([1])) }
        XCTAssertEqual(conv.attachments.count, 5)
        await conv.addAttachment(name: "sixth", data: Data([1]))
        XCTAssertEqual(conv.sendError, "最多添加 5 个附件"); XCTAssertEqual(conv.attachments.count, 5)
        XCTAssertEqual(core.recorded("/api/attachments").count, 5)
        conv.removeAttachment(conv.attachments[0])
        XCTAssertEqual(conv.attachments.count, 4)
        fake.lock.withLock { fake.failUpload = 6 }
        await conv.addAttachment(name: "bad", data: Data([1]))
        XCTAssertEqual(conv.attachments.last?.errorMessage, "文件编码无效")
        XCTAssertEqual(conv.readyAttachments.count, 4)
    }

    func testSendWithAttachmentsRetryAndClear() async throws {
        let (_, conv, core, fake) = make()
        await conv.addAttachment(name: "a.pdf", data: Data([1])); await conv.addAttachment(name: "b.pdf", data: Data([2]))
        fake.lock.withLock { fake.failInput = 1 }
        let first = await conv.send(text: "")           // empty text is allowed with files
        XCTAssertFalse(first); XCTAssertEqual(conv.attachments.count, 2, "kept after failure"); XCTAssertEqual(conv.sendError, "无法连接 Core")
        let ok = await conv.send(text: "")
        XCTAssertTrue(ok); XCTAssertTrue(conv.attachments.isEmpty)
        let inputs = core.recorded("/api/agents/input")
        XCTAssertEqual(inputs.count, 2)
        XCTAssertEqual(inputs[0].json["clientId"] as? String, inputs[1].json["clientId"] as? String)
        XCTAssertEqual(inputs[0].json["attachments"] as? [String], ["att1", "att2"]); XCTAssertEqual(inputs[1].json["attachments"] as? [String], ["att1", "att2"])
        XCTAssertEqual(inputs[1].json["text"] as? String, ""); XCTAssertEqual(inputs[1].json["botId"] as? String, "b1")
    }

    func testChangingFilesChangesClientIDAndNoSendWhenEmptyOrUploading() async throws {
        let (_, conv, core, fake) = make()
        let nothing = await conv.send(); XCTAssertFalse(nothing)
        XCTAssertEqual(core.recorded("/api/agents/input").count, 0)
        await conv.addAttachment(name: "a", data: Data([1]))
        fake.lock.withLock { fake.failInput = 1 }
        conv.draft = "hi"
        _ = await conv.send()
        await conv.addAttachment(name: "b", data: Data([2]))
        _ = await conv.send()
        let inputs = core.recorded("/api/agents/input")
        XCTAssertNotEqual(inputs[0].json["clientId"] as? String, inputs[1].json["clientId"] as? String)
        XCTAssertEqual(inputs[1].json["attachments"] as? [String], ["att1", "att2"]); XCTAssertEqual(inputs[1].json["text"] as? String, "hi")
        XCTAssertEqual(conv.draft, ""); XCTAssertTrue(conv.attachments.isEmpty)
    }

    func testTextOnlySendOmitsAttachments() async throws {
        let (_, conv, core, _) = make()
        _ = await conv.send(text: "hello")
        XCTAssertNil(core.recorded("/api/agents/input")[0].json["attachments"])
    }

    func testUploadingBlocksSend() async throws {
        let core = StubCore()
        core.handle { r in r.path == "/api/attachments" ? .json(["id": "a1", "botId": "b1", "name": "n", "mime": "x", "size": 1], delay: 0.2) : .json(["ok": true], status: 202) }
        let store = WorkspaceStore(client: core.client(), timing: fastTiming), conv = store.conversation(for: "b1")
        async let up: Void = conv.addAttachment(name: "n", data: Data([1]))
        try await Task.sleep(for: .milliseconds(60))
        XCTAssertTrue(conv.isUploadingAttachments)
        let blocked = await conv.send(text: "x"); XCTAssertFalse(blocked)
        await up
        XCTAssertFalse(conv.isUploadingAttachments)
        let sent = await conv.send(text: "x"); XCTAssertTrue(sent)
    }
}

/// Markdown export.
@MainActor
final class ExportTests: XCTestCase {
    func make(_ fake: SyncTests.Fake, extra: (@Sendable (RecordedRequest) -> StubResponse?)? = nil) -> (WorkspaceStore, StubCore) {
        let core = StubCore()
        core.handle { r in extra?(r) ?? fake.handler(r) }
        return (WorkspaceStore(client: core.client(), timing: fastTiming), core)
    }

    func testPaginatesAndFormats() async throws {
        let fake = SyncTests.Fake(); fake.seqs = Array(1...450)
        let (store, core) = make(fake)
        store.select("b1"); await store.refresh()
        let result = try await store.exportMarkdown(botID: "b1", timeZone: TimeZone(identifier: "UTC")!)
        let after = core.recorded("/api/agents/messages").filter { $0.query.contains("after=") }.map(\.query)
        XCTAssertEqual(after.suffix(3).map { $0.components(separatedBy: "after=")[1] }, ["0", "200", "400"])
        XCTAssertEqual(result.filename, "Bot b1-对话.md")
        let parts = result.content.components(separatedBy: "\n\n---\n\n")
        XCTAssertEqual(parts.count, 450)
        XCTAssertEqual(parts[0], "### Bot b1 · 10/9 08:53\n\nmsg 1")
        XCTAssertEqual(core.recorded("/api/state").last?.query, "view=summary")
    }

    func testSenderLabelsAndFilename() async throws {
        let fake = SyncTests.Fake()
        let core = StubCore()
        core.handle { r in
            switch r.path {
            case "/api/state": return .json(["sync": syncJSON(), "bots": [["id": "b1", "name": "a/b:c*d?e\"f<g>h|i"], ["id": "p1", "name": "同伴"]]])
            case "/api/agents/messages":
                var rows = [message(1, role: "user", content: "你好"), message(2, role: "system", content: "已启动"), message(3, role: "assistant", content: "收到")]
                var peer = message(4, role: "peer", content: "来自同伴"); peer["a2a_peer_id"] = "p1"
                var unknown = message(5, role: "peer", content: "?"); unknown["sender_bot_id"] = "gone"
                rows += [peer, unknown]
                return .json(["sync": syncJSON(), "messages": rows, "hasMore": false, "streaming": []])
            default: return fake.handler(r)
            }
        }
        let store = WorkspaceStore(client: core.client(), timing: fastTiming)
        store.select("b1"); await store.refresh()
        let result = try await store.exportMarkdown(botID: "b1", timeZone: TimeZone(identifier: "UTC")!)
        XCTAssertEqual(result.filename, "a_b_c_d_e_f_g_h_i-对话.md")
        let headers = result.content.components(separatedBy: "\n\n---\n\n").map { $0.components(separatedBy: " · ")[0] }
        XCTAssertEqual(headers, ["### 我", "### 系统", "### a/b:c*d?e\"f<g>h|i", "### 同伴", "### 同伴 Agent"])
    }

    func testAbortsWhenPrivacyEpochChangesMidExport() async throws {
        let fake = SyncTests.Fake(); fake.seqs = Array(1...450)
        let (store, _) = make(fake) { @Sendable r in
            if r.path == "/api/agents/messages", r.query.contains("after=200") { fake.lock.withLock { fake.sync = syncJSON(epoch: 1) } }
            return nil
        }
        store.select("b1"); await store.refresh()
        do { _ = try await store.exportMarkdown(botID: "b1"); XCTFail() }
        catch { XCTAssertEqual((error as? CoreError)?.message, "对话已变化，请重新导出") }
    }

    func testAbortsWhenFinalSummaryShowsChange() async throws {
        let fake = SyncTests.Fake()
        let calls = NSLock(); nonisolated(unsafe) var stateCalls = 0
        let (store, _) = make(fake) { @Sendable r in
            if r.path == "/api/state" {
                calls.lock(); stateCalls += 1; let n = stateCalls; calls.unlock()
                if n >= 2 { return .json(stateJSON(sync: syncJSON(core: "other"))) }
            }
            return nil
        }
        store.select("b1"); await store.refresh()
        do { _ = try await store.exportMarkdown(botID: "b1"); XCTFail() }
        catch { XCTAssertEqual((error as? CoreError)?.message, "对话已变化，请重新导出") }
    }

    func testAbortsWhenSelectionChangesOrNotSelected() async throws {
        let fake = SyncTests.Fake()
        let (store, _) = make(fake)
        store.select("b1"); await store.refresh()
        do { _ = try await store.exportMarkdown(botID: "other"); XCTFail() }
        catch { XCTAssertEqual((error as? CoreError)?.message, "对话已变化，请重新导出") }
        async let export = store.exportMarkdown(botID: "b1")
        store.select("b2")
        do { _ = try await export; XCTFail() }
        catch { XCTAssertEqual((error as? CoreError)?.message, "对话已变化，请重新导出") }
    }
}

import XCTest
@testable import NexClientKit

@MainActor
final class SyncTests: XCTestCase {
    func makeStore(_ core: StubCore) -> WorkspaceStore {
        WorkspaceStore(client: core.client(), timing: SyncTiming(debounce: 0.01, fallbackInterval: 100, backoff: Backoff(initial: 0.01, maximum: 0.01)))
    }
    /// A configurable Core with a message log per bot.
    final class Fake: @unchecked Sendable {
        let lock = NSLock()
        var sync = syncJSON(), seqs = Array(1...3), stateDelay = 0.0
        func handler(_ r: RecordedRequest) -> StubResponse {
            lock.withLock {
                switch r.path {
                case "/api/state": return .json(stateJSON(sync: sync), delay: stateDelay)
                case "/api/agents/messages":
                    let q = Dictionary(uniqueKeysWithValues: r.query.split(separator: "&").map { p -> (String, String) in let kv = p.split(separator: "="); return (String(kv[0]), String(kv[1])) })
                    if let a = q["after"].flatMap(Int.init) {
                        let page = Array(seqs.filter { $0 > a }.prefix(200))
                        return .json(feedJSON(page, sync: sync, hasMore: page.count == 200))
                    }
                    if let b = q["before"].flatMap(Int.init) { return .json(feedJSON(Array(seqs.filter { $0 < b }.suffix(100)), sync: sync)) }
                    return .json(feedJSON(Array(seqs.suffix(100)), sync: sync))
                default: return .json(["ok": true])
                }
            }
        }
    }

    func testInitialLoadAndReadReceiptOncePerSeq() async throws {
        let core = StubCore(), fake = Fake(); core.handle(fake.handler)
        let store = makeStore(core)
        store.select("b1")
        let conv = store.conversation(for: "b1")
        conv.isActive = true
        await store.refresh()
        XCTAssertEqual(conv.messages.map(\.seq), [1, 2, 3]); XCTAssertEqual(store.connection, .connected)
        await conv.markReadIfNeeded(); await conv.markReadIfNeeded()
        try await Task.sleep(for: .milliseconds(50))
        let reads = core.recorded("/api/agents/read")
        XCTAssertEqual(reads.count, 1); XCTAssertEqual(reads[0].json["seq"] as? Int, 3)
        fake.lock.withLock { fake.seqs.append(4) }
        await store.refresh()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(conv.messages.map(\.seq), [1, 2, 3, 4])
        XCTAssertEqual(core.recorded("/api/agents/read").map { $0.json["seq"] as? Int }, [3, 4])
        XCTAssertTrue(core.recorded("/api/agents/messages").last!.query.contains("after=3"))
    }

    func testInactiveConversationDoesNotMarkRead() async throws {
        let core = StubCore(), fake = Fake(); core.handle(fake.handler)
        let store = makeStore(core); store.select("b1")
        await store.refresh(); try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(core.recorded("/api/agents/read").count, 0)
    }

    func testHasMoreDrain() async throws {
        let core = StubCore(), fake = Fake(); fake.seqs = Array(1...450); core.handle(fake.handler)
        let store = makeStore(core); store.select("b1")
        let conv = store.conversation(for: "b1")
        await store.refresh()
        XCTAssertEqual(conv.messages.count, 100); XCTAssertEqual(conv.messages.first?.seq, 351)
        fake.lock.withLock { fake.seqs = Array(1...900) }
        await store.refresh()
        XCTAssertEqual(conv.messages.last?.seq, 900)
        XCTAssertEqual(conv.messages.count, 550, "351...900 via two after pages of 200 and 200 and 150")
        let afters = core.recorded("/api/agents/messages").map(\.query).filter { $0.contains("after=") }
        XCTAssertEqual(afters, ["bot=b1&after=450", "bot=b1&after=650", "bot=b1&after=850"])
    }

    func testLoadOlder() async throws {
        let core = StubCore(), fake = Fake(); fake.seqs = Array(1...250); core.handle(fake.handler)
        let store = makeStore(core); store.select("b1")
        let conv = store.conversation(for: "b1")
        await store.refresh()
        XCTAssertTrue(conv.hasOlder); XCTAssertEqual(conv.messages.first?.seq, 151)
        await conv.loadOlder()
        XCTAssertEqual(conv.messages.first?.seq, 51); XCTAssertEqual(conv.messages.count, 200); XCTAssertTrue(conv.hasOlder)
        await conv.loadOlder(); await conv.loadOlder()
        XCTAssertEqual(conv.messages.first?.seq, 1); XCTAssertFalse(conv.hasOlder)
        XCTAssertEqual(Set(conv.messages.map(\.seq)).count, 250)
    }

    func testResetEventClearsContent() async throws {
        let core = StubCore(), fake = Fake(); core.handle(fake.handler)
        let store = makeStore(core); store.select("b1")
        let conv = store.conversation(for: "b1"); conv.draft = "typing"
        await store.refresh()
        XCTAssertFalse(conv.messages.isEmpty)
        store.handleChange(ChangeEvent(sync: store.sync!, reset: true))
        XCTAssertTrue(conv.messages.isEmpty); XCTAssertNil(store.state); XCTAssertEqual(conv.draft, "typing")
    }

    func testEpochBootAndCoreChangeInvalidate() async throws {
        for changed in [syncJSON(epoch: 1), syncJSON(boot: "boot-2"), syncJSON(core: "core-2")] {
            let core = StubCore(), fake = Fake(); core.handle(fake.handler)
            let store = makeStore(core); store.select("b1")
            let conv = store.conversation(for: "b1")
            await store.refresh()
            XCTAssertFalse(conv.messages.isEmpty)
            let event = try JSONDecoder().decode(ChangeEvent.self, from: JSONSerialization.data(withJSONObject: changed))
            store.handleChange(event)
            XCTAssertTrue(conv.messages.isEmpty, "\(changed)"); XCTAssertNil(store.state)
        }
        // A cursor-only change keeps content.
        let core = StubCore(), fake = Fake(); core.handle(fake.handler)
        let store = makeStore(core); store.select("b1"); await store.refresh()
        store.handleChange(ChangeEvent(sync: SyncIdentity(cursor: 99, privacyEpoch: 0, coreId: coreID, bootId: "boot-1")))
        XCTAssertFalse(store.conversation(for: "b1").messages.isEmpty)
    }

    func testReloadAfterEpochChangeDropsOldMessages() async throws {
        let core = StubCore(), fake = Fake(); core.handle(fake.handler)
        let store = makeStore(core); store.select("b1")
        let conv = store.conversation(for: "b1")
        await store.refresh()
        fake.lock.withLock { fake.sync = syncJSON(epoch: 1); fake.seqs = [10, 11] }
        await store.refresh()
        XCTAssertEqual(conv.messages.map(\.seq), [10, 11], "old generation messages must not be merged")
    }

    func testStaleResponseDiscarded() async throws {
        let core = StubCore(), fake = Fake(); core.handle(fake.handler)
        let store = makeStore(core); store.select("b1")
        let conv = store.conversation(for: "b1")
        fake.lock.withLock { fake.stateDelay = 0.3 }
        let slow = Task { await store.refresh() }
        try await Task.sleep(for: .milliseconds(50))
        store.handleChange(ChangeEvent(sync: SyncIdentity(coreId: coreID, bootId: "boot-1"), reset: true))  // bumps the serial
        await slow.value
        XCTAssertNil(store.state); XCTAssertTrue(conv.messages.isEmpty, "response that started before the reset is discarded")
    }

    func testNetworkFailureShowsResyncAndRecovers() async throws {
        let core = StubCore(), fake = Fake(); core.handle(fake.handler)
        let store = makeStore(core); store.select("b1")
        await store.refresh()
        core.handle { _ in StubResponse(status: 502, headers: ["Content-Type": "application/json"], body: Data(#"{"error":"bad gateway"}"#.utf8)) }
        await store.refresh()
        XCTAssertEqual(store.connection, .resyncing); XCTAssertEqual(store.notice, "正在重新同步…"); XCTAssertNil(store.state)
        core.handle(fake.handler)
        await store.refresh()
        XCTAssertEqual(store.connection, .connected); XCTAssertNil(store.notice); XCTAssertEqual(store.conversation(for: "b1").messages.count, 3)
    }

    func testUnauthorizedEndsSession() async throws {
        let core = StubCore(); core.handle { _ in .json(["error": "Unauthorized"], status: 401) }
        let store = makeStore(core)
        var ends: [SessionEnd] = []
        store.onSessionEnded = { ends.append($0) }
        store.select("b1"); await store.refresh()
        XCTAssertEqual(ends, [SessionEnd(message: WorkspaceStore.expiredMessage, deleteCredential: true)])

        let core2 = StubCore(); core2.handle { _ in .json(["error": "身份不可用", "code": "identity_unavailable"], status: 503) }
        let store2 = makeStore(core2); var ends2: [SessionEnd] = []
        store2.onSessionEnded = { ends2.append($0) }
        await store2.refresh()
        XCTAssertEqual(ends2.map(\.deleteCredential), [false])
    }

    func testRevokedEventEndsSession() async throws {
        let core = StubCore(), fake = Fake(); core.handle(fake.handler)
        let store = makeStore(core); await store.refresh()
        var ends: [SessionEnd] = []
        store.onSessionEnded = { ends.append($0) }
        store.handle(.event(SSEEvent(id: nil, event: "revoked", data: "{}")))
        XCTAssertEqual(ends.count, 1); XCTAssertTrue(ends[0].deleteCredential); XCTAssertNil(store.state)
    }

    func testStreamingTextAndSelectionOfMissingBot() async throws {
        let core = StubCore()
        core.handle { r in
            r.path == "/api/state" ? .json(stateJSON(bots: ["b1", "b2"])) : .json(feedJSON([1], streaming: [["taskId": "t", "text": "par"], ["taskId": "u", "text": ""]]))
        }
        let store = makeStore(core); store.select("b1")
        await store.refresh()
        XCTAssertEqual(store.conversation(for: "b1").streaming, [StreamingText(taskId: "t", text: "par")])
        store.select("gone"); await store.refresh()
        XCTAssertEqual(store.selectedBotID, "b1", "falls back to the first bot")
    }

    // MARK: Sending

    func testSendRetryKeepsClientID() async throws {
        let core = StubCore(), fake = Fake()
        nonisolated(unsafe) var failing = true
        core.handle { r in
            if r.path == "/api/agents/input" && failing { failing = false; return StubResponse(status: 503, headers: ["Content-Type": "application/json"], body: Data(#"{"error":"busy"}"#.utf8)) }
            if r.path == "/api/agents/input" { return .json(["accepted": true], status: 202) }
            return fake.handler(r)
        }
        let store = makeStore(core); store.select("b1")
        let conv = store.conversation(for: "b1")
        conv.draft = "  hello  "
        let first = await conv.send()
        XCTAssertFalse(first); XCTAssertEqual(conv.sendError, "busy"); XCTAssertEqual(conv.draft, "  hello  ")
        let second = await conv.send()
        XCTAssertTrue(second); XCTAssertEqual(conv.draft, ""); XCTAssertNil(conv.sendError)
        let inputs = core.recorded("/api/agents/input").map(\.json)
        XCTAssertEqual(inputs.count, 2)
        XCTAssertEqual(inputs[0]["clientId"] as? String, inputs[1]["clientId"] as? String)
        XCTAssertNotNil(UUID(uuidString: inputs[0]["clientId"] as! String))
        XCTAssertEqual(inputs[0]["text"] as? String, "hello"); XCTAssertEqual(inputs[0]["botId"] as? String, "b1")
        conv.draft = "next"; _ = await conv.send()
        XCTAssertNotEqual(core.recorded("/api/agents/input")[2].json["clientId"] as? String, inputs[0]["clientId"] as? String)
    }

    func testChangedTextGetsNewClientID() async throws {
        let core = StubCore(), fake = Fake()
        core.handle { r in r.path == "/api/agents/input" ? StubResponse(status: 500, headers: ["Content-Type": "application/json"], body: Data("{}".utf8)) : fake.handler(r) }
        let store = makeStore(core); let conv = store.conversation(for: "b1")
        conv.draft = "a"; _ = await conv.send(); conv.draft = "b"; _ = await conv.send()
        let ids = core.recorded("/api/agents/input").map { $0.json["clientId"] as? String }
        XCTAssertNotEqual(ids[0], ids[1])
    }

    func testStopCancelsUnfinishedTask() async throws {
        let core = StubCore()
        core.handle { r in
            r.path == "/api/state" ? .json(stateJSON(tasks: [["id": "old", "bot_id": "b1", "status": "succeeded", "ended_at": 5], ["id": "run", "bot_id": "b1", "status": "running", "ended_at": NSNull()]]))
                : .json(feedJSON([1]))
        }
        let store = makeStore(core); store.select("b1"); await store.refresh()
        let conv = store.conversation(for: "b1")
        XCTAssertEqual(conv.activeTask?.id, "run"); XCTAssertTrue(conv.canStop)
        await conv.stop()
        XCTAssertEqual(core.recorded("/api/cancel")[0].json["taskId"] as? String, "run")
    }

    func testApprovalDecisionAndSessions() async throws {
        let core = StubCore()
        let hash = String(repeating: "a", count: 64)
        core.handle { r in
            switch r.path {
            case "/api/state": var s = stateJSON(); s["approvals"] = [["id": "ap1", "argument_hash": hash, "tool_name": "device.exec", "bot_id": "b1", "arguments_json": "{}"]]; return .json(s)
            case "/api/clients": return .json(["sessions": [["session_id": "s1", "client_name": "Mac"], ["session_id": "s2", "client_name": "iPhone"]], "currentSessionId": "s1"])
            default: return .json(["ok": true])
            }
        }
        let store = makeStore(core); await store.refresh()
        XCTAssertEqual(store.pendingApprovalCount, 1)
        try await store.decide(store.approvals[0], allow: true)
        let body = core.recorded("/api/approvals")[0].json
        XCTAssertEqual(body["id"] as? String, "ap1"); XCTAssertEqual(body["hash"] as? String, hash); XCTAssertEqual(body["allow"] as? Bool, true)
        try await store.loadSessions()
        XCTAssertEqual(store.sessions.map(\.sessionID), ["s1", "s2"]); XCTAssertEqual(store.currentSessionID, "s1")
        try await store.revokeSession("s2")
        XCTAssertEqual(core.recorded("/api/clients/revoke")[0].json["sessionId"] as? String, "s2")
    }

    func testAccountDisplayNameFromAuthStatus() async throws {
        let core = StubCore()
        core.handle { r in
            r.path == "/api/auth/status"
                ? .json(["authenticated": true, "expiresAt": 1_760_000_000_000, "account": ["displayName": "演示账号", "protocol": "native-v1", "deviceName": "Mac"]])
                : .json(["ok": true])
        }
        let store = makeStore(core)
        await store.loadAccount()
        XCTAssertEqual(store.account?.displayName, "演示账号"); XCTAssertEqual(store.account?.deviceName, "Mac")
        let signedOut = StubCore()
        signedOut.handle { _ in .json(["authenticated": false]) }
        let other = makeStore(signedOut); await other.loadAccount()
        XCTAssertNil(other.account)
    }

    func testStartStopLifecycleSendsLastEventID() async throws {
        let core = StubCore(), fake = Fake()
        let change = #"{"cursor":7,"privacyEpoch":0,"coreId":"core-1","bootId":"boot-1","reset":false}"#
        core.handle { r in r.path == "/api/events" ? .text("id: 7\nevent: change\ndata: \(change)\n\n") : fake.handler(r) }
        let store = WorkspaceStore(client: core.client(), timing: SyncTiming(debounce: 0.01, fallbackInterval: 100, backoff: Backoff(initial: 5, maximum: 5)))
        store.select("b1")
        store.start()
        try await waitUntil { store.sync != nil && core.recorded("/api/events").count == 1 }
        store.stop()
        let before = core.recorded("/api/events").count
        store.start()
        try await waitUntil { core.recorded("/api/events").count > before }
        XCTAssertNil(core.recorded("/api/events")[0].headers["Last-Event-ID"])
        XCTAssertEqual(core.recorded("/api/events")[before].headers["Last-Event-ID"], "7")
        store.stop()
    }

    func waitUntil(_ condition: @escaping @MainActor () -> Bool) async throws {
        for _ in 0..<200 { if condition() { return }; try await Task.sleep(for: .milliseconds(10)) }
        XCTFail("timeout")
    }
}

import XCTest
@testable import NexClientKit

@MainActor
final class SearchTests: XCTestCase {
    func makeStore(_ core: StubCore) -> WorkspaceStore {
        WorkspaceStore(client: core.client(), timing: SyncTiming(debounce: 0.01, fallbackInterval: 100, backoff: Backoff(initial: 0.01, maximum: 0.01)))
    }

    func hit(_ n: Int, bot: String = "b1") -> [String: Any] {
        ["id": "m\(n)", "botId": bot, "botName": "Bot \(bot)", "createdAt": 1_760_000_000_000 + n, "snippet": "…hit \(n)…"]
    }

    /// Search and feed with a log of old messages 1...200 for b1 and 1...5 for b2; `gone` makes `around` fail like a forgotten message.
    final class Fake: @unchecked Sendable {
        let lock = NSLock()
        var sync = syncJSON(), gone = false, pages: [[String: Any]] = []
        func handler(_ r: RecordedRequest) -> StubResponse {
            lock.withLock {
                let q = Dictionary(uniqueKeysWithValues: r.query.split(separator: "&").map { p -> (String, String) in
                    let kv = p.split(separator: "=", maxSplits: 1); return (String(kv[0]), kv.count > 1 ? String(kv[1]) : "")
                })
                switch r.path {
                case "/api/state": return .json(stateJSON(sync: sync, bots: ["b1", "b2"]))
                case "/api/agents/search": return pages.isEmpty ? .json(["error": "boom"], status: 500) : .json(pages.removeFirst())
                case "/api/agents/messages":
                    if q["around"] != nil {
                        if gone { return .json(["error": "该消息已不存在或已遗忘"], status: 400) }
                        return .json(feedJSON(Array(60...160), sync: sync))
                    }
                    return .json(feedJSON(Array(101...200), sync: sync))
                default: return .json(["ok": true])
                }
            }
        }
    }

    func page(_ ids: [Int], next: Int? = nil, sync: [String: Any] = syncJSON()) -> [String: Any] {
        ["results": ids.map { hit($0) }, "nextBefore": next.map { $0 as Any } ?? NSNull(), "sync": sync]
    }

    func testSearchRequestDecodingAndPaging() async throws {
        let core = StubCore(), fake = Fake(); core.handle(fake.handler)
        fake.pages = [page([30, 20], next: 20), page([10])]
        let store = makeStore(core); store.select("b1"); await store.refresh()
        let search = ConversationSearch(query: "  50%_x  ", workspace: store)
        XCTAssertEqual(search.query, "50%_x")
        await search.load(before: nil)
        XCTAssertEqual(search.results.map(\.id), ["m30", "m20"]); XCTAssertTrue(search.hasMore)
        XCTAssertEqual(search.results[0].botID, "b1"); XCTAssertEqual(search.results[0].snippet, "…hit 30…")
        XCTAssertEqual(search.results[0].createdAt, dateFromMilliseconds(1_760_000_000_030))
        await search.loadMore()
        XCTAssertEqual(search.results.map(\.id), ["m30", "m20", "m10"]); XCTAssertFalse(search.hasMore)
        let queries = core.recorded("/api/agents/search").map(\.query)
        XCTAssertEqual(queries, ["q=50%25_x", "q=50%25_x&before=20"])
    }

    func testEmptyResult() async throws {
        let core = StubCore(), fake = Fake(); core.handle(fake.handler)
        fake.pages = [page([])]
        let store = makeStore(core); store.select("b1"); await store.refresh()
        let search = ConversationSearch(query: "nothing", workspace: store)
        XCTAssertFalse(search.isEmpty)
        await search.load(before: nil)
        XCTAssertTrue(search.isEmpty)
    }

    func testFailureThenRetryKeepsLoadedPages() async throws {
        let core = StubCore(), fake = Fake(); core.handle(fake.handler)
        fake.pages = [page([30], next: 30)]
        let store = makeStore(core); store.select("b1"); await store.refresh()
        let search = ConversationSearch(query: "hit", workspace: store)
        await search.load(before: nil)
        await search.loadMore()
        XCTAssertEqual(search.error, "boom"); XCTAssertEqual(search.results.map(\.id), ["m30"]); XCTAssertTrue(search.hasMore)
        fake.lock.withLock { fake.pages = [page([10])] }
        await search.retry()
        XCTAssertNil(search.error); XCTAssertEqual(search.results.map(\.id), ["m30", "m10"])
        XCTAssertTrue(core.recorded("/api/agents/search").last!.query.hasSuffix("before=30"))
    }

    func testChangedGenerationDiscardsResults() async throws {
        let core = StubCore(), fake = Fake(); core.handle(fake.handler)
        fake.pages = [page([30], sync: syncJSON(epoch: 1))]
        let store = makeStore(core); store.select("b1"); await store.refresh()
        let search = ConversationSearch(query: "hit", workspace: store)
        await search.load(before: nil)
        XCTAssertEqual(search.error, "会话记录已变化，请重新搜索"); XCTAssertTrue(search.results.isEmpty); XCTAssertFalse(search.isEmpty)
    }

    func testOpenResultLoadsWindowAroundMessageAndSkipsReadReceipts() async throws {
        let core = StubCore(), fake = Fake(); core.handle(fake.handler)
        let store = makeStore(core); store.select("b2")
        store.conversation(for: "b2").isActive = true
        await store.refresh()
        store.openSearchResult(ConversationMatch(id: "m100", botID: "b1", botName: "Bot b1", snippet: ""))
        XCTAssertEqual(store.selectedBotID, "b1")
        await store.refresh(); try await Task.sleep(for: .milliseconds(50))
        let conv = store.conversation(for: "b1")
        XCTAssertEqual(conv.focusedMessageID, "m100"); XCTAssertEqual(conv.messages.first?.seq, 60); XCTAssertEqual(conv.messages.last?.seq, 160)
        XCTAssertTrue(core.recorded("/api/agents/messages").last!.query.contains("around=m100"))
        conv.isActive = true; await conv.markReadIfNeeded()
        XCTAssertFalse(core.recorded("/api/agents/read").contains { ($0.json["botId"] as? String) == "b1" })
        // Polling keeps the window, and the older-history button is off.
        await store.refresh()
        XCTAssertEqual(conv.messages.first?.seq, 60)
        await conv.loadOlder()
        XCTAssertFalse(core.recorded("/api/agents/messages").last!.query.contains("before="))
    }

    func testShowLatestReloadsLatestPage() async throws {
        let core = StubCore(), fake = Fake(); core.handle(fake.handler)
        let store = makeStore(core); store.select("b1"); await store.refresh()
        store.openSearchResult(ConversationMatch(id: "m100", botID: "b1", botName: "Bot b1", snippet: ""))
        await store.refresh()
        let conv = store.conversation(for: "b1")
        XCTAssertEqual(conv.messages.first?.seq, 60)
        store.showLatest(botID: "b1")
        XCTAssertNil(conv.focusedMessageID); XCTAssertTrue(conv.messages.isEmpty)
        await store.refresh()
        XCTAssertEqual(conv.messages.first?.seq, 101); XCTAssertEqual(conv.messages.last?.seq, 200); XCTAssertTrue(conv.hasOlder)
    }

    func testForgottenTargetFallsBackToLatest() async throws {
        let core = StubCore(), fake = Fake(); core.handle(fake.handler)
        fake.gone = true
        let store = makeStore(core); store.select("b1")
        store.openSearchResult(ConversationMatch(id: "m100", botID: "b1", botName: "Bot b1", snippet: ""))
        await store.refresh()
        let conv = store.conversation(for: "b1")
        XCTAssertNil(conv.focusedMessageID); XCTAssertEqual(conv.messages.first?.seq, 101); XCTAssertNil(store.notice)
    }

    func testSelectingContactAndSendingLeaveHistory() async throws {
        let core = StubCore(), fake = Fake(); core.handle(fake.handler)
        let store = makeStore(core); store.select("b1"); await store.refresh()
        let conv = store.conversation(for: "b1")

        store.openSearchResult(ConversationMatch(id: "m100", botID: "b1", botName: "Bot b1", snippet: ""))
        await store.refresh()
        store.select("b1")  // the open contact again
        XCTAssertNil(conv.focusedMessageID)
        await store.refresh()
        XCTAssertEqual(conv.messages.first?.seq, 101)

        store.openSearchResult(ConversationMatch(id: "m100", botID: "b1", botName: "Bot b1", snippet: ""))
        await store.refresh()
        store.select("b2")
        XCTAssertNil(conv.focusedMessageID); XCTAssertEqual(store.selectedBotID, "b2")

        store.openSearchResult(ConversationMatch(id: "m100", botID: "b1", botName: "Bot b1", snippet: ""))
        await store.refresh()
        XCTAssertEqual(conv.messages.first?.seq, 60)
        let sent = await conv.send(text: "hello")
        XCTAssertTrue(sent); XCTAssertNil(conv.focusedMessageID)
        XCTAssertEqual(conv.messages.first?.seq, 101)
    }
}

import XCTest
@testable import NexClientKit

final class NetworkingTests: XCTestCase {
    func parse(_ s: String, chunks: Int = 1) -> [SSEEvent] {
        var p = SSEParser(); var out: [SSEEvent] = []
        let bytes = Array(s.utf8), size = max(1, bytes.count / chunks)
        for start in stride(from: 0, to: bytes.count, by: size) { out += p.feed(bytes[start..<min(bytes.count, start + size)]) }
        return out
    }

    func testSSEParser() {
        XCTAssertEqual(parse("id: 5\nevent: change\ndata: {\"a\":1}\n\n"), [SSEEvent(id: "5", event: "change", data: "{\"a\":1}")])
        XCTAssertEqual(parse("data: a\ndata: b\n\n").first?.data, "a\nb")
        XCTAssertEqual(parse(": comment\ndata:x\n\n").first?.data, "x")
        XCTAssertEqual(parse("data: a\r\n\r\ndata: b\r\rdata: c\n\n").map(\.data), ["a", "b", "c"])
        XCTAssertEqual(parse("event: change\n\n").count, 0, "no data, no dispatch")
        XCTAssertEqual(parse("data: x\n\n").first?.event, "message")
        XCTAssertEqual(parse("id: 1\ndata: a\n\ndata: b\n\n").map(\.id), ["1", "1"], "last event id persists")
        XCTAssertEqual(parse("id: 9\nevent: revoked\ndata: {}\n\n", chunks: 7).first, SSEEvent(id: "9", event: "revoked", data: "{}"))
        XCTAssertEqual(parse("data: 你好\n\n", chunks: 5).first?.data, "你好")
        var p = SSEParser(); _ = p.feed(Array("retry: 3000\nfoo: bar\nid: 4\n\n".utf8))
        XCTAssertEqual(p.retry, 3000); XCTAssertEqual(p.lastEventID, "4")
    }

    func testBackoff() {
        let b = Backoff()
        XCTAssertEqual((0..<8).map(b.delay), [0.5, 1, 2, 4, 8, 15, 15, 15])
    }

    func testClientHeadersAndErrors() async throws {
        let core = StubCore()
        core.handle { r in r.path == "/api/state" ? .json(stateJSON()) : .json(["error": "无权限", "code": "identity_unavailable"], status: 503) }
        let client = core.client(token: "secret")
        _ = try await client.state()
        let req = core.recorded("/api/state")[0]
        XCTAssertEqual(req.headers["Authorization"], "Bearer secret")
        XCTAssertNil(req.headers["Cookie"]); XCTAssertNil(req.headers["Origin"])
        do { try await client.cancel(task: "t"); XCTFail() } catch let e as CoreError {
            XCTAssertEqual(e.status, 503); XCTAssertEqual(e.code, "identity_unavailable"); XCTAssertEqual(e.message, "无权限"); XCTAssertTrue(e.endsSession)
        }
        XCTAssertEqual(core.recorded("/api/cancel")[0].json["taskId"] as? String, "t")
    }

    func testRedirectsAreRefused() async throws {
        let core = StubCore()
        core.handle { _ in StubResponse(status: 302, headers: ["Location": "https://evil.test/"]) }
        do { _ = try await core.client().identity(); XCTFail() } catch let e as CoreError { XCTAssertEqual(e.kind, .http); XCTAssertEqual(e.status, 302) }
    }

    func testFeedQuery() async throws {
        let core = StubCore()
        core.handle { _ in .json(feedJSON([1])) }
        _ = try await core.client().feed(bot: "a b&c", before: 10)
        _ = try await core.client().feed(bot: "x", after: 3)
        let q = core.recorded("/api/agents/messages").map(\.query)
        XCTAssertEqual(q, ["bot=a%20b%26c&before=10", "bot=x&after=3"])
    }

    func testEventStreamReconnectSendsLastEventID() async throws {
        let core = StubCore()
        let change = #"{"cursor":7,"privacyEpoch":0,"coreId":"core-1","bootId":"boot-1","reset":false}"#
        core.handle { r in
            let n = core.recorded("/api/events").count
            return .text(n == 1 ? "id: 7\nevent: change\ndata: \(change)\n\n" : "id: 8\nevent: change\ndata: \(change)\n\n")
        }
        let stream = EventStream(client: core.client(), backoff: Backoff(initial: 0.001, maximum: 0.001), sleep: { _ in try await Task.sleep(for: .milliseconds(1)) })
        var changes = 0, disconnects = 0
        for await e in stream.events() {
            switch e { case .event: changes += 1; case .disconnected: disconnects += 1; default: break }
            if changes == 2 { break }
        }
        let reqs = core.recorded("/api/events")
        XCTAssertGreaterThanOrEqual(reqs.count, 2)
        XCTAssertNil(reqs[0].headers["Last-Event-ID"])
        XCTAssertEqual(reqs[1].headers["Last-Event-ID"], "7")
        XCTAssertEqual(reqs[0].headers["Accept"], "text/event-stream")
        XCTAssertGreaterThanOrEqual(disconnects, 1)
    }

    func testEventStreamStopsOnUnauthorized() async throws {
        let core = StubCore()
        core.handle { _ in .json(["error": "Unauthorized"], status: 401) }
        var failed: CoreError?
        for await e in EventStream(client: core.client()).events() { if case .failed(let err) = e { failed = err } }
        XCTAssertEqual(failed?.status, 401)
        XCTAssertEqual(core.recorded("/api/events").count, 1)
    }
}

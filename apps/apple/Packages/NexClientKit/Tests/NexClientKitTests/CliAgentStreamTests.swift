import XCTest
@testable import NexClientKit

// The WebSocket client, the terminal controller and the Agent model, on a fake socket and a stub Core.

final class FakeSocket: CliSocket, @unchecked Sendable {
    private let lock = NSLock()
    private var sentMessages: [CliSocketMessage] = []
    private var queue: [Result<CliSocketMessage, Error>] = []
    private var waiter: CheckedContinuation<CliSocketMessage, Error>?
    private var dead = false
    private var code = 0
    private var cancelledFlag = false
    let failOpen: Bool

    init(failOpen: Bool = false) { self.failOpen = failOpen }

    func resume() {}
    func opened() async throws { if failOpen { throw URLError(.cannotConnectToHost) } }
    func send(_ message: CliSocketMessage) { lock.withLock { sentMessages.append(message) } }

    func receive() async throws -> CliSocketMessage {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<CliSocketMessage, Error>) in
            lock.lock()
            if !queue.isEmpty { let r = queue.removeFirst(); lock.unlock(); c.resume(with: r) }
            else if dead { lock.unlock(); c.resume(throwing: URLError(.networkConnectionLost)) }
            else { waiter = c; lock.unlock() }
        }
    }

    func cancel() { lock.withLock { cancelledFlag = true }; finish(code: nil) }
    var closeCode: Int { lock.withLock { code } }
    var cancelled: Bool { lock.withLock { cancelledFlag } }

    private func deliver(_ result: Result<CliSocketMessage, Error>) {
        lock.lock()
        if let w = waiter { waiter = nil; lock.unlock(); w.resume(with: result) } else { queue.append(result); lock.unlock() }
    }

    /// The server sends a message.
    func push(_ object: [String: Any]) { deliver(.success(.text(String(data: try! JSONSerialization.data(withJSONObject: object), encoding: .utf8)!))) }
    func push(frame: CliFrame) { deliver(.success(.data(frame.encode()))) }
    /// The connection drops with `code`.
    func finish(code: Int?) {
        lock.lock()
        if let code { self.code = code }
        let already = dead
        dead = true
        let w = waiter; waiter = nil
        lock.unlock()
        if !already, let w { w.resume(throwing: URLError(.networkConnectionLost)) }
    }

    var sent: [CliSocketMessage] { lock.withLock { sentMessages } }
    /// The JSON messages sent, as dictionaries.
    var sentJSON: [[String: Any]] {
        sent.compactMap { if case .text(let s) = $0 { return (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] } else { return nil } }
    }
    func sentTypes() -> [String] { sentJSON.compactMap { $0["type"] as? String } }
    var sentFrames: [CliFrame] { sent.compactMap { if case .data(let d) = $0 { return CliFrame.decode(d) } else { return nil } } }
}

/// A sleeper the test releases by hand. Ping sleeps and reconnect waits have separate tokens.
actor SleepGate {
    private(set) var requested: [Double] = []
    private var reconnectTokens = 0, pingTokens = 0
    func sleep(_ seconds: Double) async throws {
        requested.append(seconds)
        let ping = seconds == CliAgentStream.pingInterval
        while ping ? pingTokens == 0 : reconnectTokens == 0 { try await Task.sleep(for: .milliseconds(2)) }
        if ping { pingTokens -= 1 } else { reconnectTokens -= 1 }
    }
    func releaseReconnect() { reconnectTokens += 1 }
    func releasePing() { pingTokens += 1 }
    func reconnectWaits() -> [Double] { requested.filter { $0 != CliAgentStream.pingInterval } }
}

final class SocketSupply: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [FakeSocket]
    private(set) var made: [FakeSocket] = []
    private(set) var requests: [URLRequest] = []
    init(_ sockets: [FakeSocket]) { pending = sockets }
    func next(_ request: URLRequest) -> FakeSocket {
        lock.withLock {
            requests.append(request)
            let s = pending.isEmpty ? FakeSocket() : pending.removeFirst()
            made.append(s)
            return s
        }
    }
    var count: Int { lock.withLock { made.count } }
    subscript(i: Int) -> FakeSocket { lock.withLock { made[i] } }
}

actor EventLog {
    private(set) var events: [CliAgentStream.Event] = []
    func add(_ e: CliAgentStream.Event) { events.append(e) }
    var statuses: [CliAgentStream.Status] { events.compactMap { if case .status(let s) = $0 { return s } else { return nil } } }
    var messages: [CliServerMessage] { events.compactMap { if case .message(let m) = $0 { return m } else { return nil } } }
    var outputs: [(UInt32, Data)] { events.compactMap { if case .output(let s, let d) = $0 { return (s, d) } else { return nil } } }
}

/// Polls `condition` on the caller's actor until it holds.
func eventually(timeout: Double = 3, isolation: isolated (any Actor)? = #isolation, _ condition: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline { if await condition() { return }; try? await Task.sleep(for: .milliseconds(5)) }
    XCTFail("condition not met in time", file: file, line: line)
}

final class CliAgentStreamTests: XCTestCase {
    let url = URLRequest(url: URL(string: "wss://core.test/api/cli-agents/stream")!)

    func makeStream(_ sockets: [FakeSocket], gate: SleepGate = SleepGate(), now: @escaping @Sendable () -> Double = { 1000 }) -> (CliAgentStream, SocketSupply, SleepGate, EventLog) {
        let supply = SocketSupply(sockets)
        let request = url
        let stream = CliAgentStream(requestProvider: { request }, makeSocket: { supply.next($0) }, sleep: { try await gate.sleep($0) }, random: { 0 }, now: now)
        let log = EventLog()
        Task { for await e in stream.events { await log.add(e) } }
        return (stream, supply, gate, log)
    }

    func testReconnectDelay() {
        XCTAssertEqual((0..<8).map { CliAgentStream.reconnectDelay(attempt: $0, random: 0) }, [1, 2, 4, 8, 16, 30, 30, 30])
        XCTAssertEqual(CliAgentStream.reconnectDelay(attempt: 0, random: 1), 1.25)
        XCTAssertEqual(CliAgentStream.reconnectDelay(attempt: 4, random: 0.5), 18)
        XCTAssertEqual(CliAgentStream.reconnectDelay(attempt: 99, random: 1), 30)
    }

    func testOpensAndSubscribes() async {
        let socket = FakeSocket()
        let (stream, supply, _, log) = makeStream([socket])
        await stream.subscribeList()
        await stream.subscribeSession("k1")
        await stream.start()
        await eventually { await stream.currentStatus() == .open }
        let statuses = await log.statuses
        XCTAssertEqual(statuses, [.connecting, .open])
        XCTAssertEqual(supply.requests.count, 1)
        XCTAssertEqual(socket.sentTypes().sorted(), ["sub.list", "sub.session"], "subscriptions made before the socket opened go out on open")
        await stream.subscribeSession("k1")
        await stream.subscribeSession("k2")
        XCTAssertEqual(socket.sentTypes().filter { $0 == "sub.session" }.count, 2, "k1 again does not send twice")
        await stream.unsubscribeSession("k1")
        XCTAssertFalse(socket.sentTypes().contains("unsub.session"), "still one subscriber left")
        await stream.unsubscribeSession("k1")
        XCTAssertEqual(socket.sentJSON.last?["type"] as? String, "unsub.session")
        XCTAssertEqual(socket.sentJSON.last?["key"] as? String, "k1")
        await stream.stop()
        XCTAssertTrue(socket.cancelled)
        let idle = await stream.currentStatus()
        XCTAssertEqual(idle, .idle)
    }

    func testReconnectsAndResubscribes() async {
        let first = FakeSocket(), second = FakeSocket()
        let (stream, supply, gate, log) = makeStream([first, second])
        await stream.subscribeList()
        await stream.subscribeSession("k1")
        await stream.start()
        await eventually { await stream.currentStatus() == .open }
        first.finish(code: 1006)
        await eventually { await stream.currentStatus() == .reconnecting }
        await eventually { await gate.reconnectWaits().count == 1 }
        let firstWait = await gate.reconnectWaits()
        XCTAssertEqual(firstWait, [1.0])
        XCTAssertEqual(supply.count, 1, "waits before the next attempt")
        await gate.releaseReconnect()
        await eventually { await stream.currentStatus() == .open }
        XCTAssertEqual(supply.count, 2)
        XCTAssertEqual(second.sentTypes().sorted(), ["sub.list", "sub.session"], "subscriptions come back")
        let statuses = await log.statuses
        XCTAssertEqual(statuses, [.connecting, .open, .reconnecting, .open])
        await stream.stop()
    }

    func testBackoffGrowsUntilAMessageArrives() async {
        let a = FakeSocket(failOpen: true), b = FakeSocket(failOpen: true), c = FakeSocket()
        let (stream, _, gate, _) = makeStream([a, b, c])
        await stream.start()
        await eventually { await gate.reconnectWaits().count == 1 }
        await gate.releaseReconnect()
        await eventually { await gate.reconnectWaits().count == 2 }
        await gate.releaseReconnect()
        await eventually { await stream.currentStatus() == .open }
        let waits = await gate.reconnectWaits()
        XCTAssertEqual(waits, [1, 2])
        c.push(["type": "pong"])
        c.finish(code: 1006)
        await eventually { await gate.reconnectWaits().count == 3 }
        let after = await gate.reconnectWaits()
        XCTAssertEqual(after.last, 1, "a received message resets the counter")
        await stream.stop()
    }

    func testUnauthorizedStopsReconnecting() async {
        let socket = FakeSocket()
        let (stream, supply, gate, _) = makeStream([socket])
        await stream.start()
        await eventually { await stream.currentStatus() == .open }
        socket.finish(code: 4401)
        await eventually { await stream.currentStatus() == .closed(code: 4401) }
        await gate.releaseReconnect()
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(supply.count, 1, "no reconnect after 4401")
        let waits = await gate.reconnectWaits()
        XCTAssertTrue(waits.isEmpty)
        await stream.start()
        await eventually { await stream.currentStatus() == .open }
        XCTAssertEqual(supply.count, 2, "start tries again")
        await stream.stop()
    }

    func testMessagesAndOutput() async {
        let socket = FakeSocket()
        let (stream, _, _, log) = makeStream([socket])
        await stream.start()
        await eventually { await stream.currentStatus() == .open }
        socket.push(["type": "pong"])
        socket.push(["type": "mystery"])
        socket.push(["type": "summary", "waiting": 2, "running": 1])
        socket.push(frame: .output(sid: 3, payload: Data("hi".utf8)))
        socket.push(frame: .input(sid: 3, payload: Data("ignored".utf8)))
        await eventually { await log.outputs.count == 1 }
        let messages = await log.messages
        XCTAssertEqual(messages.count, 1, "pong and unknown messages are swallowed")
        if case .summary(let waiting, let running)? = messages.first { XCTAssertEqual([waiting, running], [2, 1]) } else { XCTFail("summary") }
        let outputs = await log.outputs
        XCTAssertEqual(outputs.first?.0, 3)
        XCTAssertEqual(outputs.first?.1, Data("hi".utf8))
        await stream.stop()
    }

    func testAbandonedTerminalRequestIsClosed() async {
        let socket = FakeSocket()
        let (stream, _, _, log) = makeStream([socket])
        await stream.start()
        await eventually { await stream.currentStatus() == .open }
        let sent = await stream.openTerminal(req: "r1", key: "k", cols: 1000, rows: 1, observe: true)
        XCTAssertTrue(sent)
        let open = socket.sentJSON.last
        XCTAssertEqual(open?["type"] as? String, "term.open")
        XCTAssertEqual(open?["cols"] as? Int, 500, "size is clamped"); XCTAssertEqual(open?["rows"] as? Int, 5)
        XCTAssertEqual(open?["observe"] as? Bool, true)
        await stream.abandonTerminal(req: "r1")
        socket.push(["type": "term.opened", "req": "r1", "sid": 5, "cols": 100, "rows": 30, "observe": true])
        await eventually { socket.sentTypes().contains("term.close") }
        XCTAssertEqual(socket.sentJSON.last?["sid"] as? Int, 5)
        _ = await stream.openTerminal(req: "r2", key: "k", cols: 100, rows: 30, observe: false)
        socket.push(["type": "term.opened", "req": "r2", "sid": 6, "cols": 100, "rows": 30, "observe": false])
        await eventually { await log.messages.count == 1 }
        if case .termOpened(let req, let sid, _, _, _)? = await log.messages.first { XCTAssertEqual(req, "r2"); XCTAssertEqual(sid, 6) } else { XCTFail("opened") }
        await stream.stop()
    }

    func testTerminalCommands() async {
        let socket = FakeSocket()
        let (stream, _, _, _) = makeStream([socket])
        let early = await stream.sendInput(sid: 1, Data("x".utf8))
        XCTAssertFalse(early, "not open yet")
        await stream.start()
        await eventually { await stream.currentStatus() == .open }
        await stream.resizeTerminal(sid: 4, cols: 3, rows: 900)
        await stream.grantCredit(sid: 4, bytes: 32768)
        await stream.closeTerminal(sid: 4)
        let json = socket.sentJSON
        XCTAssertEqual(json[0]["type"] as? String, "term.resize")
        XCTAssertEqual(json[0]["cols"] as? Int, 20); XCTAssertEqual(json[0]["rows"] as? Int, 200)
        XCTAssertEqual(json[1]["bytes"] as? Int, 32768)
        XCTAssertEqual(json[2]["type"] as? String, "term.close")
        let ok = await stream.sendInput(sid: 4, Data(count: CliFrame.payloadMax + 1))
        XCTAssertTrue(ok)
        XCTAssertEqual(socket.sentFrames.map { if case .input(_, let p) = $0 { p.count } else { -1 } }, [CliFrame.payloadMax, 1])
        await stream.stop()
    }

    func testPingAndSilenceTimeout() async {
        let first = FakeSocket(), second = FakeSocket()
        let clock = Clock()
        let (stream, supply, gate, _) = makeStream([first, second], now: { clock.value })
        await stream.start()
        await eventually { await stream.currentStatus() == .open }
        await gate.releasePing()
        await eventually { first.sentTypes().contains("ping") }
        clock.value += 46
        await gate.releasePing()
        await eventually { first.cancelled }
        await eventually { await gate.reconnectWaits().count == 1 }
        await gate.releaseReconnect()
        await eventually { supply.count == 2 }
        await stream.stop()
    }

    func testReconnectNowSkipsTheWait() async {
        let first = FakeSocket(), second = FakeSocket()
        let (stream, supply, gate, _) = makeStream([first, second])
        await stream.start()
        await eventually { await stream.currentStatus() == .open }
        first.finish(code: 1006)
        await eventually { await gate.reconnectWaits().count == 1 }
        await stream.reconnectNow()
        await eventually { await stream.currentStatus() == .open }
        XCTAssertEqual(supply.count, 2)
        await stream.stop()
    }

    func testNoTokenCloses() async {
        let stream = CliAgentStream(requestProvider: { nil }, makeSocket: { _ in FakeSocket() })
        await stream.start()
        await eventually { await stream.currentStatus() == .closed(code: 4401) }
    }
}

final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var v = 1000.0
    var value: Double { get { lock.withLock { v } } set { lock.withLock { v = newValue } } }
}

// MARK: Terminal state machine

final class CliTermStateTests: XCTestCase {
    func opened(_ s: inout CliTermState, observe: Bool = true) {
        s.apply(.start(nil)); s.apply(.requested("r")); s.apply(.opened(req: "r", sid: 9, cols: 100, rows: 30, observe: observe))
    }

    func testOpenFlow() {
        var s = CliTermState()
        XCTAssertEqual(s.status(connected: true), .connecting)
        s.apply(.start(nil))
        XCTAssertTrue(s.needsOpen)
        s.apply(.requested("r1"))
        XCTAssertFalse(s.needsOpen)
        s.apply(.opened(req: "other", sid: 1, cols: 1, rows: 1, observe: true))
        XCTAssertNil(s.sid, "an answer to another request is ignored")
        s.apply(.opened(req: "r1", sid: 9, cols: 100, rows: 30, observe: true))
        XCTAssertEqual(s.phase, .observing); XCTAssertEqual(s.status(connected: true), .observing); XCTAssertEqual([s.cols, s.rows], [100, 30])
        s.apply(.size(sid: 8, cols: 1, rows: 1)); XCTAssertEqual(s.cols, 100)
        s.apply(.size(sid: 9, cols: 90, rows: 20)); XCTAssertEqual([s.cols, s.rows], [90, 20])
    }

    func testCloseReasons() {
        var s = CliTermState(); opened(&s)
        s.apply(.closed(sid: 9, reason: "overflow"))
        XCTAssertEqual(s.phase, .reconnecting); XCTAssertTrue(s.needsOpen)
        var t = CliTermState(); opened(&t)
        t.apply(.closed(sid: 1, reason: "exited")); XCTAssertEqual(t.phase, .observing, "another terminal's close is ignored")
        t.apply(.closed(sid: 9, reason: "exited"))
        XCTAssertEqual(t.phase, .closed); XCTAssertEqual(t.status(connected: true), .closed); XCTAssertEqual(CliTermState.closeReasonText(t.reason), "程序已退出")
        XCTAssertEqual(CliTermState.closeReasonText("device_offline"), "电脑离线")
        XCTAssertEqual(CliTermState.closeReasonText("paused"), "本机控制已暂停")
        XCTAssertEqual(CliTermState.closeReasonText("disabled"), "Agent 会话已关闭")
        XCTAssertEqual(CliTermState.closeReasonText("closed"), "已关闭")
        XCTAssertEqual(CliTermState.closeReasonText("weird"), "终端已断开")
    }

    func testErrorAndDisconnect() {
        var s = CliTermState(); s.apply(.start(nil)); s.apply(.requested("r"))
        s.apply(.error(code: "busy", req: "x")); XCTAssertEqual(s.phase, .idle, "an error of another request is ignored")
        s.apply(.error(code: "read_only", req: "r"))
        XCTAssertEqual(s.phase, .closed); XCTAssertEqual(s.errorCode, "read_only")
        var idle = CliTermState(); idle.apply(.disconnected); XCTAssertEqual(idle.phase, .idle, "nothing to lose")
        var live = CliTermState(); opened(&live)
        live.apply(.disconnected)
        XCTAssertEqual(live.phase, .reconnecting); XCTAssertTrue(live.needsOpen); XCTAssertNil(live.sid)
        XCTAssertEqual(live.status(connected: false), .reconnecting)
        XCTAssertEqual(CliTermStatus.reconnecting.text, "正在重新连接")
        XCTAssertEqual(CliTermStatus.observing.text, "只看"); XCTAssertEqual(CliTermStatus.controlling.text, "操作中"); XCTAssertEqual(CliTermStatus.closed.text, "已结束")
    }

    func testModeChangeReopens() {
        var s = CliTermState(); opened(&s)
        s.apply(.mode(.control))
        XCTAssertEqual(s.want, .control); XCTAssertTrue(s.needsOpen); XCTAssertNil(s.sid)
        s.apply(.requested("r2")); s.apply(.opened(req: "r2", sid: 10, cols: 80, rows: 24, observe: false))
        XCTAssertEqual(s.phase, .controlling); XCTAssertEqual(s.mode, .control)
    }

    func testSizeAndCredit() {
        XCTAssertEqual(CliTermState.clampSize(cols: nil, rows: nil).cols, 120)
        XCTAssertEqual(CliTermState.clampSize(cols: nil, rows: nil).rows, 36)
        XCTAssertEqual(CliTermState.clampSize(cols: 5, rows: 1000).cols, 20)
        XCTAssertEqual(CliTermState.clampSize(cols: 5, rows: 1000).rows, 200)
        var meter = CliCreditMeter()
        XCTAssertNil(meter.wrote(30_000))
        XCTAssertEqual(meter.wrote(3_000), 33_000, "credit goes back once a chunk is drawn")
        XCTAssertNil(meter.wrote(10))
    }
}

// MARK: Terminal controller

@MainActor
final class CliTerminalControllerTests: XCTestCase {
    func setUp(_ socket: FakeSocket) async -> (CliAgentStream, CliTerminalController) {
        let supply = SocketSupply([socket])
        let stream = CliAgentStream(requestProvider: { URLRequest(url: URL(string: "wss://core.test/x")!) }, makeSocket: { supply.next($0) },
                                    sleep: { try await SleepGate().sleep($0) }, random: { 0 })
        await stream.start()
        await eventually { await stream.currentStatus() == .open }
        return (stream, CliTerminalController(stream: stream, key: "k", connected: true, resizeDelay: 0.01))
    }

    func sentReq(_ socket: FakeSocket, nth: Int = 0) -> String? {
        socket.sentJSON.filter { $0["type"] as? String == "term.open" }[safe: nth]?["req"] as? String
    }

    func testObserveFlow() async {
        let socket = FakeSocket()
        let (stream, controller) = await setUp(socket)
        var opened: (Int, Int)?; var output = Data(); var resized: (Int, Int)?
        controller.onOpened = { opened = ($0, $1) }
        controller.onOutput = { output.append($0) }
        controller.onResize = { resized = ($0, $1) }
        controller.begin()
        await eventually { socket.sentTypes().contains("term.open") }
        let first = socket.sentJSON.first { $0["type"] as? String == "term.open" }!
        XCTAssertEqual(first["observe"] as? Bool, true); XCTAssertEqual(first["cols"] as? Int, 120); XCTAssertEqual(first["rows"] as? Int, 36)
        let req = sentReq(socket)!
        controller.handle(.message(.termOpened(req: req, sid: 7, cols: 100, rows: 30, observe: true)))
        XCTAssertEqual(controller.status, .observing)
        XCTAssertEqual(opened?.0, 100)
        controller.handle(.output(sid: 7, data: Data("abc".utf8)))
        controller.handle(.output(sid: 8, data: Data("zzz".utf8)))
        XCTAssertEqual(output, Data("abc".utf8), "only this terminal's output")
        controller.handle(.output(sid: 7, data: Data(count: 33_000)))
        await eventually { socket.sentTypes().contains("term.credit") }
        XCTAssertEqual(socket.sentJSON.last?["bytes"] as? Int, 33_003)
        controller.handle(.message(.termSize(sid: 7, cols: 90, rows: 20)))
        XCTAssertEqual(resized?.0, 90)
        controller.sendInput(Data("x".utf8))
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertTrue(socket.sentFrames.isEmpty, "keystrokes are dropped when only watching")
        await stream.stop()
    }

    func testReconnectOpensAgain() async {
        let socket = FakeSocket()
        let (stream, controller) = await setUp(socket)
        controller.begin()
        await eventually { sentReq(socket) != nil }
        controller.handle(.message(.termOpened(req: sentReq(socket)!, sid: 7, cols: 100, rows: 30, observe: true)))
        controller.handle(.status(.reconnecting))
        XCTAssertEqual(controller.status, .reconnecting)
        controller.handle(.status(.open))
        await eventually { sentReq(socket, nth: 1) != nil }
        controller.handle(.message(.termClosed(sid: 7, reason: "overflow")))
        XCTAssertEqual(controller.status, .reconnecting, "a closed terminal that is not current is ignored")
        controller.handle(.message(.termOpened(req: sentReq(socket, nth: 1)!, sid: 8, cols: 100, rows: 30, observe: true)))
        controller.handle(.message(.termClosed(sid: 8, reason: "exited")))
        XCTAssertEqual(controller.status, .closed)
        controller.reconnect()
        await eventually { sentReq(socket, nth: 2) != nil }
        controller.handle(.message(.error(code: "read_only", req: sentReq(socket, nth: 2), message: nil)))
        XCTAssertEqual(controller.state.errorCode, "read_only")
        await stream.stop()
    }

    func testControlMode() async {
        let socket = FakeSocket()
        let (stream, controller) = await setUp(socket)
        controller.begin()
        await eventually { sentReq(socket) != nil }
        controller.handle(.message(.termOpened(req: sentReq(socket)!, sid: 7, cols: 100, rows: 30, observe: true)))
        controller.setMode(.control)
        await eventually { sentReq(socket, nth: 1) != nil }
        XCTAssertTrue(socket.sentTypes().contains("term.close"), "the watching terminal is closed first")
        let control = socket.sentJSON.filter { $0["type"] as? String == "term.open" }[1]
        XCTAssertEqual(control["observe"] as? Bool, false)
        controller.viewResized(cols: 140, rows: 50)
        controller.handle(.message(.termOpened(req: sentReq(socket, nth: 1)!, sid: 8, cols: 100, rows: 30, observe: false)))
        XCTAssertEqual(controller.status, .controlling)
        await eventually { socket.sentTypes().contains("term.resize") }
        let resize = socket.sentJSON.last { $0["type"] as? String == "term.resize" }
        XCTAssertEqual(resize?["cols"] as? Int, 140); XCTAssertEqual(resize?["sid"] as? Int, 8)
        controller.sendInput(Data("a".utf8)); controller.sendInput(Data("b".utf8)); controller.sendInput(Data("c".utf8))
        await eventually { socket.sentFrames.count == 3 }
        XCTAssertEqual(socket.sentFrames, ["a", "b", "c"].map { CliFrame.input(sid: 8, payload: Data($0.utf8)) }, "in typing order")
        controller.stop()
        await eventually { socket.sentJSON.contains { $0["type"] as? String == "term.close" && $0["sid"] as? Int == 8 } }
        await stream.stop()
    }
}

extension Array { subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil } }

// MARK: Model

@MainActor
final class CliAgentsModelTests: XCTestCase {
    final class Notes: CliNotifying {
        var sent: [(title: String, body: String, key: String)] = []
        func notify(title: String, body: String, key: CliSessionKey) { sent.append((title, body, key)) }
    }

    struct Rig {
        let model: CliAgentsModel, core: StubCore, socket: FakeSocket, notes: Notes
    }

    func rig(snapshot: @escaping @Sendable (RecordedRequest) -> StubResponse = { _ in .json(["devices": [], "sessions": [], "requests": []]) }) async -> Rig {
        let core = StubCore()
        core.handle { r in r.path == "/api/cli-agents" ? snapshot(r) : .json(["items": [], "more": false, "requests": []]) }
        let socket = FakeSocket()
        let supply = SocketSupply([socket])
        let defaults = UserDefaults(suiteName: "cli-test-\(UUID().uuidString)")!
        let client = core.client()
        let model = CliAgentsModel(client: { client }, defaults: defaults, streamFactory: { _ in
            CliAgentStream(requestProvider: { URLRequest(url: URL(string: "wss://core.test/x")!) }, makeSocket: { supply.next($0) },
                           sleep: { try await SleepGate().sleep($0) }, random: { 0 })
        })
        let notes = Notes()
        model.notifier = notes
        model.start()
        await eventually { await model.stream?.currentStatus() == .open }
        await eventually { model.link == .open }
        return Rig(model: model, core: core, socket: socket, notes: notes)
    }

    func listMessage(_ sessions: [[String: Any]]) -> [String: Any] {
        ["type": "list", "devices": [["id": "d1", "name": "办公室", "online": true]], "sessions": sessions]
    }

    func testSnapshotThenPushedList() async {
        let r = await rig { _ in .json(["devices": [["id": "d1", "name": "办公室", "online": true]], "sessions": [cliSessionJSON()], "requests": []]) }
        await eventually { r.model.loaded }
        XCTAssertEqual(r.model.sessions.map(\.key), ["d1:claude:s1"])
        XCTAssertTrue(r.socket.sentTypes().contains("sub.list"))
        r.socket.push(listMessage([cliSessionJSON("d1:claude:s2")]))
        await eventually { r.model.sessions.map(\.key) == ["d1:claude:s2"] }
        r.socket.push(["type": "list.delta", "upserts": [cliSessionJSON("d1:claude:s3", state: "running")], "removes": ["d1:claude:s2"]])
        await eventually { r.model.sessions.map(\.key) == ["d1:claude:s3"] }
        XCTAssertEqual(r.model.groups.first?.folders.first?.sessions.first?.state, .running)
        r.model.stop()
    }

    func testLateSnapshotLosesToPushedList() async {
        let r = await rig { _ in .json(["devices": [], "sessions": [cliSessionJSON("old")], "requests": []], delay: 0.3) }
        r.socket.push(listMessage([cliSessionJSON("pushed")]))
        await eventually { r.model.sessions.map(\.key) == ["pushed"] }
        try? await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(r.model.sessions.map(\.key), ["pushed"], "the HTTP answer that was on its way is ignored")
        r.model.stop()
    }

    func testRequestsFlowAndAnswer() async {
        let r = await rig()
        r.socket.push(listMessage([cliSessionJSON(state: "running")]))
        await eventually { !r.model.sessions.isEmpty }
        let request: [String: Any] = ["id": "r1", "key": "d1:claude:s1", "kind": "permission", "tool": "Bash", "summary": "ls", "createdAt": 1, "expiresAt": CliAgentsModel.currentMs() + 60_000]
        r.socket.push(["type": "requests", "key": "d1:claude:s1", "requests": [request]])
        await eventually { r.model.pendingCounts["d1:claude:s1"] == 1 }
        XCTAssertEqual(r.model.selected, nil)
        XCTAssertEqual(r.model.displaySessions.first?.state, .waiting, "holding a request reads as waiting")
        XCTAssertEqual(r.model.waitingCount, 1)
        r.core.handle { $0.path == "/api/cli-agents/answer" ? .json(["outcome": "delivered"]) : .json([:]) }
        let view = r.model.cards("d1:claude:s1")[0].view
        try? await r.model.answer(view, decision: .allow)
        XCTAssertEqual(r.model.cardState(r.model.cards("d1:claude:s1")[0]), .allowed)
        XCTAssertEqual(r.model.pendingCounts["d1:claude:s1"], nil)
        r.socket.push(["type": "request.resolved", "key": "d1:claude:s1", "id": "r1", "by": "terminal"])
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(r.model.cardState(r.model.cards("d1:claude:s1")[0]), .allowed, "a closed card stays as it was answered")
        r.model.stop()
    }

    func testAnswerFailureKeepsTheCardOpen() async {
        let r = await rig()
        r.socket.push(listMessage([cliSessionJSON()]))
        let request: [String: Any] = ["id": "r1", "key": "d1:claude:s1", "kind": "permission", "tool": "T", "summary": "s", "createdAt": 1, "expiresAt": CliAgentsModel.currentMs() + 60_000]
        r.socket.push(["type": "requests", "key": "d1:claude:s1", "requests": [request]])
        await eventually { r.model.pendingCounts["d1:claude:s1"] == 1 }
        r.core.handle { _ in .json(["error": "x", "code": "not_found"], status: 404) }
        do { try await r.model.answer(r.model.cards("d1:claude:s1")[0].view, decision: .deny); XCTFail("expected failure") } catch {
            XCTAssertEqual(CliAgentsModel.answerErrorText(error), "请求已处理或已过期")
        }
        XCTAssertEqual(r.model.pendingCounts["d1:claude:s1"], 1)
        r.model.stop()
    }

    func testListDropsOpenRequestsOfAFreshSubscription() async {
        let r = await rig()
        r.socket.push(listMessage([cliSessionJSON()]))
        let request: [String: Any] = ["id": "r1", "key": "d1:claude:s1", "kind": "permission", "tool": "T", "summary": "s", "createdAt": 1, "expiresAt": CliAgentsModel.currentMs() + 60_000]
        r.socket.push(["type": "requests", "key": "d1:claude:s1", "requests": [request]])
        await eventually { r.model.pendingCounts["d1:claude:s1"] == 1 }
        r.socket.push(listMessage([cliSessionJSON()]))
        await eventually { r.model.pendingCounts.isEmpty }
        r.model.stop()
    }

    func testTranscriptSubscriptionAndPaging() async {
        let r = await rig()
        r.core.handle { req in
            switch req.path {
            case "/api/cli-agents/items" where req.query.contains("before="): return .json(["items": [["id": "0", "ts": 0, "kind": "assistant", "text": "older"]], "more": false])
            case "/api/cli-agents/items": return .json(["items": [["id": "1", "ts": 1, "kind": "user", "text": "hi"]], "more": true])
            case "/api/cli-agents/requests": return .json(["requests": []])
            default: return .json(["devices": [], "sessions": [], "requests": []])
            }
        }
        r.model.openSession("k")
        await eventually { r.model.transcript("k").loaded }
        XCTAssertTrue(r.socket.sentJSON.contains { $0["type"] as? String == "sub.session" && $0["key"] as? String == "k" })
        // one user turn on the first page and more before it: the earlier page loads on its own
        await eventually { r.model.transcript("k").items.map(\.id) == ["0", "1"] }
        XCTAssertFalse(r.model.transcript("k").more)
        r.socket.push(["type": "items", "key": "k", "items": [["id": "2", "ts": 2, "kind": "assistant", "text": "yo"]]])
        await eventually { r.model.transcript("k").items.map(\.id) == ["0", "1", "2"] }
        r.socket.push(["type": "items", "key": "unwatched", "items": [["id": "9", "ts": 9, "kind": "assistant", "text": "no"]]])
        // the newest page sent again (a reconnect) keeps the earlier record
        r.socket.push(["type": "items", "key": "k", "reset": true, "items": [["id": "1", "ts": 1, "kind": "user", "text": "hi"], ["id": "2", "ts": 2, "kind": "assistant", "text": "yo!"]]])
        await eventually { r.model.transcript("k").items.last?.text == "yo!" }
        XCTAssertEqual(r.model.transcript("k").items.map(\.id), ["0", "1", "2"])
        XCTAssertTrue(r.model.transcript("unwatched").items.isEmpty)
        r.model.closeSession("k")
        await eventually { r.socket.sentTypes().contains("unsub.session") }
        XCTAssertTrue(r.model.transcript("k").items.isEmpty)
        r.model.stop()
    }

    func testHideRevertsOnError() async {
        let r = await rig()
        r.socket.push(listMessage([cliSessionJSON()]))
        await eventually { !r.model.sessions.isEmpty }
        r.core.handle { _ in .json(["error": "no", "code": "invalid"], status: 400) }
        do { try await r.model.setHidden("d1:claude:s1", true); XCTFail("expected failure") } catch {}
        XCTAssertFalse(r.model.sessions[0].hidden)
        r.core.handle { _ in .json(["ok": true]) }
        try? await r.model.setHidden("d1:claude:s1", true)
        XCTAssertTrue(r.model.sessions[0].hidden)
        XCTAssertTrue(r.model.groups.flatMap(\.folders).isEmpty, "hidden sessions leave the list")
        r.model.showHidden = true
        XCTAssertEqual(r.model.groups.flatMap(\.folders).count, 1)
        r.model.stop()
    }

    func testSendRules() async {
        let r = await rig()
        r.core.handle { _ in .json(["turn": 1, "started": true]) }
        try? await r.model.send("k", text: "   ")
        XCTAssertTrue(r.core.recorded("/api/cli-agents/send").isEmpty, "blank text is not sent")
        do { try await r.model.send("k", text: String(repeating: "字", count: 11_000)); XCTFail("too large") } catch {
            XCTAssertEqual(CliErrorText.text(for: error), "内容太长")
        }
        try? await r.model.send("k", text: "  你好 ")
        XCTAssertEqual(r.core.recorded("/api/cli-agents/send").first?.json["text"] as? String, "你好")
        r.model.stop()
    }

    func testNotificationsOnlyWhenAwayAndNew() async {
        // the first look (the snapshot) is silent, even for a session that is already waiting
        let r = await rig { _ in .json(["devices": [["id": "d1", "name": "办公室", "online": true]],
                                         "sessions": [cliSessionJSON(state: "running"), cliSessionJSON("d1:claude:w", state: "waiting")], "requests": []]) }
        await eventually { r.model.sessions.count == 2 }
        r.model.setNotifications(true)
        r.model.isForeground = { false }
        r.socket.push(listMessage([cliSessionJSON(state: "running"), cliSessionJSON("d1:claude:w", state: "waiting")]))
        try? await Task.sleep(for: .milliseconds(40))
        XCTAssertTrue(r.notes.sent.isEmpty, "a session that was already waiting is not new")
        r.socket.push(["type": "list.delta", "upserts": [cliSessionJSON(state: "waiting")], "removes": []])
        await eventually { r.notes.sent.count == 1 }
        XCTAssertEqual(r.notes.sent[0].title, "修复登录"); XCTAssertEqual(r.notes.sent[0].body, "等你处理"); XCTAssertEqual(r.notes.sent[0].key, "d1:claude:s1")
        r.socket.push(["type": "list.delta", "upserts": [cliSessionJSON(state: "waiting")], "removes": []])
        try? await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(r.notes.sent.count, 1, "still waiting is not new")
        let request: [String: Any] = ["id": "r1", "key": "d1:claude:s1", "kind": "permission", "tool": "Bash", "summary": "rm -rf build", "createdAt": 1, "expiresAt": CliAgentsModel.currentMs() + 60_000]
        r.socket.push(["type": "requests", "key": "d1:claude:s1", "requests": [request]])
        await eventually { r.notes.sent.count == 2 }
        XCTAssertEqual(r.notes.sent[1].body, "Bash rm -rf build")
        r.model.isForeground = { true }
        r.socket.push(["type": "list.delta", "upserts": [cliSessionJSON("d1:claude:w", state: "idle")], "removes": []])
        await eventually { r.model.sessions.contains { $0.key == "d1:claude:w" && $0.state == .idle } }
        r.socket.push(["type": "list.delta", "upserts": [cliSessionJSON("d1:claude:w", state: "waiting")], "removes": []])
        await eventually { r.model.sessions.contains { $0.key == "d1:claude:w" && $0.state == .waiting } }
        XCTAssertEqual(r.notes.sent.count, 2, "no notification while the app is in front")
        r.model.stop()
    }

    func testSelectionIsRemembered() {
        let defaults = UserDefaults(suiteName: "cli-test-\(UUID().uuidString)")!
        let client = StubCore().client()
        let model = CliAgentsModel(client: { client }, defaults: defaults)
        XCTAssertNil(model.selectedKey)
        model.select("d1:claude:s1")
        XCTAssertEqual(CliAgentsModel(client: { client }, defaults: defaults).selectedKey, "d1:claude:s1")
        model.setNotifications(true)
        XCTAssertTrue(CliAgentsModel(client: { client }, defaults: defaults).notificationsOn)
        model.select(nil)
        XCTAssertNil(CliAgentsModel(client: { client }, defaults: defaults).selectedKey)
    }
}

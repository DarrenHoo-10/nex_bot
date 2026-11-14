import Foundation

// `WS /api/cli-agents/stream`: the live list, transcripts, requests and terminals of Agent mode. Port of `stream.ts`.

public enum CliSocketMessage: Sendable, Equatable { case text(String), data(Data) }

/// The part of a WebSocket the stream needs, so tests can stand in for the network.
public protocol CliSocket: AnyObject, Sendable {
    /// Starts the connection.
    func resume()
    /// Returns once the handshake is done; throws when the connection fails first.
    func opened() async throws
    /// Queues one message. Order is kept; a failure shows up as `receive` throwing.
    func send(_ message: CliSocketMessage)
    func receive() async throws -> CliSocketMessage
    /// Closes the connection and releases its resources.
    func cancel()
    /// The code the connection closed with, or 0. A rejected handshake (401, 403) reads as 4401.
    var closeCode: Int { get }
}

/// A `URLSessionWebSocketTask` with a delegate that reports the handshake and the close code.
public final class URLSessionCliSocket: NSObject, CliSocket, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!
    private var openResult: Result<Void, Error>?
    private var waiter: CheckedContinuation<Void, Error>?
    private var recordedCode = 0

    public init(request: URLRequest) {
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 60
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        task = session.webSocketTask(with: request)
        task.maximumMessageSize = 4 * 1024 * 1024
    }

    public func resume() { task.resume() }

    public func opened() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            lock.lock()
            if let result = openResult { lock.unlock(); continuation.resume(with: result) } else { waiter = continuation; lock.unlock() }
        }
    }

    private func resolve(_ result: Result<Void, Error>) {
        lock.lock()
        guard openResult == nil else { lock.unlock(); return }
        openResult = result
        let pending = waiter; waiter = nil
        lock.unlock()
        pending?.resume(with: result)
    }

    public func send(_ message: CliSocketMessage) {
        switch message {
        case .text(let s): task.send(.string(s)) { _ in }
        case .data(let d): task.send(.data(d)) { _ in }
        }
    }

    public func receive() async throws -> CliSocketMessage {
        switch try await task.receive() {
        case .string(let s): return .text(s)
        case .data(let d): return .data(d)
        @unknown default: throw URLError(.badServerResponse)
        }
    }

    public func cancel() {
        task.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
        resolve(.failure(CancellationError()))
    }

    public var closeCode: Int {
        lock.lock(); defer { lock.unlock() }
        return recordedCode != 0 ? recordedCode : task.closeCode.rawValue
    }

    // MARK: Delegate

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        resolve(.success(()))
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        lock.lock(); recordedCode = closeCode.rawValue; lock.unlock()
        resolve(.failure(URLError(.networkConnectionLost)))
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let status = (task.response as? HTTPURLResponse)?.statusCode, status == 401 || status == 403 {
            lock.lock(); recordedCode = 4401; lock.unlock()
        }
        resolve(.failure(error ?? URLError(.networkConnectionLost)))
    }

    /// A token never follows a redirect.
    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                           completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

public actor CliAgentStream {
    public enum Status: Sendable, Equatable { case idle, connecting, open, reconnecting, closed(code: Int) }
    public enum Event: Sendable {
        case status(Status)
        case message(CliServerMessage)
        /// A frame of terminal output.
        case output(sid: UInt32, data: Data)
    }

    public typealias Sleeper = @Sendable (Double) async throws -> Void
    public typealias RequestProvider = @Sendable () async -> URLRequest?
    public typealias SocketFactory = @Sendable (URLRequest) -> any CliSocket

    public static let pingInterval = 20.0
    public static let silenceLimit = 45.0
    public static let unauthorizedCode = 4401

    /// Seconds before reconnect attempt `attempt` (0-based): 1 s doubling to 30 s, plus up to 25 % jitter, within 1 to 30 s.
    public static func reconnectDelay(attempt: Int, random: Double) -> Double {
        let base = min(30_000.0, 1000.0 * pow(2, Double(max(0, min(attempt, 20)))))
        return min(30_000, max(1000, (base * (1 + 0.25 * random)).rounded())) / 1000
    }

    public nonisolated let events: AsyncStream<Event>
    private let continuation: AsyncStream<Event>.Continuation
    private let requestProvider: RequestProvider
    private let makeSocket: SocketFactory
    private let sleep: Sleeper
    private let random: @Sendable () -> Double
    private let now: @Sendable () -> Double

    private var status: Status = .idle
    private var runTask: Task<Void, Never>?
    private var socket: (any CliSocket)?
    private var generation = 0
    private var attempt = 0
    private var lastRx = 0.0
    private var listCount = 0
    private var sessionCounts: [CliSessionKey: Int] = [:]
    private var abandoned = Set<String>()

    public init(requestProvider: @escaping RequestProvider,
                makeSocket: @escaping SocketFactory = { URLSessionCliSocket(request: $0) },
                sleep: @escaping Sleeper = { try await Task.sleep(for: .seconds($0)) },
                random: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) },
                now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 }) {
        let pair = AsyncStream<Event>.makeStream(bufferingPolicy: .unbounded)
        events = pair.stream; continuation = pair.continuation
        self.requestProvider = requestProvider; self.makeSocket = makeSocket; self.sleep = sleep; self.random = random; self.now = now
    }

    /// A stream for one Core client. The request is rebuilt at every connect, so a rotated token is used.
    public init(client: @escaping @Sendable () async -> CoreClient) {
        self.init(requestProvider: { await client().cliStreamRequest() })
    }

    public func currentStatus() -> Status { status }

    // MARK: Lifecycle

    public func start() {
        guard runTask == nil else { return }
        attempt = 0
        generation += 1
        let mine = generation
        runTask = Task { await self.run(generation: mine) }
    }

    public func stop() {
        generation += 1
        runTask?.cancel(); runTask = nil
        socket?.cancel(); socket = nil
        abandoned.removeAll()
        setStatus(.idle)
    }

    /// Skips the wait of a pending reconnect (the app came back to the front, the network is back).
    public func reconnectNow() {
        guard runTask != nil, status != .open, status != .connecting else { return }
        runTask?.cancel()
        socket?.cancel(); socket = nil
        generation += 1
        let mine = generation
        attempt = 0
        runTask = Task { await self.run(generation: mine) }
    }

    private func setStatus(_ next: Status) {
        guard next != status else { return }
        status = next
        continuation.yield(.status(next))
    }

    // MARK: Subscriptions

    public func subscribeList() {
        listCount += 1
        if listCount == 1 { send(["type": "sub.list"]) }
    }

    public func unsubscribeList() { listCount = max(0, listCount - 1) }

    public func subscribeSession(_ key: CliSessionKey) {
        let count = (sessionCounts[key] ?? 0) + 1
        sessionCounts[key] = count
        if count == 1 { send(["type": "sub.session", "key": key]) }
    }

    public func unsubscribeSession(_ key: CliSessionKey) {
        guard let count = sessionCounts[key] else { return }
        if count <= 1 { sessionCounts[key] = nil; send(["type": "unsub.session", "key": key]) } else { sessionCounts[key] = count - 1 }
    }

    // MARK: Terminal

    /// Asks for a terminal. The answer is `term.opened` or `error` carrying `req`. False when the socket is not open.
    @discardableResult
    public func openTerminal(req: String, key: CliSessionKey, cols: Int, rows: Int, observe: Bool) -> Bool {
        let size = CliTermState.clampSize(cols: cols, rows: rows)
        return send(["type": "term.open", "req": req, "key": key, "cols": size.cols, "rows": size.rows, "observe": observe])
    }

    /// The view that asked for `req` is gone: close the terminal when it opens, and do not report it.
    public func abandonTerminal(req: String) { abandoned.insert(req) }

    public func resizeTerminal(sid: UInt32, cols: Int, rows: Int) {
        let size = CliTermState.clampSize(cols: cols, rows: rows)
        send(["type": "term.resize", "sid": sid, "cols": size.cols, "rows": size.rows])
    }

    public func grantCredit(sid: UInt32, bytes: Int) { send(["type": "term.credit", "sid": sid, "bytes": bytes]) }
    public func closeTerminal(sid: UInt32) { send(["type": "term.close", "sid": sid]) }

    /// Keystrokes for a terminal opened in control mode. Large input goes out in several frames.
    @discardableResult
    public func sendInput(sid: UInt32, _ bytes: Data) -> Bool {
        guard status == .open, let socket else { return false }
        for frame in CliFrame.inputFrames(sid: sid, bytes) { socket.send(.data(frame)) }
        return true
    }

    @discardableResult
    private func send(_ object: [String: Any]) -> Bool {
        guard status == .open, let socket, let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return false }
        socket.send(.text(text))
        return true
    }

    // MARK: Connection

    private func run(generation mine: Int) async {
        var everOpened = false
        while !Task.isCancelled, generation == mine {
            guard let request = await requestProvider() else { setStatus(.closed(code: Self.unauthorizedCode)); break }
            guard !Task.isCancelled, generation == mine else { break }
            setStatus(everOpened || attempt > 0 ? .reconnecting : .connecting)
            let socket = makeSocket(request)
            self.socket = socket
            socket.resume()
            var failed = false
            do { try await socket.opened() } catch { failed = true }
            guard !Task.isCancelled, generation == mine else { socket.cancel(); break }
            if !failed {
                everOpened = true
                lastRx = now()
                setStatus(.open)
                resubscribe()
                let pinger = Task { await self.pingLoop(socket: socket, generation: mine) }
                await receiveLoop(socket: socket, generation: mine)
                pinger.cancel()
            }
            let code = socket.closeCode
            socket.cancel()
            if self.socket === socket { self.socket = nil }
            guard !Task.isCancelled, generation == mine else { break }
            if code == Self.unauthorizedCode { setStatus(.closed(code: code)); runTask = nil; return }
            setStatus(.reconnecting)
            let delay = Self.reconnectDelay(attempt: attempt, random: random())
            attempt += 1
            do { try await sleep(delay) } catch { break }
        }
        if generation == mine { runTask = nil }
    }

    private func resubscribe() {
        if listCount > 0 { send(["type": "sub.list"]) }
        for key in sessionCounts.keys { send(["type": "sub.session", "key": key]) }
    }

    private func receiveLoop(socket: any CliSocket, generation mine: Int) async {
        while !Task.isCancelled, generation == mine {
            let message: CliSocketMessage
            do { message = try await socket.receive() } catch { return }
            guard generation == mine else { return }
            lastRx = now()
            attempt = 0
            handle(message)
        }
    }

    private func pingLoop(socket: any CliSocket, generation mine: Int) async {
        while !Task.isCancelled, generation == mine {
            do { try await sleep(Self.pingInterval) } catch { return }
            guard !Task.isCancelled, generation == mine, status == .open else { return }
            if now() - lastRx > Self.silenceLimit { socket.cancel(); return }
            send(["type": "ping"])
        }
    }

    private func handle(_ message: CliSocketMessage) {
        switch message {
        case .data(let data):
            if case .output(let sid, let payload)? = CliFrame.decode(data) { continuation.yield(.output(sid: sid, data: payload)) }
        case .text(let text):
            guard let parsed = CliServerMessage.parse(Data(text.utf8)) else { return }
            switch parsed {
            case .pong: return
            case .termOpened(let req, let sid, _, _, _):
                if abandoned.remove(req) != nil { send(["type": "term.close", "sid": sid]); return }
            case .error(_, let req?, _):
                if abandoned.remove(req) != nil { return }
            default: break
            }
            continuation.yield(.message(parsed))
        }
    }
}

import Foundation

/// One dispatched Server-Sent Event.
public struct SSEEvent: Sendable, Equatable {
    public var id: String?
    public var event: String
    public var data: String
    public init(id: String? = nil, event: String = "message", data: String) { self.id = id; self.event = event; self.data = data }
}

/// Incremental SSE parser (WHATWG rules): `id`, `event`, multi-line `data`, `retry`, comments, CR/LF/CRLF.
public struct SSEParser: Sendable {
    public private(set) var lastEventID: String?
    public private(set) var retry: Int?
    private var line: [UInt8] = []
    private var skipLF = false
    private var data: [String] = []
    private var event = ""

    public init(lastEventID: String? = nil) { self.lastEventID = lastEventID }

    /// Feeds raw bytes; returns the events completed by them.
    public mutating func feed(_ bytes: some Sequence<UInt8>) -> [SSEEvent] {
        var out: [SSEEvent] = []
        for byte in bytes { if let e = feed(byte: byte) { out.append(e) } }
        return out
    }

    public mutating func feed(byte: UInt8) -> SSEEvent? {
        if skipLF { skipLF = false; if byte == 0x0A { return nil } }
        switch byte {
        case 0x0D: skipLF = true; return endLine()
        case 0x0A: return endLine()
        default: line.append(byte); return nil
        }
    }

    private mutating func endLine() -> SSEEvent? {
        defer { line.removeAll(keepingCapacity: true) }
        let text = String(decoding: line, as: UTF8.self)
        if text.isEmpty {
            defer { data = []; event = "" }
            guard !data.isEmpty else { return nil }
            return SSEEvent(id: lastEventID, event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n"))
        }
        if text.hasPrefix(":") { return nil }
        var field = text, value = ""
        if let i = text.firstIndex(of: ":") {
            field = String(text[..<i]); value = String(text[text.index(after: i)...])
            if value.hasPrefix(" ") { value.removeFirst() }
        }
        switch field {
        case "event": event = value
        case "data": data.append(value)
        case "id": if !value.contains("\0") { lastEventID = value }
        case "retry": if !value.isEmpty, value.allSatisfy(\.isASCII), let n = Int(value) { retry = n }
        default: break
        }
        return nil
    }
}

/// Exponential reconnect delay, 0.5 s doubling up to 15 s.
public struct Backoff: Sendable {
    public var initial: Double = 0.5, maximum: Double = 15
    public init(initial: Double = 0.5, maximum: Double = 15) { self.initial = initial; self.maximum = maximum }
    public func delay(attempt: Int) -> Double { min(maximum, initial * pow(2, Double(max(0, attempt)))) }
}

/// What an ``EventStream`` reports.
public enum StreamEvent: Sendable {
    case connected
    case event(SSEEvent)
    /// The connection dropped; a reconnect follows after the backoff delay.
    case disconnected(CoreError)
    /// Reconnecting cannot help (the session was rejected). The stream ends.
    case failed(CoreError)
}

/// `GET /api/events` with automatic reconnect and `Last-Event-ID`. Cancel by terminating the iteration or the consuming task.
public struct EventStream: Sendable {
    public typealias Sleeper = @Sendable (Double) async throws -> Void
    let client: CoreClient
    let path: String
    let backoff: Backoff
    let sleep: Sleeper
    let initialLastEventID: String?

    public init(client: CoreClient, path: String = "/api/events", lastEventID: String? = nil, backoff: Backoff = Backoff(),
                sleep: @escaping Sleeper = { try await Task.sleep(for: .seconds($0)) }) {
        self.client = client; self.path = path; self.initialLastEventID = lastEventID; self.backoff = backoff; self.sleep = sleep
    }

    public func events() -> AsyncStream<StreamEvent> {
        let (stream, continuation) = AsyncStream<StreamEvent>.makeStream(bufferingPolicy: .unbounded)
        let task = Task { await run(continuation) }
        continuation.onTermination = { _ in task.cancel() }
        return stream
    }

    private func run(_ out: AsyncStream<StreamEvent>.Continuation) async {
        var parser = SSEParser(lastEventID: initialLastEventID), attempt = 0
        while !Task.isCancelled {
            var failure: CoreError
            do {
                let bytes = try await client.openStream(path, lastEventID: parser.lastEventID)
                out.yield(.connected); attempt = 0
                for try await byte in bytes {
                    if let e = parser.feed(byte: byte) { out.yield(.event(e)) }
                }
                failure = CoreError(kind: .network, message: "事件流已断开")
            } catch {
                failure = CoreError.wrap(error)
                if failure.isCancellation || Task.isCancelled { break }
                if failure.invalidatesCredential || failure.endsSession { out.yield(.failed(failure)); out.finish(); return }
            }
            out.yield(.disconnected(failure))
            var delay = backoff.delay(attempt: attempt); attempt += 1
            if let r = parser.retry { delay = max(delay, Double(r) / 1000) }
            do { try await sleep(delay) } catch { break }
        }
        out.finish()
    }
}

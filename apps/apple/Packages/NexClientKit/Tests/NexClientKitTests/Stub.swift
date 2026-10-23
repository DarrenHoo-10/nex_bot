import Foundation
@testable import NexClientKit

struct StubResponse {
    var status = 200
    var headers: [String: String] = [:]
    var body = Data()
    var delay: Double = 0
    static func json(_ object: Any, status: Int = 200, delay: Double = 0) -> StubResponse {
        StubResponse(status: status, headers: ["Content-Type": "application/json"], body: try! JSONSerialization.data(withJSONObject: object), delay: delay)
    }
    static func text(_ s: String, status: Int = 200) -> StubResponse {
        StubResponse(status: status, headers: ["Content-Type": "text/event-stream"], body: Data(s.utf8))
    }
}

struct RecordedRequest: @unchecked Sendable {
    let method: String, path: String, query: String, headers: [String: String], body: Data
    var json: [String: Any] { (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:] }
}

/// A fake Core reachable at a unique `https://stub-N.test` origin through a URLProtocol.
final class StubCore: @unchecked Sendable {
    nonisolated(unsafe) private static var servers: [String: StubCore] = [:]
    private static let registry = NSLock()
    nonisolated(unsafe) private static var counter = 0

    let host: String
    private let lock = NSLock()
    private var handler: (RecordedRequest) -> StubResponse = { _ in .json(["error": "unhandled"], status: 500) }
    private(set) var requests: [RecordedRequest] = []

    var origin: CoreOrigin { CoreOrigin(unchecked: "https://\(host)") }
    var session: URLSession { CoreClient.makeSession(protocolClasses: [StubProtocol.self]) }
    func client(token: String? = "tok") -> CoreClient { CoreClient(origin: origin, token: token, session: session) }

    init() {
        Self.registry.lock(); defer { Self.registry.unlock() }
        Self.counter += 1; host = "stub-\(Self.counter).test"
        Self.servers[host] = self
    }
    func handle(_ h: @escaping (RecordedRequest) -> StubResponse) { lock.withLock { handler = h } }
    func recorded(_ path: String? = nil) -> [RecordedRequest] { lock.withLock { requests.filter { path == nil || $0.path == path } } }

    fileprivate static func server(for host: String?) -> StubCore? { registry.withLock { host.flatMap { servers[$0] } } }
    fileprivate func respond(_ r: RecordedRequest) -> StubResponse { lock.withLock { requests.append(r); return handler }(r) }
}

final class StubProtocol: URLProtocol, @unchecked Sendable {
    private var delivery: DispatchWorkItem?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() { delivery?.cancel() }
    override func startLoading() {
        let url = request.url!
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buf = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let n = stream.read(&buf, maxLength: buf.count); if n <= 0 { break }; body.append(contentsOf: buf[..<n]) }
        }
        let recorded = RecordedRequest(method: request.httpMethod ?? "GET", path: url.path, query: url.query ?? "", headers: request.allHTTPHeaderFields ?? [:], body: body)
        guard let server = StubCore.server(for: url.host) else { client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost)); return }
        let response = server.respond(recorded)
        let deliver: @Sendable () -> Void = { [self] in
            let http = HTTPURLResponse(url: url, statusCode: response.status, httpVersion: "HTTP/1.1", headerFields: response.headers)!
            client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: response.body)
            client?.urlProtocolDidFinishLoading(self)
        }
        if response.delay > 0 {
            let work = DispatchWorkItem(block: deliver)
            delivery = work
            DispatchQueue.global().asyncAfter(deadline: .now() + response.delay, execute: work)
        } else { deliver() }
    }
}

let coreID = "core-1"
func syncJSON(cursor: Int = 1, epoch: Int = 0, core: String = coreID, boot: String = "boot-1") -> [String: Any] {
    ["cursor": cursor, "privacyEpoch": epoch, "coreId": core, "bootId": boot]
}
func message(_ seq: Int, role: String = "assistant", content: String? = nil) -> [String: Any] {
    ["id": "m\(seq)", "bot_id": "b1", "seq": seq, "role": role, "kind": "message", "content": content ?? "msg \(seq)", "task_id": NSNull(), "created_at": 1_760_000_000_000 + seq]
}
func stateJSON(sync: [String: Any] = syncJSON(), bots: [String] = ["b1"], tasks: [[String: Any]] = []) -> [String: Any] {
    ["sync": sync, "bots": bots.map { ["id": $0, "name": "Bot \($0)", "unread_count": 0, "read_seq": 0] }, "approvals": [], "tasks": tasks,
     "routines": [], "devices": [], "conversations": [], "onlineDevices": [], "memories": [["id": "x"]]]
}
func feedJSON(_ seqs: [Int], sync: [String: Any] = syncJSON(), hasMore: Bool = false, streaming: [[String: Any]] = []) -> [String: Any] {
    ["sync": sync, "messages": seqs.map { message($0) }, "hasMore": hasMore, "streaming": streaming]
}

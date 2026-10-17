import Foundation

/// Response type for endpoints whose body is ignored (`{"ok":true}`).
public struct Empty: Decodable, Sendable { public init() {} }

/// Refuses every redirect, so a token never follows a `Location` header.
final class RedirectRefuser: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Async HTTP client for one Core origin. Bearer auth, JSON bodies, 15 s timeout, no cookies, no redirects.
public struct CoreClient: Sendable {
    public let origin: CoreOrigin
    public let token: String?
    let session: URLSession
    static let refuser = RedirectRefuser()

    /// An ephemeral session without cookie or cache storage. Tests pass `protocolClasses` to stub the network.
    public static func makeSession(protocolClasses: [AnyClass]? = nil) -> URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.httpCookieStorage = nil
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 15
        c.waitsForConnectivity = false
        if let protocolClasses { c.protocolClasses = protocolClasses }
        return URLSession(configuration: c)
    }

    public init(origin: CoreOrigin, token: String? = nil, session: URLSession = CoreClient.makeSession()) {
        self.origin = origin; self.token = token; self.session = session
    }

    public func get<T: Decodable & Sendable>(_ path: String, query: [(String, String)] = []) async throws -> T {
        try await send(request(path, query: query, body: nil), as: T.self)
    }

    public func post<T: Decodable & Sendable, B: Encodable>(_ path: String, body: B, as: T.Type = T.self) async throws -> T {
        try await send(request(path, query: [], body: JSONEncoder().encode(body)), as: T.self)
    }

    /// POST whose response body is ignored.
    public func post<B: Encodable>(_ path: String, body: B) async throws {
        _ = try await post(path, body: body, as: Empty.self)
    }

    func request(_ path: String, query: [(String, String)], body: Data?, timeout: TimeInterval = 15) throws -> URLRequest {
        var allowed = CharacterSet.urlQueryAllowed; allowed.remove(charactersIn: "&=+#")
        let q = query.map { "\($0.0.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")=\($0.1.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }.joined(separator: "&")
        guard let url = URL(string: origin.string + path + (q.isEmpty ? "" : "?" + q)) else { throw CoreError.invalidOrigin("请求地址无效") }
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        r.httpShouldHandleCookies = false
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { r.httpMethod = "POST"; r.httpBody = body; r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return r
    }

    func send<T: Decodable & Sendable>(_ request: URLRequest, as: T.Type) async throws -> T {
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request, delegate: Self.refuser) } catch { throw CoreError.wrap(error) }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw Self.httpError(status: status, data: data) }
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw CoreError.wrap(error) }
    }

    static func httpError(status: Int, data: Data) -> CoreError {
        let body = try? JSONDecoder().decode(JSONValue.self, from: data)
        let message = body?["error"]?.stringValue ?? (status == 401 ? "登录已失效" : "无法连接 Core")
        return CoreError(kind: .http, message: message, status: status, code: body?["code"]?.stringValue)
    }

    /// Opens a long-lived SSE response. The request timeout is long because Core sends no heartbeat.
    func openStream(_ path: String, lastEventID: String?) async throws -> URLSession.AsyncBytes {
        var r = try request(path, query: [], body: nil, timeout: 3600)
        r.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let lastEventID { r.setValue(lastEventID, forHTTPHeaderField: "Last-Event-ID") }
        do {
            let (bytes, response) = try await session.bytes(for: r, delegate: Self.refuser)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                var data = Data(); for try await b in bytes { data.append(b); if data.count > 4096 { break } }
                throw Self.httpError(status: status, data: data)
            }
            return bytes
        } catch { throw CoreError.wrap(error) }
    }
}

// MARK: - Typed endpoints

struct EmptyBody: Encodable {}
struct BotSeq: Encodable { let botId: String; let seq: Int }
struct InputBody: Encodable { let botId: String; let text: String; let clientId: String }
struct TaskBody: Encodable { let taskId: String }
struct ApprovalBody: Encodable { let id: String; let hash: String; let allow: Bool }
struct SessionBody: Encodable { let token: String }
struct StartBody: Encodable { let account: String; let name: String }
struct RevokeBody: Encodable { let sessionId: String }
struct RespondBody: Encodable {
    let transaction: LoginTransaction; let password: String
    func encode(to encoder: Encoder) throws {
        try transaction.encode(to: encoder)
        var c = encoder.container(keyedBy: AnyKey.self); try c.encode(password, forKey: .init("password"))
    }
}

extension CoreClient {
    public func identity() async throws -> ClientIdentity { try await get("/api/client/identity") }
    public func state() async throws -> WorkspaceState { try await get("/api/state") }
    /// Latest 100 messages, or the 100 before `before`, or the next 200 after `after`.
    public func feed(bot: String, before: Int? = nil, after: Int? = nil) async throws -> Feed {
        var q = [("bot", bot)]
        if let before { q.append(("before", String(before))) }
        if let after { q.append(("after", String(after))) }
        return try await get("/api/agents/messages", query: q)
    }
    public func sendInput(bot: String, text: String, clientID: String) async throws {
        try await post("/api/agents/input", body: InputBody(botId: bot, text: text, clientId: clientID))
    }
    public func markRead(bot: String, seq: Int) async throws { try await post("/api/agents/read", body: BotSeq(botId: bot, seq: seq)) }
    public func cancel(task: String) async throws { try await post("/api/cancel", body: TaskBody(taskId: task)) }
    public func decide(approval id: String, hash: String, allow: Bool) async throws {
        try await post("/api/approvals", body: ApprovalBody(id: id, hash: hash, allow: allow))
    }
    public func clientSessions() async throws -> ClientSessionList { try await get("/api/clients") }
    public func revoke(sessionID: String) async throws { try await post("/api/clients/revoke", body: RevokeBody(sessionId: sessionID)) }
}

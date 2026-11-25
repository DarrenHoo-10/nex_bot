import Foundation

/// Which `/api/state` projection to fetch.
public enum StateView: String, Sendable { case full, summary }

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

    /// The same client with another bearer token (after a session refresh). Origin and URLSession are kept.
    public func withToken(_ token: String?) -> CoreClient { CoreClient(origin: origin, token: token, session: session) }

    /// `GET` of a non-JSON body. Returns the bytes and the response headers (lower-cased names).
    func getData(_ path: String, timeout: TimeInterval = 60) async throws -> (data: Data, headers: [String: String]) {
        let r = try request(path, query: [], body: nil, timeout: timeout)
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: r, delegate: Self.refuser) } catch { throw CoreError.wrap(error) }
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw Self.httpError(status: status, data: data) }
        var headers: [String: String] = [:]
        for (k, v) in http?.allHeaderFields ?? [:] { if let k = k as? String, let v = v as? String { headers[k.lowercased()] = v } }
        return (data, headers)
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
        // a proxy's HTML page (Core restarting) has no `error`: the status says what happened
        let message = body?["error"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? CoreError.statusText(status)
        return CoreError(kind: .http, message: message, status: status, code: body?["code"]?.stringValue)
    }

    /// Opens a long-lived SSE response. The request timeout is long because Core sends no heartbeat.
    func openStream(_ path: String, lastEventID: String?, query: [(String, String)] = []) async throws -> URLSession.AsyncBytes {
        var r = try request(path, query: query, body: nil, timeout: 3600)
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
struct InputBody: Encodable {
    let botId: String; let text: String; let clientId: String; let attachments: [String]
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(botId, forKey: .init("botId")); try c.encode(text, forKey: .init("text")); try c.encode(clientId, forKey: .init("clientId"))
        if !attachments.isEmpty { try c.encode(attachments, forKey: .init("attachments")) }
    }
}
struct DeleteMessageImageBody: Encodable { let botId: String; let messageId: String; let attachmentId: String }
struct TaskBody: Encodable { let taskId: String }
struct ApprovalBody: Encodable { let id: String; let hash: String; let allow: Bool; let remember: Bool }
struct RevokeApprovalRuleBody: Encodable { let id: String; let botId: String }
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
    /// `GET /api/state`. `.summary` (`?view=summary`) omits memory `content` and `journal`; the stores poll with it.
    /// `.full` sends no query and returns everything.
    public func state(view: StateView = .full) async throws -> WorkspaceState {
        try await get("/api/state", query: view == .summary ? [("view", "summary")] : [])
    }
    public func workspaceState(page: String, botID: String? = nil, conversationID: String? = nil, resources: [String] = []) async throws -> WorkspaceState {
        var query = [("view", "workspace"), ("page", page)]
        if let botID { query.append(("bot", botID)) }
        if let conversationID { query.append(("conversationId", conversationID)) }
        if !resources.isEmpty { query.append(("resources", resources.joined(separator: ","))) }
        return try await get("/api/state", query: query)
    }

    public func feed(bot: String, before: Int? = nil, after: Int? = nil, around: String? = nil, at: Int? = nil) async throws -> Feed {
        try await historyFeed(bot: bot, before: before, after: after, around: around, at: at)
    }

    func historyFeed(bot: String, conversationID: String? = nil, before: Int?, after: Int?, around: String? = nil, at: Int?) async throws -> Feed {
        let timestamp = at ?? Int(Date().timeIntervalSince1970 * 1000)
        var query = [("bot", bot), ("view", "window"), ("at", String(timestamp))]
        if let conversationID { query.append(("conversationId", conversationID)) }
        if let around { query.append(("around", around)) }
        else if let after { query.append(("after", String(after))) }
        else { query.append(("before", String(before ?? 9_007_199_254_740_991))) }
        return try await get("/api/agents/messages", query: query)
    }
    /// `POST /api/agents/input`. `attachments` are ids from ``uploadAttachment(botID:name:data:)``; text may be empty
    /// when at least one is given. The same `clientID` is idempotent.
    public func sendInput(bot: String, text: String, clientID: String, attachments: [String] = []) async throws {
        try await post("/api/agents/input", body: InputBody(botId: bot, text: text, clientId: clientID, attachments: attachments))
    }
    /// `POST /api/agents/messages/image/delete`: removes one image from a sent message. Text and other attachments stay;
    /// when the image was the whole message, Core removes the message too.
    public func deleteMessageImage(bot: String, messageID: String, attachmentID: String) async throws {
        try await post("/api/agents/messages/image/delete", body: DeleteMessageImageBody(botId: bot, messageId: messageID, attachmentId: attachmentID))
    }
    /// `POST /api/auth/refresh` with the current bearer: rotates the token and extends the session.
    /// 401 = session over; 409 = another refresh already rotated it; 429 = throttled.
    public func refreshSession() async throws -> LoginSession { try await post("/api/auth/refresh", body: EmptyBody()) }
    public func markRead(bot: String, seq: Int) async throws { try await post("/api/agents/read", body: BotSeq(botId: bot, seq: seq)) }
    public func cancel(task: String) async throws { try await post("/api/cancel", body: TaskBody(taskId: task)) }
    public func decide(approval id: String, hash: String, allow: Bool, remember: Bool = false) async throws {
        try await post("/api/approvals", body: ApprovalBody(id: id, hash: hash, allow: allow, remember: remember))
    }
    public func revokeApprovalRule(id: String, botID: String) async throws {
        try await post("/api/approvals/revoke", body: RevokeApprovalRuleBody(id: id, botId: botID))
    }
    public func clientSessions() async throws -> ClientSessionList { try await get("/api/clients") }
    public func authStatus() async throws -> AccountStatus { try await get("/api/auth/status") }
    public func revoke(sessionID: String) async throws { try await post("/api/clients/revoke", body: RevokeBody(sessionId: sessionID)) }
}

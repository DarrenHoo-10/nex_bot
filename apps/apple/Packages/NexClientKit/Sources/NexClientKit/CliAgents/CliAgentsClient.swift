import Foundation

// HTTP side of Agent mode, on the existing CoreClient transport (Bearer auth, no redirects). Failures are `CoreError`s whose
// `code` is Core's machine-readable code; `CliErrorText.text(for:)` turns one into the line to show.

private struct CliKeyBody: Encodable { let key: String }
private struct CliStartBody: Encodable {
    let deviceId: String; let engine: String; let cwd: String
    var worktreeBranch: String? = nil; var requestId: String? = nil; var model: String? = nil; var effort: String? = nil
}
private struct CliSendBody: Encodable { let key: String; let text: String }
private struct CliHideBody: Encodable { let key: String; let hidden: Bool }
private struct CliAnswerBody: Encodable { let id: String; let decision: CliDecision; let answers: [String: String]? }
private struct CliForkBody: Encodable { let key: String; let botId: String }
private struct CliSupervisionBody: Encodable { let settings: Settings
    struct Settings: Encodable { let transientRetry: Bool?; let usageLimit: Bool?; let wakeup: Bool? }
}

extension CoreClient {
    static let cliBase = "/api/cli-agents"
    /// Core refuses a message over this many UTF-8 bytes.
    public static let cliMaxSendBytes = 32 * 1024
    public static let cliPageSize = 40

    /// `GET /api/cli-agents`: computers, sessions and pending requests. A malformed row is dropped, not fatal.
    public func cliSnapshot() async throws -> CliSnapshot { try await get(Self.cliBase) }

    /// The newest page of a session's transcript, or the page before the item `before`.
    public func cliItems(key: CliSessionKey, before: String? = nil) async throws -> CliItemsPage {
        var query = [("key", key)]
        if let before { query.append(("before", before)) }
        return try await get(Self.cliBase + "/items", query: query)
    }

    /// `GET /api/cli-agents/requests?key=`: the pending requests of one session.
    public func cliRequests(key: CliSessionKey) async throws -> [CliRequest] {
        struct Body: Decodable, Sendable { let requests: LossyList<CliRequest>? }
        let body: Body = try await get(Self.cliBase + "/requests", query: [("key", key)])
        return (body.requests?.values ?? []).filter { $0.key == key }
    }

    /// Starts a CLI in `cwd`, or in a new worktree of it on `worktreeBranch` (`requestId` makes a retry reuse that tree). A
    /// worktree of a large repository takes a while to check out: this request waits longer than the others.
    public func cliStart(deviceId: String, engine: CliEngine, cwd: String, worktreeBranch: String? = nil, requestId: String? = nil, model: String? = nil, effort: String? = nil) async throws -> CliSessionKey {
        let body = CliStartBody(deviceId: deviceId, engine: engine.rawValue, cwd: cwd, worktreeBranch: worktreeBranch, requestId: worktreeBranch == nil ? nil : requestId,
                                model: model?.isEmpty == false ? model : nil, effort: effort?.isEmpty == false ? effort : nil)
        let r: CliKeyResult = try await send(request(Self.cliBase + "/start", query: [], body: JSONEncoder().encode(body), timeout: 45), as: CliKeyResult.self)
        return r.key
    }

    /// `GET /api/cli-agents/models`: the rows of that CLI's own `/model` picker on the computer.
    public func cliModels(deviceId: String, engine: CliEngine) async throws -> CliModelCatalog {
        try await get(Self.cliBase + "/models", query: [("deviceId", deviceId), ("engine", engine.rawValue)])
    }

    /// Resumes a stopped session in a nex_bot terminal. The resumed session may have a new key.
    public func cliContinue(key: CliSessionKey) async throws -> CliSessionKey {
        let r: CliKeyResult = try await post(Self.cliBase + "/continue", body: CliKeyBody(key: key))
        return r.key
    }

    public func cliSend(key: CliSessionKey, text: String) async throws {
        let r: CliSendResult = try await post(Self.cliBase + "/send", body: CliSendBody(key: key, text: text))
        _ = r
    }

    public func cliInterrupt(key: CliSessionKey) async throws {
        let r: CliOutcomeResult = try await post(Self.cliBase + "/interrupt", body: CliKeyBody(key: key))
        _ = r
    }

    public func cliOpenLocal(key: CliSessionKey) async throws { try await post(Self.cliBase + "/open-local", body: CliKeyBody(key: key)) }

    public func cliHide(key: CliSessionKey, hidden: Bool) async throws { try await post(Self.cliBase + "/hide", body: CliHideBody(key: key, hidden: hidden)) }

    /// Allow or deny a pending request. A question answer maps the question text to the chosen labels joined by ", ".
    /// A request that was answered elsewhere or expired fails with code `not_found`.
    public func cliAnswer(id: String, decision: CliDecision, answers: [String: String]? = nil) async throws {
        let r: CliOutcomeResult = try await post(Self.cliBase + "/answer", body: CliAnswerBody(id: id, decision: decision, answers: answers))
        _ = r
    }

    /// Hands the session's record over to an assistant. Returns where it landed.
    public func cliFork(key: CliSessionKey, botId: String) async throws -> CliForkResult {
        try await post(Self.cliBase + "/fork", body: CliForkBody(key: key, botId: botId))
    }

    public func cliSupervision() async throws -> CliSupervision { try await get(Self.cliBase + "/supervision") }

    /// Changes the given switches for every folder; the answer is the new state.
    public func cliSaveSupervision(transientRetry: Bool? = nil, usageLimit: Bool? = nil, wakeup: Bool? = nil) async throws -> CliSupervision {
        let body = try JSONEncoder().encode(CliSupervisionBody(settings: .init(transientRetry: transientRetry, usageLimit: usageLimit, wakeup: wakeup)))
        var put = try request(Self.cliBase + "/supervision", query: [], body: body)
        put.httpMethod = "PUT"
        return try await send(put, as: CliSupervision.self)
    }

    /// `ws(s)://host/api/cli-agents/stream` with the bearer in the `Authorization` header.
    public func cliStreamRequest() -> URLRequest? {
        guard let token, var components = URLComponents(string: origin.string + Self.cliBase + "/stream") else { return nil }
        components.scheme = origin.isHTTPS ? "wss" : "ws"
        guard let url = components.url else { return nil }
        var r = URLRequest(url: url)
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return r
    }
}

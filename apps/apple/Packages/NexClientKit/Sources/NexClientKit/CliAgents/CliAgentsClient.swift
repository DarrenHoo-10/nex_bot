import Foundation
import CryptoKit
import ImageIO

// HTTP side of Agent mode, on the existing CoreClient transport (Bearer auth, no redirects). Failures are `CoreError`s whose
// `code` is Core's machine-readable code; `CliErrorText.text(for:)` turns one into the line to show.

private struct CliKeyBody: Encodable { let key: String }
private struct CliContinueBody: Encodable { let key: String; let effort: String?; let model: String?; var permissions: String? = nil }
private struct CliStartBody: Encodable {
    let deviceId: String; let engine: String; let cwd: String
    var branch: String? = nil
    var worktreeBranch: String? = nil; var worktreeBaseBranch: String? = nil
    var requestId: String? = nil; var model: String? = nil; var effort: String? = nil; var createDir: Bool? = nil
    var permissions: String? = nil
}
private struct CliSendBody: Encodable {
    let key: String; let text: String
    var delivery: String? = nil; var clientMessageId: String? = nil; var requestId: String? = nil
    var questionId: String? = nil
    var interruptWaiting: Bool? = nil
}
private struct CliImageResult: Decodable, Sendable { let path: String }
private struct CliHideBody: Encodable { let key: String; let hidden: Bool }
private struct CliAnswerBody: Encodable { let id: String; let decision: CliDecision; let answers: [String: String]?; var always: Bool? = nil }
private struct CliForkBody: Encodable { let key: String; let botId: String; let itemId: String? }
private struct CliSupervisionBody: Encodable { let settings: Settings
    struct Settings: Encodable { let transientRetry: Bool?; let usageLimit: Bool?; let wakeup: Bool? }
}

public struct CliTranslationSelection: Codable, Sendable {
    public let connectionId: String
    public let model: String

    public init(connectionId: String, model: String) {
        self.connectionId = connectionId; self.model = model
    }
}

public struct CliTranslationSettings: Decodable, Sendable {
    public let selection: CliTranslationSelection?
    public let available: Bool
    public let version: Int
}

extension CoreClient {
    public func cliTranslationSettings() async throws -> CliTranslationSettings {
        try await get(Self.cliBase + "/translation-settings")
    }

    public func saveCliTranslationSettings(_ selection: CliTranslationSelection?, version: Int) async throws -> CliTranslationSettings {
        struct Body: Encodable {
            let selection: CliTranslationSelection?
            let version: Int
            enum CodingKeys: String, CodingKey { case selection, version }

            func encode(to encoder: Encoder) throws {
                var values = encoder.container(keyedBy: CodingKeys.self)
                try values.encode(selection, forKey: .selection)
                try values.encode(version, forKey: .version)
            }
        }
        return try await post(Self.cliBase + "/translation-settings", body: Body(selection: selection, version: version))
    }

    static let cliBase = "/api/cli-agents"
    /// Core refuses a message over this many UTF-8 bytes.
    public static let cliMaxSendBytes = 32 * 1024
    public static let cliMaxAttachBytes = 8 * 1024 * 1024
    public static let cliPageSize = 40

    /// `GET /api/cli-agents`: computers, sessions and pending requests. A malformed row is dropped, not fatal.
    public func cliSnapshot() async throws -> CliSnapshot { try await get(Self.cliBase) }

    /// The newest page of a session's transcript, or the page before the item `before`.
    public func cliItems(key: CliSessionKey, before: String? = nil) async throws -> CliItemsPage {
        var query = [("key", key)]
        if let before { query.append(("before", before)) }
        return try await get(Self.cliBase + "/items", query: query, timeout: 30)
    }

    public func cliTranslateReply(key: CliSessionKey, itemId: String, source: String) async throws -> String? {
        struct Body: Encodable { let key: String; let itemId: String; let source: String }
        struct Result: Decodable, Sendable { let translation: String? }
        let body = try JSONEncoder().encode(Body(key: key, itemId: itemId, source: source))
        let result = try await send(request(Self.cliBase + "/translate", query: [], body: body, timeout: 60), as: Result.self)
        return result.translation
    }

    /// `GET /api/cli-agents/requests?key=`: the pending requests of one session.
    public func cliRequests(key: CliSessionKey) async throws -> [CliRequest] {
        struct Body: Decodable, Sendable { let requests: LossyList<CliRequest>? }
        let body: Body = try await get(Self.cliBase + "/requests", query: [("key", key)])
        return (body.requests?.values ?? []).filter { $0.key == key }
    }

    /// Starts a CLI in `cwd` (optionally switching it to `branch`), or in a new worktree of it on `worktreeBranch`
    /// (off `worktreeBaseBranch`, with `requestId` making a retry reuse that tree). A worktree of a large repository
    /// takes a while to check out: this request waits longer than the others.
    /// `permissions` is "full" or "ask"; nil leaves the computer's default (full access for a new session).
    public func cliStart(deviceId: String, engine: CliEngine, cwd: String, worktreeBranch: String? = nil, requestId: String? = nil, model: String? = nil, effort: String? = nil, createDir: Bool = false,
                         permissions: CliPermissionMode? = nil, branch: String? = nil, worktreeBaseBranch: String? = nil) async throws -> CliSessionKey {
        let trimmedWorktree = worktreeBranch?.trimmingCharacters(in: .whitespacesAndNewlines)
        let wtBranch = trimmedWorktree?.isEmpty == false ? trimmedWorktree : nil
        let trimmedBase = worktreeBaseBranch?.trimmingCharacters(in: .whitespacesAndNewlines)
        let wtBase = wtBranch != nil && trimmedBase?.isEmpty == false ? trimmedBase : nil
        let trimmedBranch = branch?.trimmingCharacters(in: .whitespacesAndNewlines)
        let inPlaceBranch = wtBranch == nil && !createDir && trimmedBranch?.isEmpty == false ? trimmedBranch : nil
        let body = CliStartBody(deviceId: deviceId, engine: engine.rawValue, cwd: cwd, branch: inPlaceBranch,
                                worktreeBranch: wtBranch, worktreeBaseBranch: wtBase,
                                requestId: wtBranch == nil ? nil : requestId,
                                model: model?.isEmpty == false ? model : nil, effort: effort?.isEmpty == false ? effort : nil, createDir: createDir && wtBranch == nil ? true : nil,
                                permissions: permissions?.rawValue)
        let r: CliKeyResult = try await send(request(Self.cliBase + "/start", query: [], body: JSONEncoder().encode(body), timeout: 60), as: CliKeyResult.self)
        return r.key
    }

    /// `GET /api/cli-agents/dirs`: the sub-folders of an absolute folder on the computer; "" lists its drives and home folder.
    public func cliDirs(deviceId: String, path: String) async throws -> CliDirListing {
        try await get(Self.cliBase + "/dirs", query: [("deviceId", deviceId), ("path", path)])
    }

    /// `GET /api/cli-agents/branches`: local Git branches and dirty state of an absolute folder on the computer.
    public func cliBranches(deviceId: String, cwd: String) async throws -> CliGitBranches {
        try await get(Self.cliBase + "/branches", query: [("deviceId", deviceId), ("cwd", cwd)])
    }

    /// `GET /api/cli-agents/models`: the rows of that CLI's own `/model` picker on the computer.
    public func cliModels(deviceId: String, engine: CliEngine) async throws -> CliModelCatalog {
        try await get(Self.cliBase + "/models", query: [("deviceId", deviceId), ("engine", engine.rawValue)])
    }

    /// Resumes a stopped session in a nex_bot terminal. The resumed session may have a new key.
    public func cliContinue(key: CliSessionKey, effort: String? = nil, model: String? = nil, permissions: CliPermissionMode? = nil) async throws -> CliSessionKey {
        let r: CliKeyResult = try await post(Self.cliBase + "/continue", body: CliContinueBody(key: key, effort: effort, model: model, permissions: permissions?.rawValue), timeout: 45)
        return r.key
    }

    public func cliEnqueue(key: CliSessionKey, text: String) async throws {
        struct Body: Encodable { let key: String; let text: String; let delivery = "queue"; let requestId = UUID(); let clientMessageId = UUID() }
        try await post(Self.cliBase + "/send", body: Body(key: key, text: text), timeout: 90)
    }

    public func cliEditQueued(_ entry: CliQueuedEntry, text: String) async throws {
        struct Body: Encodable { let entryId: String; let expectedVersion: Int; let text: String }
        try await post(Self.cliBase + "/queue/edit", body: Body(entryId: entry.id, expectedVersion: entry.version, text: text))
    }

    public func cliSteerQueued(_ entry: CliQueuedEntry, questionId: String?, interruptWaiting: Bool) async throws -> CliQueuedEntry {
        struct Body: Encodable { let entryId: String; let expectedVersion: Int; let questionId: String?; let interruptWaiting: Bool? }
        struct Response: Decodable, Sendable { let entry: CliQueuedEntry }
        let result: Response = try await post(Self.cliBase + (questionId != nil || interruptWaiting ? "/steer-waiting" : "/queue/steer"), body: Body(entryId: entry.id, expectedVersion: entry.version, questionId: questionId, interruptWaiting: interruptWaiting ? true : nil), timeout: 90)
        return result.entry
    }

    public func cliResumeQueue(key: CliSessionKey) async throws {
        try await post(Self.cliBase + "/queue/resume", body: CliKeyBody(key: key))
    }

    @discardableResult public func cliSend(key: CliSessionKey, text: String) async throws -> CliSendResult {
        try await post(Self.cliBase + "/send", body: CliSendBody(key: key, text: text), timeout: 90)
    }

    /// The first message uses the same outbox request even if its HTTP acknowledgement was lost.
    func cliSendFirst(key: CliSessionKey, text: String, launchID: String) async throws -> CliSendResult {
        guard text.utf8.count <= Self.cliMaxSendBytes else { throw CoreError(kind: .http, message: "内容太长", status: 400, code: "too_large") }
        let body = CliSendBody(key: key, text: text, delivery: "send", clientMessageId: launchID, requestId: launchID)
        return try await post(Self.cliBase + "/send", body: body, timeout: 90)
    }

    /// Returns the delivery notice when Core cannot confirm immediate steering.
    public func cliSteer(key: CliSessionKey, text: String, questionId: String? = nil, interruptWaiting: Bool = false) async throws -> String? {
        let body = CliSendBody(key: key, text: text, delivery: "steer", clientMessageId: UUID().uuidString, requestId: UUID().uuidString, questionId: questionId, interruptWaiting: interruptWaiting ? true : nil)
        let route = questionId != nil || interruptWaiting ? "/steer-waiting" : "/send"
        let result: CliSendResult = try await post(Self.cliBase + route, body: body, timeout: 90)
        switch result.status {
        case "failed": return "引导失败，消息已保留"
        case "uncertain": return "引导结果待确认"
        case "pending": return "引导暂未送达，已排队"
        default: return result.delivery == "unconfirmed" ? "已发送，未确认" : nil
        }
    }

    /// Uploads a file directly to the session's computer and returns its local path for pasting into the terminal.
    public func cliAttachFile(key: CliSessionKey, name: String, data: Data) async throws -> String {
        guard !data.isEmpty else { throw CoreError(kind: .http, message: "空文件无法上传", status: 400) }
        guard data.count <= Self.cliMaxAttachBytes else {
            throw CoreError(kind: .http, message: "附件不能超过 8 MB", status: 413, code: "too_large")
        }
        let safeName = String((name.isEmpty ? "file" : name).suffix(200))
        var upload = try request(Self.cliBase + "/attach", query: [("key", key), ("name", safeName)], body: data, timeout: 120)
        upload.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let result: CliImageResult = try await send(upload, as: CliImageResult.self)
        guard !result.path.isEmpty else { throw CoreError(kind: .http, message: "附件上传结果格式不对") }
        return result.path
    }

    public func cliUploadImage(key: CliSessionKey, image: CliImageUpload) async throws -> String {
        guard !image.data.isEmpty, image.data.count <= ChatAttachment.maxBytes else {
            throw CoreError(kind: .http, message: "图片不能超过 5 MB", status: 413)
        }
        var upload = try request(Self.cliBase + "/images", query: [("key", key), ("name", String(image.name.suffix(200)))],
                                 body: image.data, timeout: 120)
        upload.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let result: CliImageResult = try await send(upload, as: CliImageResult.self)
        guard Self.cliImageID(result.path) != nil else { throw CoreError(kind: .unsupported, message: "Core 版本过旧，升级后可发送图片") }
        let name = String(image.name.map { "[]\\\r\n".contains($0) ? "_" : $0 })
        return "![\(name)](\(result.path))"
    }

    public func cliDownloadImage(_ path: String, workspaceID: String? = nil) async throws -> Data {
        guard Self.cliImageID(path) != nil else { throw CoreError(kind: .http, message: "图片不存在", status: 404) }
        return try await cachedImagePreview(path + "?preview=1", workspaceID: workspaceID)
    }

    func cachedImagePreview(_ path: String, workspaceID: String?) async throws -> Data {
        let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        let file = workspaceID.flatMap { scope -> URL? in
            guard !scope.isEmpty, token != nil else { return nil }
            let key = SHA256.hash(data: Data("\(origin.string)\n\(scope)\n\(path)".utf8)).map { String(format: "%02x", $0) }.joined()
            return directory?.appendingPathComponent("message-images", isDirectory: true).appendingPathComponent(key)
        }
        if let file, let bytes = try? Data(contentsOf: file), CGImageSourceCreateWithData(bytes as CFData, nil) != nil { return bytes }
        let (bytes, headers) = try await getData(path, timeout: 120)
        guard headers["content-type"]?.hasPrefix("image/") == true, CGImageSourceCreateWithData(bytes as CFData, nil) != nil else {
            throw CoreError(kind: .http, message: "图片加载失败")
        }
        if let file {
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? bytes.write(to: file, options: .atomic)
        }
        return bytes
    }

    private static func cliImageID(_ path: String) -> UUID? {
        let prefix = cliBase + "/images/"
        guard path.hasPrefix(prefix) else { return nil }
        return UUID(uuidString: String(path.dropFirst(prefix.count)))
    }

    public func cliInterrupt(key: CliSessionKey) async throws {
        let r: CliOutcomeResult = try await post(Self.cliBase + "/interrupt", body: CliKeyBody(key: key))
        _ = r
    }

    public func cliHide(key: CliSessionKey, hidden: Bool) async throws { try await post(Self.cliBase + "/hide", body: CliHideBody(key: key, hidden: hidden)) }

    /// Allow or deny a pending request. A question answer maps the question text to the chosen labels joined by ", ".
    /// A request that was answered elsewhere or expired fails with code `not_found`.
    /// `always` (with allow) also allows such calls for the rest of the session, for a request that offers it.
    public func cliAnswer(id: String, decision: CliDecision, answers: [String: String]? = nil, always: Bool = false) async throws {
        let r: CliOutcomeResult = try await post(Self.cliBase + "/answer", body: CliAnswerBody(id: id, decision: decision, answers: answers, always: always && decision == .allow ? true : nil))
        _ = r
    }

    /// Hands the session's record over to an assistant. Returns where it landed.
    public func cliFork(key: CliSessionKey, botId: String, itemId: String? = nil) async throws -> CliForkResult {
        let route = itemId == nil ? "/fork" : "/fork-message"
        return try await post(Self.cliBase + route, body: CliForkBody(key: key, botId: botId, itemId: itemId))
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

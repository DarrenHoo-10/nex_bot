import Foundation

// Agent mode ("cli-agent"): the JSON shapes Core sends, ported from `shared/cli-agents.ts`.
// A row that does not match is dropped by the list decoders (one bad row must not blank the page), as the web client does.

/// `<deviceId>:<engine>:<nativeId>`.
public typealias CliSessionKey = String

public enum CliEngine: String, Codable, Sendable, Hashable, CaseIterable {
    case claude, codex, zcode, agy
    public var label: String {
        switch self {
        case .claude: "Claude"
        case .codex: "Codex"
        case .zcode: "ZCode"
        case .agy: "Antigravity CLI"
        }
    }
}

public enum CliSessionState: String, Codable, Sendable, Hashable { case running, waiting, idle, stopped }
public enum CliLiveIn: String, Codable, Sendable, Hashable { case nexbot, terminal, desktop, background }

/// Decodes the elements of an array that decode, and skips the others.
struct LossyList<Element: Decodable & Sendable>: Decodable, Sendable {
    let values: [Element]
    private struct Skip: Decodable { init(from decoder: Decoder) throws {} }
    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var out: [Element] = []
        while !container.isAtEnd {
            if let value = try? container.decode(Element.self) { out.append(value) } else { _ = try? container.decode(Skip.self) }
        }
        values = out
    }
}

/// How full a session's context is: the tokens its last request carried, and the window when known.
public struct CliContextUsage: Sendable, Hashable, Decodable {
    public var used: Int
    public var window: Int?
    public init(used: Int, window: Int? = nil) { self.used = used; self.window = window }
}

public struct CliSession: Sendable, Hashable, Identifiable, Decodable {
    public var key: CliSessionKey
    public var deviceId: String
    public var hidden: Bool
    public var online: Bool
    public var engine: CliEngine
    public var nativeId: String
    public var configDir: String
    public var cwd: String
    public var title: String
    public var gitBranch: String?
    public var state: CliSessionState
    public var waitingFor: String?
    public var liveIn: CliLiveIn?
    public var terminal: String?
    public var sendVia: String?
    public var model: String?
    public var cliVersion: String?
    /// The repository's main checkout this session's folder belongs to; absent outside Git.
    public var repoRoot: String?
    /// What the last request carried; absent until the CLI wrote one down.
    public var context: CliContextUsage?
    /// Epoch milliseconds.
    public var lastActivityAt: Int
    public var writerUnknown: Bool
    public var id: String { key }

    public init(key: CliSessionKey, deviceId: String, hidden: Bool = false, online: Bool = true, engine: CliEngine = .claude, nativeId: String,
                configDir: String = "", cwd: String, title: String = "", gitBranch: String? = nil, state: CliSessionState = .idle,
                waitingFor: String? = nil, liveIn: CliLiveIn? = nil, terminal: String? = nil, model: String? = nil, cliVersion: String? = nil,
                lastActivityAt: Int = 0, writerUnknown: Bool = false, repoRoot: String? = nil, context: CliContextUsage? = nil, sendVia: String? = nil) {
        self.key = key; self.deviceId = deviceId; self.hidden = hidden; self.online = online; self.engine = engine; self.nativeId = nativeId
        self.configDir = configDir; self.cwd = cwd; self.title = title; self.gitBranch = gitBranch; self.state = state; self.waitingFor = waitingFor
        self.liveIn = liveIn; self.terminal = terminal; self.model = model; self.cliVersion = cliVersion; self.lastActivityAt = lastActivityAt
        self.writerUnknown = writerUnknown; self.repoRoot = repoRoot; self.context = context; self.sendVia = sendVia
    }

    enum CodingKeys: String, CodingKey {
        case key, deviceId, hidden, online, engine, nativeId, configDir, cwd, title, gitBranch, state, waitingFor, liveIn, terminal, model
        case cliVersion, lastActivityAt, writerUnknown, repoRoot, context, sendVia
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        deviceId = try c.decode(String.self, forKey: .deviceId)
        hidden = try c.decode(Bool.self, forKey: .hidden)
        online = try c.decode(Bool.self, forKey: .online)
        engine = try c.decode(CliEngine.self, forKey: .engine)
        nativeId = try c.decode(String.self, forKey: .nativeId)
        configDir = try c.decodeIfPresent(String.self, forKey: .configDir) ?? ""
        cwd = try c.decode(String.self, forKey: .cwd)
        title = try c.decode(String.self, forKey: .title)
        gitBranch = try c.decodeIfPresent(String.self, forKey: .gitBranch)
        state = try c.decode(CliSessionState.self, forKey: .state)
        waitingFor = try c.decodeIfPresent(String.self, forKey: .waitingFor)
        liveIn = try c.decodeIfPresent(CliLiveIn.self, forKey: .liveIn)
        terminal = try c.decodeIfPresent(String.self, forKey: .terminal)
        sendVia = try? c.decodeIfPresent(String.self, forKey: .sendVia)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        cliVersion = try c.decodeIfPresent(String.self, forKey: .cliVersion)
        lastActivityAt = try c.decode(Int.self, forKey: .lastActivityAt)
        writerUnknown = try c.decodeIfPresent(Bool.self, forKey: .writerUnknown) ?? false
        repoRoot = try? c.decodeIfPresent(String.self, forKey: .repoRoot)
        // a usage this side cannot read is left out rather than dropping the row
        context = try? c.decodeIfPresent(CliContextUsage.self, forKey: .context)
    }
}

public struct CliTerminalCapability: Sendable, Hashable, Decodable {
    public var name: String
    public var version: String
    public var ready: Bool
    public var error: String?
    public init(name: String = "herdr-core", version: String = "", ready: Bool, error: String? = nil) {
        self.name = name; self.version = version; self.ready = ready; self.error = error
    }
}

public struct CliCapability: Sendable, Hashable, Decodable {
    public var engines: [CliEngine]
    public var terminal: CliTerminalCapability
    public var agyNeedsUpdate: Bool
    /// what the executor does beyond the first protocol (`launchOptions`, `models`, …); empty on older ones
    public var features: [String]
    public init(engines: [CliEngine], terminal: CliTerminalCapability, features: [String] = [], agyNeedsUpdate: Bool = false) {
        self.engines = engines; self.terminal = terminal; self.features = features; self.agyNeedsUpdate = agyNeedsUpdate
    }
    enum CodingKeys: String, CodingKey { case engines, terminal, features, agyNeedsUpdate }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        engines = try c.decode(LossyList<CliEngine>.self, forKey: .engines).values
        terminal = try c.decode(CliTerminalCapability.self, forKey: .terminal)
        features = (try? c.decodeIfPresent(LossyList<String>.self, forKey: .features))?.values ?? []
        agyNeedsUpdate = (try? c.decode(Bool.self, forKey: .agyNeedsUpdate)) ?? false
    }
}

public struct CliDevice: Sendable, Hashable, Identifiable, Decodable {
    public var id: String
    public var name: String
    public var online: Bool
    public var cliAgents: CliCapability?
    public init(id: String, name: String, online: Bool, cliAgents: CliCapability? = nil) {
        self.id = id; self.name = name; self.online = online; self.cliAgents = cliAgents
    }
    enum CodingKeys: String, CodingKey { case id, name, online, cliAgents }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        online = try c.decode(Bool.self, forKey: .online)
        cliAgents = try? c.decodeIfPresent(CliCapability.self, forKey: .cliAgents)
    }
}

// MARK: Items

public enum CliItemKind: String, Sendable, Hashable, Codable { case user, assistant, thinking, tool, notice, turn }
public enum CliToolStatus: String, Sendable, Hashable, Codable { case running, ok, error }
public enum CliNoticeLevel: String, Sendable, Hashable, Codable { case info, error }
public enum CliTurnPhase: String, Sendable, Hashable, Codable { case started, ended, aborted }

/// One conversation item. Which fields are set depends on `kind`: `text` for user, assistant, thinking and notice;
/// `name`, `input`, `status` and `output` for a tool; `level` for a notice; `phase` for a turn marker.
public struct CliItem: Sendable, Hashable, Identifiable, Codable {
    public var id: String
    public var ts: Int
    public var kind: CliItemKind
    public var text: String
    public var images: [String]
    public var queued: Bool
    public var queuedByUser: Bool?
    public var name: String
    public var input: String
    public var status: CliToolStatus
    public var output: String?
    public var level: CliNoticeLevel
    public var replyPhase: String?
    public var phase: CliTurnPhase

    public init(id: String, ts: Int, kind: CliItemKind, text: String = "", images: [String] = [], queued: Bool = false, name: String = "",
                input: String = "", status: CliToolStatus = .running, output: String? = nil, level: CliNoticeLevel = .info, phase: CliTurnPhase = .started) {
        self.id = id; self.ts = ts; self.kind = kind; self.text = text; self.images = images; self.queued = queued; self.name = name
        self.queuedByUser = nil
        self.input = input; self.status = status; self.output = output; self.level = level; self.phase = phase
    }

    enum CodingKeys: String, CodingKey { case id, ts, kind, text, images, queued, queuedByUser, name, input, status, output, level, phase, replyPhase }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        ts = try c.decode(Int.self, forKey: .ts)
        kind = try c.decode(CliItemKind.self, forKey: .kind)
        text = ""; images = []; queued = false; queuedByUser = nil; name = ""; input = ""; status = .running; output = nil; level = .info; phase = .started
        switch kind {
        case .user:
            text = try c.decode(String.self, forKey: .text)
            images = try c.decodeIfPresent([String].self, forKey: .images) ?? []
            queued = try c.decodeIfPresent(Bool.self, forKey: .queued) ?? false
            queuedByUser = try c.decodeIfPresent(Bool.self, forKey: .queuedByUser)
            if queued, queuedByUser != true, images.isEmpty, Self.isLegacyTaskNotification(text) {
                kind = .notice; text = ""; queued = false
            } else if queued, images.isEmpty, let peer = Self.parseLegacyAgentMessage(text) {
                kind = .tool; name = "AgentMessage"; input = peer.sender; status = .ok; output = peer.body
                text = ""; queued = false; queuedByUser = nil
            }
        case .assistant, .thinking:
            text = try c.decode(String.self, forKey: .text)
            replyPhase = try c.decodeIfPresent(String.self, forKey: .replyPhase)
        case .tool:
            name = try c.decode(String.self, forKey: .name)
            input = try c.decode(String.self, forKey: .input)
            status = try c.decode(CliToolStatus.self, forKey: .status)
            output = try c.decodeIfPresent(String.self, forKey: .output)
        case .notice:
            level = try c.decode(CliNoticeLevel.self, forKey: .level)
            text = try c.decode(String.self, forKey: .text)
            if level == .info, text.drop(while: \.isWhitespace).hasPrefix("<task-notification>") { text = "" }
        case .turn:
            phase = try c.decode(CliTurnPhase.self, forKey: .phase)
        }
    }

    private static func isLegacyTaskNotification(_ text: String) -> Bool {
        let header = String(text.prefix(2048))
        let payload = header.range(of: #"<(summary|result|output)>"#, options: .regularExpression)?.lowerBound ?? header.endIndex
        let fields = String(header[..<payload])
        return fields.range(of: #"^\s*<task-notification>\s*<task-id>\s*[A-Za-z0-9_./:-]{1,128}\s*</task-id>"#, options: .regularExpression) != nil
            && fields.range(of: #"<(tool-use-id|output-file)>[^<]+</\1>"#, options: .regularExpression) != nil
    }

    private static func xmlAttr(_ attrs: String, _ name: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: #"(?:^|\s)"# + name + #"="([^"<>\n]+)""#),
              let match = regex.firstMatch(in: attrs, range: NSRange(attrs.startIndex..., in: attrs)),
              let range = Range(match.range(at: 1), in: attrs) else { return nil }
        let value = attrs[range].trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    private static func shortPeerId(_ value: String) -> String {
        let stripped = value.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"^uds:[/\\]+(?:\.[\\/]+pipe[\\/]+)?(?:LOCAL[\\/]+)?(?:cc-msg-)?"#, with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"^local_"#, with: "", options: [.regularExpression, .caseInsensitive])
        if stripped.range(of: #"^[A-Za-z0-9_-]{12,}$"#, options: .regularExpression) != nil {
            return String(stripped.prefix(8))
        }
        return stripped
    }

    private static func formatAgentSender(session: Bool, from: String?, name: String?) -> String {
        let cleanName = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let cleanFrom = from?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let shortFrom = cleanFrom.isEmpty ? "" : shortPeerId(cleanFrom)
        if session {
            if !cleanName.isEmpty { return "会话 \(cleanName)" }
            if !shortFrom.isEmpty { return "会话 \(shortFrom)" }
            return "其他会话"
        }
        if !cleanName.isEmpty, cleanName.lowercased() != "general-purpose", cleanName != cleanFrom {
            return !shortFrom.isEmpty && !cleanName.contains(shortFrom) ? "子 Agent \(cleanName) (\(shortFrom))" : "子 Agent \(cleanName)"
        }
        return shortFrom.isEmpty ? "子 Agent" : "子 Agent \(shortFrom)"
    }

    private static func parseLegacyAgentMessage(_ text: String) -> (sender: String, body: String)? {
        func match(_ pattern: String) -> (attrs: String, body: String)? {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators]),
                  let m = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
                  let r1 = Range(m.range(at: 1), in: text),
                  let r2 = Range(m.range(at: 2), in: text) else { return nil }
            return (String(text[r1]), text[r2].trimmingCharacters(in: .whitespacesAndNewlines))
        }
        if let m = match(#"^\s*<agent-message\b([^>\n]*)>(.*?)</agent-message>\s*$"#) {
            guard let from = xmlAttr(m.attrs, "from"), !m.body.isEmpty else { return nil }
            let name = xmlAttr(m.attrs, "name") ?? xmlAttr(m.attrs, "from-name")
            return (formatAgentSender(session: false, from: from, name: name), m.body)
        }
        if let m = match(#"^\s*<teammate-message\b([^>\n]*)>(.*?)</teammate-message>\s*$"#) {
            guard let id = xmlAttr(m.attrs, "teammate_id"), !m.body.isEmpty else { return nil }
            return (formatAgentSender(session: false, from: id, name: nil), m.body)
        }
        if let m = match(#"^\s*(?:Another Claude session sent a message(?:\s+while you were working)?:\s*\n)?<cross-session-message\b([^>\n]*)>(.*?)</cross-session-message>\s*$"#) {
            let from = xmlAttr(m.attrs, "from")
            let fromName = xmlAttr(m.attrs, "from-name") ?? xmlAttr(m.attrs, "name")
            guard (from != nil || fromName != nil), !m.body.isEmpty,
                  !m.body.hasPrefix("[NexBot]"), !m.body.hasPrefix("[NexBot 远程") else { return nil }
            return (formatAgentSender(session: true, from: from, name: fromName), m.body)
        }
        return nil
    }
}

// MARK: Requests

public enum CliRequestKind: String, Sendable, Hashable, Decodable { case permission, question }
/// Who closed a request: the CLI in the terminal, the CLI's own timeout, nex_bot's answer, or the session went away.
public enum CliResolvedBy: String, Sendable, Hashable, Decodable { case terminal, timeout, nexbot, gone }
public enum CliDecision: String, Sendable, Hashable, Codable { case allow, deny }

public struct CliQuestionOption: Sendable, Hashable, Decodable {
    public var label: String
    public var description: String?
    public init(label: String, description: String? = nil) { self.label = label; self.description = description }
}

public struct CliQuestion: Sendable, Hashable, Decodable {
    public var question: String
    public var header: String?
    public var options: [CliQuestionOption]
    public var multiSelect: Bool
    public init(question: String, header: String? = nil, options: [CliQuestionOption], multiSelect: Bool = false) {
        self.question = question; self.header = header; self.options = options; self.multiSelect = multiSelect
    }
    enum CodingKeys: String, CodingKey { case question, header, options, multiSelect }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        question = try c.decode(String.self, forKey: .question)
        header = try c.decodeIfPresent(String.self, forKey: .header)
        options = try c.decode([CliQuestionOption].self, forKey: .options)
        multiSelect = try c.decodeIfPresent(Bool.self, forKey: .multiSelect) ?? false
    }
}

public struct CliRequest: Sendable, Hashable, Identifiable, Decodable {
    public var id: String
    public var key: CliSessionKey
    public var kind: CliRequestKind
    public var tool: String
    public var summary: String
    /// The tool's arguments in full, when the computer sent them.
    public var detail: String?
    public var options: [String]?
    public var questions: [CliQuestion]?
    /// The computer can allow this kind of call for the rest of the session (answer with `always`).
    public var always: Bool?
    /// Epoch milliseconds.
    public var createdAt: Int
    public var expiresAt: Int
    public init(id: String, key: CliSessionKey, kind: CliRequestKind = .permission, tool: String = "", summary: String = "", detail: String? = nil, options: [String]? = nil,
                questions: [CliQuestion]? = nil, always: Bool? = nil, createdAt: Int = 0, expiresAt: Int) {
        self.id = id; self.key = key; self.kind = kind; self.tool = tool; self.summary = summary; self.detail = detail; self.options = options
        self.questions = questions; self.always = always; self.createdAt = createdAt; self.expiresAt = expiresAt
    }
    /// Offers "本会话总是允许".
    public var offersAlways: Bool { kind == .permission && always == true }
}

// MARK: Errors

/// The standard wording of Core's `code` (`CLI_ERROR_TEXT`).
public enum CliErrorText {
    public static let byCode: [String: String] = [
        "disabled": "Agent 会话已关闭", "paused": "本机控制已暂停", "hc_unavailable": "终端组件不可用", "hc_version": "终端组件版本不符",
        "cli_missing": "找不到所选运行工具", "cwd_missing": "工作目录不存在", "not_found": "会话不存在", "not_in_terminal": "会话不在 nex_bot 终端里",
        "stopped": "会话已停止", "open_elsewhere": "这个会话正在电脑上运行", "read_only": "只看，不能输入", "too_large": "内容太长",
        "invalid": "参数不合法", "busy": "上一个操作还没完成", "device_offline": "电脑离线", "unknown": "结果未知",
    ]

    /// The line to show for a failed call: Core's own wording when it sent some, else the code's standard text.
    public static func text(for error: Error, fallback: String = "操作失败") -> String {
        let e = CoreError.wrap(error)
        if let code = e.code, let standard = byCode[code] {
            let detail = e.message.trimmingCharacters(in: .whitespacesAndNewlines)
            return detail.isEmpty ? standard : detail
        }
        return e.message.isEmpty ? fallback : e.message
    }
}

// MARK: Overview and supervision

public struct CliSnapshot: Sendable, Decodable {
    public var devices: [CliDevice]
    public var sessions: [CliSession]
    public var requests: [CliRequest]
    public init(devices: [CliDevice] = [], sessions: [CliSession] = [], requests: [CliRequest] = []) {
        self.devices = devices; self.sessions = sessions; self.requests = requests
    }
    enum CodingKeys: String, CodingKey { case devices, sessions, requests }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        devices = (try? c.decodeIfPresent(LossyList<CliDevice>.self, forKey: .devices))?.values ?? []
        sessions = (try? c.decodeIfPresent(LossyList<CliSession>.self, forKey: .sessions))?.values ?? []
        requests = (try? c.decodeIfPresent(LossyList<CliRequest>.self, forKey: .requests))?.values ?? []
    }
}

public struct CliItemsPage: Sendable, Decodable {
    public var items: [CliItem]
    public var more: Bool
    public var translationEnabled: Bool
    public init(items: [CliItem], more: Bool, translationEnabled: Bool = false) {
        self.items = items; self.more = more; self.translationEnabled = translationEnabled
    }
    enum CodingKeys: String, CodingKey { case items, more, translationEnabled }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = (try? c.decodeIfPresent(LossyList<CliItem>.self, forKey: .items))?.values ?? []
        more = (try? c.decodeIfPresent(Bool.self, forKey: .more)) == true
        translationEnabled = (try? c.decodeIfPresent(Bool.self, forKey: .translationEnabled)) == true
    }
}

/// The switches of "自动处理设置" that the clients show.
public struct CliSupervisionSettings: Sendable, Hashable, Equatable {
    public var transientRetry: Bool
    public var usageLimit: Bool
    public var wakeup: Bool
    public static let defaults = CliSupervisionSettings(transientRetry: true, usageLimit: false, wakeup: false)
    public init(transientRetry: Bool, usageLimit: Bool, wakeup: Bool) {
        self.transientRetry = transientRetry; self.usageLimit = usageLimit; self.wakeup = wakeup
    }
}

public struct CliSupervision: Sendable, Hashable, Decodable {
    public var settings: CliSupervisionSettings
    /// Folders with settings of their own.
    public var overrides: Int
    /// Actions waiting for their time.
    public var pending: Int

    public init(settings: CliSupervisionSettings = .defaults, overrides: Int = 0, pending: Int = 0) {
        self.settings = settings; self.overrides = overrides; self.pending = pending
    }

    public init(from decoder: Decoder) throws {
        let root = try decoder.singleValueContainer().decode(JSONValue.self)
        let defaults = root["defaults"], global = root["global"]
        func flag(_ key: String, _ fallback: Bool) -> Bool {
            if case .bool(let v)? = global?[key] { return v }
            if case .bool(let v)? = defaults?[key] { return v }
            return fallback
        }
        let base = CliSupervisionSettings.defaults
        settings = CliSupervisionSettings(transientRetry: flag("transientRetry", base.transientRetry), usageLimit: flag("usageLimit", base.usageLimit),
                                          wakeup: flag("wakeup", base.wakeup))
        overrides = root["workspaces"]?.arrayValue?.count ?? 0
        pending = root["actions"]?.arrayValue?.filter { $0["status"]?.stringValue == "pending" }.count ?? 0
    }
}

public struct CliForkResult: Sendable, Hashable, Decodable {
    public var botId: String
    public var conversationId: String
}

public struct CliLaunchEcho: Sendable {
    public let text: String
    public var nativeQueued = false
}

struct CliKeyResult: Decodable, Sendable { let key: String }
public struct CliSendResult: Decodable, Sendable {
    let turn: Int?
    let started: Bool?
    let status: String?
    let delivery: String?
    public let nativeQueued: Bool?
    var dispatched: Bool { status == nil || status == "sent" || status == "confirmed" }
}
struct CliOutcomeResult: Decodable, Sendable { let outcome: String? }

public struct CliQueuedEntry: Decodable, Identifiable, Sendable {
    public let id: String
    public let version: Int
    public let text: String
    public let status: String
    public var errorCode: String? = nil
}
public struct CliSessionQueue: Decodable, Sendable {
    public let sessionKey: String
    public let entries: [CliQueuedEntry]
    public let paused: Bool
    public let pauseReason: String?
}

// MARK: WebSocket messages

public enum CliServerMessage: Sendable {
    case queue(CliSessionQueue)
    case list(devices: [CliDevice], sessions: [CliSession])
    case listDelta(upserts: [CliSession], removes: [CliSessionKey], devices: [CliDevice]?)
    case items(key: CliSessionKey, items: [CliItem], reset: Bool, more: Bool?)
    case itemFragment(key: CliSessionKey, items: [CliItem], reset: Bool, more: Bool?)
    case cachedItems(key: CliSessionKey, items: [CliItem], more: Bool, snapshot: [String])
    case termOpened(req: String, sid: UInt32, cols: Int, rows: Int, observe: Bool)
    case termSize(sid: UInt32, cols: Int, rows: Int)
    case termClosed(sid: UInt32, reason: String)
    case error(code: String, req: String?, message: String?)
    case summary(waiting: Int, running: Int)
    case requests(key: CliSessionKey, requests: [CliRequest])
    case requestResolved(key: CliSessionKey, id: String, by: CliResolvedBy)
    case pong

    private struct Envelope: Decodable { let type: String }
    private struct ListBody: Decodable { let devices: LossyList<CliDevice>; let sessions: LossyList<CliSession> }
    private struct DeltaBody: Decodable { let upserts: LossyList<CliSession>; let removes: [String]; let devices: LossyList<CliDevice>? }
    private struct ItemsBody: Decodable { let key: String; let items: LossyList<CliItem>; let reset: Bool?; let more: Bool?; let continues: Bool?; let snapshot: [String]? }
    private struct OpenedBody: Decodable { let req: String; let sid: UInt32; let cols: Int; let rows: Int; let observe: Bool }
    private struct SizeBody: Decodable { let sid: UInt32; let cols: Int; let rows: Int }
    private struct ClosedBody: Decodable { let sid: UInt32; let reason: String }
    private struct ErrorBody: Decodable { let code: String; let req: String?; let message: String? }
    private struct SummaryBody: Decodable { let waiting: Int; let running: Int }
    private struct RequestsBody: Decodable { let key: String; let requests: LossyList<CliRequest> }
    private struct ResolvedBody: Decodable { let key: String; let id: String; let by: CliResolvedBy }

    /// Nil for anything that is not a known, well-formed message.
    public static func parse(_ data: Data) -> CliServerMessage? {
        let decoder = JSONDecoder()
        guard let type = (try? decoder.decode(Envelope.self, from: data))?.type else { return nil }
        func body<T: Decodable>(_ kind: T.Type) -> T? { try? decoder.decode(kind, from: data) }
        switch type {
        case "queue":
            struct QueueBody: Decodable { let queue: CliSessionQueue }
            return body(QueueBody.self).map { .queue($0.queue) }
        case "list": return body(ListBody.self).map { .list(devices: $0.devices.values, sessions: $0.sessions.values) }
        case "list.delta": return body(DeltaBody.self).map { .listDelta(upserts: $0.upserts.values, removes: $0.removes, devices: $0.devices?.values) }
        case "items": return body(ItemsBody.self).map {
            if let snapshot = $0.snapshot { return .cachedItems(key: $0.key, items: $0.items.values, more: $0.more == true, snapshot: snapshot) }
            if $0.continues == true { return .itemFragment(key: $0.key, items: $0.items.values, reset: $0.reset ?? false, more: $0.more) }
            return .items(key: $0.key, items: $0.items.values, reset: $0.reset ?? false, more: $0.more)
        }
        case "term.opened": return body(OpenedBody.self).map { .termOpened(req: $0.req, sid: $0.sid, cols: $0.cols, rows: $0.rows, observe: $0.observe) }
        case "term.size": return body(SizeBody.self).map { .termSize(sid: $0.sid, cols: $0.cols, rows: $0.rows) }
        case "term.closed": return body(ClosedBody.self).map { .termClosed(sid: $0.sid, reason: $0.reason) }
        case "error": return body(ErrorBody.self).map { .error(code: $0.code, req: $0.req, message: $0.message) }
        case "summary": return body(SummaryBody.self).map { .summary(waiting: $0.waiting, running: $0.running) }
        case "requests": return body(RequestsBody.self).map { b in .requests(key: b.key, requests: b.requests.values.filter { $0.key == b.key }) }
        case "request.resolved": return body(ResolvedBody.self).map { .requestResolved(key: $0.key, id: $0.id, by: $0.by) }
        case "pong": return .pong
        default: return nil
        }
    }
}

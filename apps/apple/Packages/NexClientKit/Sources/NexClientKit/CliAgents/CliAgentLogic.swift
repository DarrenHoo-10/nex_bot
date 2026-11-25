import Foundation

// Pure helpers of Agent mode: session grouping and labels, transcript merging, pending requests and the terminal
// state machine. Ports of `session-model.ts`, `transcript.ts`, `requests.ts` and `terminal-session.ts`.

// MARK: Sessions

public struct CliFolderGroup: Sendable, Hashable, Identifiable {
    public var cwd: String
    public var label: String
    public var sessions: [CliSession]
    public var id: String { cwd }
}

public struct CliDeviceGroup: Sendable, Hashable, Identifiable {
    public var device: CliDevice
    public var folders: [CliFolderGroup]
    public var count: Int
    public var id: String { device.id }
}

public enum CliTone: String, Sendable { case offline, running, waiting, idle, stopped }

public enum CliComposerMode: Sendable, Equatable {
    case send(running: Bool)
    case stopped(hint: String?)
    case blocked(hint: String)
}

public enum CliSessions {
    public static func statusLabel(_ s: CliSession) -> String {
        if !s.online { return "电脑离线" }
        switch s.state {
        case .running: return "运行中"
        case .waiting: return "等你处理"
        case .idle: return "空闲"
        case .stopped: return "已停止"
        }
    }

    /// Offline wins over the session's own state.
    public static func tone(_ s: CliSession) -> CliTone {
        guard s.online else { return .offline }
        switch s.state {
        case .running: return .running
        case .waiting: return .waiting
        case .idle: return .idle
        case .stopped: return .stopped
        }
    }

    public static func folderLabel(_ cwd: String) -> String {
        let parts = cwd.split(whereSeparator: { $0 == "/" || $0 == "\\" })
        if let last = parts.last { return String(last) }
        return cwd.isEmpty ? "未知目录" : cwd
    }

    public static func title(_ s: CliSession) -> String {
        let t = s.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? "\(s.engine.label) 会话" : t
    }

    /// Computer, then folder, then session. A computer without sessions stays so a new session can start on it.
    public static func group(devices: [CliDevice], sessions: [CliSession], showHidden: Bool = false) -> [CliDeviceGroup] {
        var known: [String: CliDevice] = [:]
        var order: [String] = []
        for d in devices where known[d.id] == nil { known[d.id] = d; order.append(d.id) }
        let visible = sessions.filter { showHidden || !$0.hidden }
        for s in visible where known[s.deviceId] == nil {
            known[s.deviceId] = CliDevice(id: s.deviceId, name: s.deviceId, online: s.online)
            order.append(s.deviceId)
        }
        let recent: (CliSession, CliSession) -> Bool = { $0.lastActivityAt > $1.lastActivityAt }
        var groups: [CliDeviceGroup] = []
        for id in order {
            guard let device = known[id] else { continue }
            let mine = visible.filter { $0.deviceId == id }.sorted(by: recent)
            var folders: [String: CliFolderGroup] = [:]
            var folderOrder: [String] = []
            // a worktree sits under the repository it was made from
            for s in mine {
                let root = s.repoRoot?.isEmpty == false ? s.repoRoot! : s.cwd
                if folders[root] == nil { folders[root] = CliFolderGroup(cwd: root, label: folderLabel(root), sessions: []); folderOrder.append(root) }
                folders[root]?.sessions.append(s)
            }
            let sortedFolders = folderOrder.compactMap { folders[$0] }.sorted { ($0.sessions.first?.lastActivityAt ?? 0) > ($1.sessions.first?.lastActivityAt ?? 0) }
            groups.append(CliDeviceGroup(device: device, folders: sortedFolders, count: mine.count))
        }
        return groups.sorted {
            if $0.device.online != $1.device.online { return $0.device.online }
            return $0.device.name.compare($1.device.name, locale: Locale(identifier: "zh-CN")) == .orderedAscending
        }
    }

    public static func hiddenCount(_ sessions: [CliSession]) -> Int { sessions.filter(\.hidden).count }

    /// Running or waiting sessions on every computer, newest first: what the list pins above the projects.
    public static func active(_ sessions: [CliSession], pending: [CliSessionKey: Int] = [:]) -> [CliSession] {
        sessions.filter { s in
            guard !s.hidden else { return false }
            let shown = asked(s, pending: pending[s.key] ?? 0)
            return shown.online && (shown.state == .running || shown.state == .waiting)
        }.sorted { $0.lastActivityAt > $1.lastActivityAt }
    }

    /// Most recently used folders on a computer, for the new-session sheet.
    public static func recentCwds(_ sessions: [CliSession], deviceId: String, limit: Int = 8) -> [String] {
        var latest: [String: Int] = [:]
        for s in sessions where s.deviceId == deviceId && !s.cwd.isEmpty { latest[s.cwd] = max(latest[s.cwd] ?? 0, s.lastActivityAt) }
        return latest.sorted { $0.value > $1.value || ($0.value == $1.value && $0.key < $1.key) }.prefix(limit).map(\.key)
    }

    /// Why a new session cannot start on this computer, or nil when it can.
    public static func deviceBlocker(_ device: CliDevice?) -> String? {
        guard let device, device.online else { return "电脑离线" }
        guard let agents = device.cliAgents else { return "未开启 Agent 会话" }
        if !agents.terminal.ready { return (agents.terminal.error?.isEmpty == false ? agents.terminal.error : nil) ?? "终端组件不可用" }
        if agents.engines.isEmpty { return "找不到 Claude 或 Codex" }
        return nil
    }

    /// Sessions waiting for the user: waiting by their own state, or holding a pending request (`asked` holds their keys).
    public static func waitingCount(_ sessions: [CliSession], asked: Set<String> = []) -> Int {
        sessions.filter { $0.online && !$0.hidden && ($0.state == .waiting || asked.contains($0.key)) }.count
    }

    /// A session that holds a pending request reads as waiting whatever its file says.
    public static func asked(_ s: CliSession, pending: Int) -> CliSession {
        guard pending > 0, s.online, s.state != .waiting else { return s }
        var copy = s; copy.state = .waiting; return copy
    }

    /// The session runs in a nex_bot terminal the app can attach to.
    public static func canAttach(_ s: CliSession) -> Bool {
        s.online && s.state != .stopped && s.liveIn == .nexbot && s.terminal != nil
    }

    public static func composerMode(_ s: CliSession) -> CliComposerMode {
        if !s.online { return .blocked(hint: "电脑离线") }
        if s.state == .stopped { return .stopped(hint: s.writerUnknown ? "可能在电脑上打开" : nil) }
        if s.liveIn == .nexbot && s.terminal != nil { return .send(running: s.state == .running) }
        if s.engine == .codex && (s.sendVia == "inbox" || s.sendVia == "daemon") { return .send(running: false) }
        if s.liveIn == .desktop && s.engine == .claude { return .blocked(hint: "在 Claude 桌面应用中打开") }
        return .blocked(hint: s.writerUnknown ? "可能在电脑上打开" : "在电脑上运行")
    }

    /// The absolute path check of the new-session sheet: a Windows drive, a UNC share or a POSIX path.
    public static func isAbsoluteCwd(_ value: String) -> Bool {
        let chars = Array(value.unicodeScalars)
        guard !chars.isEmpty, value.utf16.count <= 4096, !value.contains("\0") else { return false }
        func isSep(_ c: Unicode.Scalar) -> Bool { c == "/" || c == "\\" }
        if chars.count >= 3, chars[1] == ":", isSep(chars[2]), (chars[0].properties.isAlphabetic && chars[0].isASCII) { return true }
        if chars.count >= 2, isSep(chars[0]), isSep(chars[1]) {
            // `\\host\share`: the host must not start with ? or ., and a share must follow
            guard chars.count > 2, chars[2] != "?", chars[2] != ".", !isSep(chars[2]) else { return false }
            let rest = chars.dropFirst(2)
            guard let hostEnd = rest.firstIndex(where: isSep) else { return false }
            let share = rest[rest.index(after: hostEnd)...]
            return share.first.map { !isSep($0) } ?? false
        }
        return chars[0] == "/"
    }
}

// MARK: Transcript

public enum CliBlock: Sendable, Hashable, Identifiable {
    case user(CliItem)
    case assistant(CliItem)
    case activity(id: String, items: [CliItem])
    case notice(id: String, level: CliNoticeLevel, text: String)

    public var id: String {
        switch self {
        case .user(let i), .assistant(let i): i.id
        case .activity(let id, _): id
        case .notice(let id, _, _): id
        }
    }
}

public enum CliTranscript {
    public static func backgroundTaskTitle(_ item: CliItem) -> String? {
        let name = item.name.lowercased().split(separator: ".").last.map(String.init) ?? ""
        guard item.kind == .tool, item.status != .error,
              ["bash", "shell", "exec_command", "shell_command"].contains(name) else { return nil }
        let fields = (try? JSONSerialization.jsonObject(with: Data(item.input.utf8))) as? [String: Any] ?? [:]
        let detached = item.output?.range(of: #"running in (?:the )?background with (?:task )?id|process running with session id"#,
                                         options: [.regularExpression, .caseInsensitive]) != nil
        guard detached || item.status == .running && fields["run_in_background"] as? Bool == true else { return nil }
        let description = shortTaskTitle(fields["description"] as? String ?? "")
        if !description.isEmpty { return description }
        let command = (fields["command"] ?? fields["cmd"] ?? item.input) as? String ?? ""
        let invocation = command.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"^(?:cd|chdir|pushd|set-location)\s+(?:/d\s+)?(?:"[^"]*"|'[^']*'|[^;&\r\n]+?)\s*(?:&&|;|\r?\n)\s*"#,
                                  with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"^(?:\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)*"#, with: "", options: .regularExpression)
        guard let pattern = try? NSRegularExpression(pattern: #""([^"]*)"|'([^']*)'|([^\s;&|]+)"#) else { return "后台任务" }
        var tokens = pattern.matches(in: invocation, range: NSRange(invocation.startIndex..., in: invocation)).compactMap { match in
            (1...3).compactMap { Range(match.range(at: $0), in: invocation) }.first.map { String(invocation[$0]) }
        }
        func executable(_ token: String?) -> String {
            let name = token?.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
            return name.replacingOccurrences(of: #"\.(?:cmd|bat|exe)$"#, with: "", options: [.regularExpression, .caseInsensitive])
        }
        if executable(tokens.first).lowercased() == "corepack" { tokens.removeFirst() }
        let program = executable(tokens.first)
        if !tokens.isEmpty { tokens.removeFirst() }
        let lower = program.lowercased()
        let packageManager = ["npm", "pnpm", "yarn", "bun"].contains(lower)
        let runsTool = ["npx", "bunx"].contains(lower) || packageManager && ["exec", "x"].contains(tokens.first ?? "")
        if packageManager, ["exec", "run", "x"].contains(tokens.first ?? "") { tokens.removeFirst() }
        let next = tokens.first.flatMap { $0.hasPrefix("-") ? nil : $0 }
        let task = runsTool ? executable(next) : program
        if task.lowercased() == "vite" {
            switch runsTool ? tokens.dropFirst().first : next {
            case "build": return "Vite 构建"
            case "preview": return "Vite 预览服务器"
            default: return "Vite 开发服务器"
            }
        }
        if runsTool, !task.isEmpty { return task.range(of: #"^[\w@.+-]+$"#, options: .regularExpression) == nil ? "后台任务" : shortTaskTitle(task) }
        guard program.range(of: #"^[\w.+-]+$"#, options: .regularExpression) != nil else { return "后台任务" }
        if packageManager, let next, next.range(of: #"^[\w:@.+-]+$"#, options: .regularExpression) != nil {
            return shortTaskTitle("\(program) \(next)")
        }
        if ["node", "python", "python3", "deno", "ruby"].contains(lower),
           let next, next.range(of: #"\.[a-z0-9]+$"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return shortTaskTitle(executable(next))
        }
        return shortTaskTitle(program)
    }

    private static func shortTaskTitle(_ title: String) -> String {
        let clean = title.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return clean.count > 36 ? String(clean.prefix(35)) + "…" : clean
    }

    public static func completedReplies(_ items: [CliItem], active: Bool) -> Set<String> {
        var ids: Set<String> = []
        var closed = !active
        for item in items.reversed() {
            if item.kind == .assistant, closed { ids.insert(item.id) }
            if item.kind == .user { closed = true }
            if item.kind == .turn { closed = item.phase != .aborted }
        }
        return ids
    }

    /// An id already shown is replaced in place; a new id goes after the last item that is not newer. `reset` swaps the list.
    public static func merge(_ existing: [CliItem], _ incoming: [CliItem], reset: Bool = false, appendInRecordOrder: Bool = false) -> [CliItem] {
        if reset { return dedupe(incoming) }
        var out = existing
        var index = Dictionary(out.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { a, _ in a })
        for item in incoming {
            if let at = index[item.id] { out[at] = item; continue }
            var position = out.count
            while !appendInRecordOrder && position > 0 && out[position - 1].ts > item.ts { position -= 1 }
            if position == out.count {
                out.append(item); index[item.id] = position
            } else {
                out.insert(item, at: position)
                index = Dictionary(out.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { a, _ in a })
            }
        }
        return out
    }

    /// A reset page (the newest page sent again). When it starts at an item already shown, everything before
    /// that item stays, so earlier pages the reader loaded survive; `kept` says so. A page that shares nothing
    /// with the list replaces it.
    public static func reset(_ existing: [CliItem], _ incoming: [CliItem]) -> (items: [CliItem], kept: Bool) {
        let page = dedupe(incoming)
        guard let first = page.first, let at = existing.firstIndex(where: { $0.id == first.id }), at > 0 else { return (page, false) }
        let fresh = Set(page.map(\.id))
        return (existing[..<at].filter { !fresh.contains($0.id) } + page, true)
    }

    /// User messages in the list, to tell whether earlier turns are in view.
    public static func userTurns(_ items: [CliItem]) -> Int { items.filter { $0.kind == .user }.count }

    /// An older page goes in front; items already shown win over the page's copy.
    public static func prepend(_ existing: [CliItem], _ older: [CliItem]) -> [CliItem] {
        let shown = Set(existing.map(\.id))
        return dedupe(older).filter { !shown.contains($0.id) } + existing
    }

    static func dedupe(_ items: [CliItem]) -> [CliItem] {
        var seen = Set<String>()
        return items.filter { seen.insert($0.id).inserted }
    }

    /// One block per user or assistant message and notice, and one for each run of tool calls and thinking.
    /// A turn marker only matters when the turn was interrupted.
    public static func group(_ items: [CliItem]) -> [CliBlock] {
        var blocks: [CliBlock] = []
        for item in items {
            switch item.kind {
            // a `/model` switch and other commands leave bookkeeping records, not the user's words
            case .user: if !isCommandRecord(item.text) { blocks.append(.user(item)) }
            case .assistant: blocks.append(.assistant(item))
            case .tool, .thinking:
                if case .activity(let id, let run)? = blocks.last { blocks[blocks.count - 1] = .activity(id: id, items: run + [item]) }
                else { blocks.append(.activity(id: item.id, items: [item])) }
            case .notice:
                guard !item.text.isEmpty else { continue }
                if item.level == .error, let reason = modelFailureReason(item.text) { blocks.append(.notice(id: item.id, level: .error, text: "模型调用失败：" + reason)) }
                else { blocks.append(.notice(id: item.id, level: item.level, text: item.text)) }
            case .turn: if item.phase == .aborted { blocks.append(.notice(id: item.id, level: .info, text: "已中断")) }
            }
        }
        return blocks
    }

    /// A user record that is only a CLI command's bookkeeping (same rule as the web client).
    public static func isCommandRecord(_ text: String) -> Bool {
        text.range(of: #"^\s*(?:<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*?</\1>\s*)+$"#, options: .regularExpression) != nil
    }

    /// Why a model call failed, in a few words, for an error the CLI recorded ("API Error: …"); nil for any other notice.
    /// The provider's raw wording is never shown (same rule as the web client).
    public static func modelFailureReason(_ text: String) -> String? {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        func has(_ pattern: String) -> Bool { raw.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil }
        guard has(#"^(api error|api_error)\b|request rejected|overloaded_error|rate_limit_error|authentication_error|invalid_request_error|\bHTTP (4|5)\d\d\b"#) else { return nil }
        var status = 0
        if let match = raw.range(of: #"\b[1-5]\d\d\b"#, options: .regularExpression) { status = Int(raw[match]) ?? 0 }
        if has("credit|quota|usage limit|billing|balance|insufficient|余额|额度") { return "模型服务的额度已用完" }
        if status == 429 || has("rate.?limit|too many requests") { return "模型服务请求太频繁，被限流了" }
        if status == 401 || status == 403 || has("authentication|api key|unauthori[sz]ed|forbidden|permission") { return "模型服务的密钥无效或没有权限" }
        if has("context|too long|maximum.*tokens|prompt is too long") { return "对话内容超出了模型的上下文长度" }
        if status == 404 || has("model.*not.*(found|exist|available)") { return "找不到这个模型，请换一个模型" }
        if status == 529 || status >= 500 || has("overloaded|unavailable|internal server") { return "模型服务暂时不可用" }
        if has("timeout|timed out|ECONN|ENOTFOUND|network|fetch failed|socket") { return "连接不上模型服务" }
        return "模型服务返回了错误"
    }

    /// First line of a tool's input, cut for a one-line summary.
    public static func toolSummary(_ input: String, max: Int = 120) -> String {
        let line = input.trimmingCharacters(in: .whitespacesAndNewlines).split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).first.map(String.init) ?? ""
        return line.count > max ? String(line.prefix(max - 1)) + "…" : line
    }

    public static func toolStatusText(_ status: CliToolStatus) -> String {
        switch status { case .running: "运行中"; case .ok: "完成"; case .error: "失败" }
    }
}

// MARK: Requests

public struct CliRequestRecord: Sendable, Hashable, Identifiable {
    public var view: CliRequest
    public var closed: Bool
    /// What this app answered, when it was this app.
    public var decision: CliDecision?
    /// Allowed for the rest of the session.
    public var always: Bool
    public var by: CliResolvedBy?
    public var id: String { view.id }
    public init(view: CliRequest, closed: Bool = false, decision: CliDecision? = nil, always: Bool = false, by: CliResolvedBy? = nil) {
        self.view = view; self.closed = closed; self.decision = decision; self.always = always; self.by = by
    }
}

public enum CliCardState: String, Sendable { case pending, allowed, always, denied, answered, terminal, gone, expired
    public var text: String {
        switch self {
        case .pending: "等你处理"
        case .allowed: "已允许"
        case .always: "本会话已允许"
        case .denied: "已拒绝"
        case .answered: "已处理"
        case .terminal: "已在终端处理"
        case .gone: "会话已结束"
        case .expired: "已过期"
        }
    }
}

/// Pending permission and question requests per session. Value type; every change returns the new store.
public struct CliRequestStore: Sendable, Equatable {
    public static let expiryGraceMs = 5000
    public static let closedKeep = 10
    public private(set) var records: [CliSessionKey: [CliRequestRecord]] = [:]
    public init() {}

    private mutating func put(_ key: CliSessionKey, _ list: [CliRequestRecord]) {
        if list.isEmpty { records[key] = nil; return }
        let closed = list.filter(\.closed)
        if closed.count <= Self.closedKeep { records[key] = list; return }
        let drop = Set(closed.prefix(closed.count - Self.closedKeep).map(\.id))
        records[key] = list.filter { !(drop.contains($0.id) && $0.closed) }
    }

    /// `requests` of a session is its whole pending list: it replaces the open cards. A card this app closed stays closed.
    public mutating func setPending(_ key: CliSessionKey, _ views: [CliRequest]) {
        let closed = (records[key] ?? []).filter(\.closed)
        let seen = Set(closed.map(\.id))
        let open = views.filter { !seen.contains($0.id) && $0.key == key }.map { CliRequestRecord(view: $0) }
        put(key, closed + open)
    }

    /// Adds the pending requests of an HTTP answer. Never removes: a push may have arrived on the way.
    public mutating func mergePending(_ views: [CliRequest]) {
        for view in views {
            let current = records[view.key] ?? []
            if current.contains(where: { $0.id == view.id }) { continue }
            put(view.key, current + [CliRequestRecord(view: view)])
        }
    }

    /// A fresh list subscription follows with the pending cards of every session that has any, so what was open is stale.
    public mutating func dropOpen() {
        var next: [CliSessionKey: [CliRequestRecord]] = [:]
        for (key, list) in records { let closed = list.filter(\.closed); if !closed.isEmpty { next[key] = closed } }
        records = next
    }

    private mutating func close(_ key: CliSessionKey, _ id: String, by: CliResolvedBy?, decision: CliDecision?, always: Bool = false) {
        guard let list = records[key], let at = list.firstIndex(where: { $0.id == id && !$0.closed }) else { return }
        var record = list[at]
        record.closed = true; record.by = by; record.decision = decision; record.always = always && decision == .allow
        var rest = list; rest.remove(at: at)
        put(key, rest + [record])
    }

    public mutating func resolve(_ key: CliSessionKey, _ id: String, by: CliResolvedBy) {
        if records[key]?.first(where: { $0.id == id })?.closed == true { return }
        close(key, id, by: by, decision: nil)
    }

    public mutating func markAnswered(_ key: CliSessionKey, _ id: String, _ decision: CliDecision, always: Bool = false) {
        close(key, id, by: .nexbot, decision: decision, always: always)
    }

    public static func state(of record: CliRequestRecord, now: Int) -> CliCardState {
        if !record.closed { return now > record.view.expiresAt + expiryGraceMs ? .expired : .pending }
        switch record.by {
        case .terminal?: return .terminal
        case .gone?: return .gone
        case .timeout?: return .expired
        default:
            if record.decision == .deny { return .denied }
            if record.decision == .allow { return record.view.kind == .question ? .answered : record.always ? .always : .allowed }
            return .answered
        }
    }

    public func pending(_ key: CliSessionKey, now: Int) -> [CliRequestRecord] {
        (records[key] ?? []).filter { Self.state(of: $0, now: now) == .pending }
    }

    /// Pending requests per session, for the list badges.
    public func counts(now: Int) -> [CliSessionKey: Int] {
        var out: [CliSessionKey: Int] = [:]
        for (key, list) in records { let n = list.filter { Self.state(of: $0, now: now) == .pending }.count; if n > 0 { out[key] = n } }
        return out
    }

    public func pendingViews(now: Int) -> [CliRequest] {
        records.values.flatMap { $0 }.filter { Self.state(of: $0, now: now) == .pending }.map(\.view)
    }

    /// The next moment (epoch ms) an open card flips to expired after `now`, or nil.
    public func nextExpiry(now: Int) -> Int? {
        var next: Int?
        for list in records.values {
            for r in list where !r.closed {
                let at = r.view.expiresAt + Self.expiryGraceMs + 1
                if at <= now { continue }
                if next == nil || at < next! { next = at }
            }
        }
        return next
    }

    // MARK: Questions

    /// Chosen labels per question index.
    public typealias Selection = [Int: [String]]

    public static func toggle(_ selection: Selection, index: Int, label: String, multi: Bool) -> Selection {
        var next = selection
        let chosen = selection[index] ?? []
        if !multi { next[index] = [label] }
        else { next[index] = chosen.contains(label) ? chosen.filter { $0 != label } : chosen + [label] }
        return next
    }

    public static func answersComplete(_ questions: [CliQuestion]?, _ selection: Selection) -> Bool {
        guard let questions, !questions.isEmpty else { return false }
        return questions.indices.allSatisfy { !(selection[$0] ?? []).isEmpty }
    }

    /// The `answers` Core takes: the question text to the chosen label, several labels joined by ", ".
    public static func answers(_ questions: [CliQuestion], _ selection: Selection) -> [String: String] {
        var out: [String: String] = [:]
        for (index, q) in questions.enumerated() {
            out[q.question] = q.options.map(\.label).filter { selection[index]?.contains($0) == true }.joined(separator: ", ")
        }
        return out
    }
}

// MARK: Notifications

public enum CliNotify {
    static let bodyMax = 80

    /// Sessions waiting now that were not before. Nothing on the first list (`previous` nil).
    public static func newlyWaiting(previous: [CliSessionKey: CliSessionState]?, sessions: [CliSession]) -> [CliSession] {
        guard let previous else { return [] }
        return sessions.filter { $0.online && !$0.hidden && $0.state == .waiting && previous[$0.key] != .waiting }
    }

    public static func states(_ sessions: [CliSession]) -> [CliSessionKey: CliSessionState] {
        Dictionary(sessions.map { ($0.key, $0.state) }, uniquingKeysWith: { _, b in b })
    }

    /// Requests pending now that were not before; nothing on the first look.
    public static func newRequests(previous: Set<String>?, pending: [CliRequest]) -> [CliRequest] {
        guard let previous else { return [] }
        return pending.filter { !previous.contains($0.id) }
    }

    /// The tool and what it wants, or the first question, on one line of at most 80 characters.
    public static func requestBody(_ r: CliRequest) -> String {
        let text: String
        if r.kind == .question, let q = r.questions?.first?.question, !q.isEmpty { text = q }
        else if r.kind == .question { text = r.summary }
        else { text = "\(r.tool) \(r.summary)" }
        let line = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if line.isEmpty { return "等你处理" }
        return line.count > bodyMax ? String(line.prefix(bodyMax - 1)) + "…" : line
    }
}

// MARK: Terminal

public enum CliTermMode: String, Sendable { case observe, control }
public enum CliTermPhase: String, Sendable { case idle, observing, controlling, reconnecting, closed }
public enum CliTermStatus: String, Sendable {
    case connecting, reconnecting, observing, controlling, closed
    public var text: String {
        switch self {
        case .connecting: "正在连接"
        case .reconnecting: "正在重新连接"
        case .observing: "只看"
        case .controlling: "操作中"
        case .closed: "已结束"
        }
    }
}

public struct CliTermState: Sendable, Equatable {
    public var phase: CliTermPhase = .idle
    /// The mode the user wants; follows the server when it answers differently.
    public var want: CliTermMode = .observe
    /// The view should send `term.open` as soon as the socket is up.
    public var needsOpen = false
    /// Id of the `term.open` waiting for its `term.opened`.
    public var req: String?
    public var sid: UInt32?
    public var mode: CliTermMode?
    public var cols = 0
    public var rows = 0
    public var reason: String?
    public var errorCode: String?

    public init(want: CliTermMode = .observe) { self.want = want }

    public enum Event: Sendable {
        case start(CliTermMode?)
        case requested(String)
        case opened(req: String, sid: UInt32, cols: Int, rows: Int, observe: Bool)
        case size(sid: UInt32, cols: Int, rows: Int)
        case closed(sid: UInt32, reason: String)
        case error(code: String, req: String?)
        case disconnected
        case mode(CliTermMode)
        case stop
    }

    /// Reasons after which Core wants the client to open the stream again.
    static let reopenReasons: Set<String> = ["overflow"]

    public mutating func apply(_ event: Event) {
        switch event {
        case .start(let want):
            var fresh = CliTermState(want: want ?? self.want); fresh.needsOpen = true; self = fresh
        case .stop:
            self = CliTermState(want: want)
        case .requested(let req):
            needsOpen = false; self.req = req; errorCode = nil
        case .opened(let req, let sid, let cols, let rows, let observe):
            guard req == self.req else { return }
            let mode: CliTermMode = observe ? .observe : .control
            phase = mode == .observe ? .observing : .controlling
            want = mode; needsOpen = false; self.req = nil; self.sid = sid; self.mode = mode; self.cols = cols; self.rows = rows
            reason = nil; errorCode = nil
        case .size(let sid, let cols, let rows):
            if sid == self.sid { self.cols = cols; self.rows = rows }
        case .closed(let sid, let reason):
            guard sid == self.sid else { return }
            if Self.reopenReasons.contains(reason) { phase = .reconnecting; needsOpen = true; req = nil; self.sid = nil; mode = nil; self.reason = nil }
            else { phase = .closed; needsOpen = false; req = nil; self.sid = nil; mode = nil; self.reason = reason }
        case .error(let code, let req):
            if let req {
                guard req == self.req else { return }
                phase = .closed; needsOpen = false; self.req = nil; errorCode = code
            } else { errorCode = code }
        case .disconnected:
            let live = sid != nil || req != nil
            if !live && phase != .reconnecting { return }
            phase = .reconnecting; needsOpen = true; req = nil; sid = nil; mode = nil
        case .mode(let want):
            if want == self.want && sid != nil { return }
            phase = .idle; self.want = want; needsOpen = true; req = nil; sid = nil; mode = nil; errorCode = nil
        }
    }

    public func status(connected: Bool) -> CliTermStatus {
        if phase == .closed { return .closed }
        if phase == .reconnecting || (!connected && phase != .idle) { return .reconnecting }
        if phase == .observing { return .observing }
        if phase == .controlling { return .controlling }
        return connected ? .connecting : .reconnecting
    }

    public static func closeReasonText(_ reason: String?) -> String {
        guard let reason, !reason.isEmpty else { return "" }
        switch reason {
        case "exited": return "程序已退出"
        case "device_offline": return "电脑离线"
        case "paused": return "本机控制已暂停"
        case "disabled": return "Agent 会话已关闭"
        case "closed": return "已关闭"
        default: return "终端已断开"
        }
    }

    /// Terminal limits of Core: 20-500 columns, 5-200 rows, 120 x 36 by default.
    public static func clampSize(cols: Int?, rows: Int?) -> (cols: Int, rows: Int) {
        (min(500, max(20, cols ?? 120)), min(200, max(5, rows ?? 36)))
    }
}

/// Counts bytes the terminal has finished drawing and hands them back in `chunk` sized credits, so the device only sends
/// as fast as the view draws.
public struct CliCreditMeter: Sendable {
    public static let chunk = 32 * 1024
    public private(set) var pending = 0
    public init() {}
    /// Returns the credit to send, if the chunk is full.
    public mutating func wrote(_ bytes: Int) -> Int? {
        pending += bytes
        guard pending >= Self.chunk else { return nil }
        let grant = pending; pending = 0; return grant
    }
}

import Foundation

// Multi-agent collaboration ("协作", code name `team`) models, wire parsers, transcript card
// extraction and lead/worker lookup indexes. Ported from `shared/cli-team.ts` and `src/personal/cli-agents/team.ts`.

public enum CliTeamRunStatus: String, Codable, Sendable, Hashable {
    case active, paused, finished, cancelled

    public var label: String {
        switch self {
        case .active: "进行中"
        case .paused: "已暂停"
        case .finished: "已完成"
        case .cancelled: "已结束"
        }
    }

    public var isLive: Bool { self == .active || self == .paused }
}

public enum CliTeamWorkerStatus: String, Codable, Sendable, Hashable {
    case starting, running, waiting, reported, stopped, failed

    public var label: String {
        switch self {
        case .starting: "启动中"
        case .running: "工作中"
        case .waiting: "等你处理"
        case .reported: "已汇报"
        case .stopped: "已停止"
        case .failed: "失败"
        }
    }

    public var isLive: Bool { self == .starting || self == .running || self == .waiting }
    public var isWorking: Bool { self == .starting || self == .running }
    /// Failed collaborators are hidden from UI lists/panels while kept in the ledger for auditing.
    public var isVisible: Bool { self != .failed }
}

public enum CliTeamDispatchMode: String, Codable, Sendable, Hashable, CaseIterable {
    case prompt, auto, off

    public var label: String {
        switch self {
        case .prompt: "用户提出时"
        case .auto: "Agent 可自行派活"
        case .off: "关闭"
        }
    }

    public var hint: String {
        switch self {
        case .prompt: "你在对话中提出协作后，由主会话自行拆解和派活"
        case .auto: "主会话认为需要时，可主动开启协作并派活"
        case .off: "禁止所有会话派活"
        }
    }
}

public struct CliTeamFindingCount: Sendable, Hashable, Codable, Identifiable {
    public var severity: String
    public var label: String
    public var count: Int
    public var id: String { severity }

    public init(severity: String, label: String, count: Int) {
        self.severity = severity; self.label = label; self.count = count
    }
}

public struct CliTeamFinding: Sendable, Hashable, Codable, Identifiable {
    public var severity: String
    public var file: String
    public var line: Int?
    public var issue: String
    public var id: String { "\(file):\(line ?? -1):\(issue.prefix(32))" }

    public var severityLabel: String {
        CliTeamBriefing.normalizeFindingSeverity(severity).label
    }

    public init(severity: String = "medium", file: String, line: Int? = nil, issue: String) {
        self.severity = severity; self.file = file; self.line = line; self.issue = issue
    }
}

/// Concise report/review briefing extraction ported from `shared/cli-team.ts`.
public enum CliTeamBriefing {
    private static let severityOrder: [String: Int] = [
        "p0": 0, "p1": 1, "p2": 2, "p3": 3, "high": 4, "medium": 5, "low": 6,
    ]
    private static let teamHeaderPattern = #"^\s*\[NexAgent team\]\s+From\s+[^\n]+(?:\r?\n)*"#
    private static let teamFooterPattern = #"(?:\r?\n)+(?:如需跟进请运行|如果修改请运行|主控提示（|答复方式：|完成后请(?:再次)?运行|全部完成后运行)[^\n]*\s*$"#
    private static let reviewStopHeadingPattern = #"^(?:#{1,6}\s*|\*\*)?(?:验证范围|测试范围|测试情况|测试结果|复现环境|环境说明|验证记录|检查范围|详细过程|详细日志|verification(?:\s+scope)?|test(?:ing)?(?:\s+scope|\s+plan)?|environment)\b"#
    private static let reportStopHeadingPattern = #"^(?:#{1,6}\s*|\*\*)?(?:验证范围|详细日志|完整输出|修改细节|verification(?:\s+scope)?|detailed\s+logs?|raw\s+output)\b"#
    private static let findingLinePattern = #"^\s*(?:\d+[.)、]|[-*•])\s*(?:\*\*)?(?:\[(P[0-3]|critical|high|medium|low|阻塞|严重|高|中|低)\]|(P[0-3]|critical|high|medium|low)(?=(?:\*\*)?[\s:：\-–—）)\u4e00-\u9fff])|(阻塞|严重|高|中|低)(?=优先级|(?:\*\*)?[\s:：\-–—）)]))"#
    private static let conclusionLinePattern = #"^(?:\*\*)?(?:交付结论|审查结论|复审结论|总体结论|结论|摘要|简报|总结|summary|verdict|conclusion)\s*[:：]\s*(.+)$"#

    public static func normalizeFindingSeverity(_ raw: String) -> (severity: String, label: String) {
        let clean = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch clean {
        case "p0", "critical", "blocker", "阻塞": return ("p0", "P0")
        case "p1", "严重": return ("p1", "P1")
        case "p2": return ("p2", "P2")
        case "p3": return ("p3", "P3")
        case "high", "高": return ("high", "高")
        case "medium", "中": return ("medium", "中")
        case "low", "低": return ("low", "低")
        default:
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            return (clean.isEmpty ? "medium" : clean, trimmed.isEmpty ? "中" : trimmed.uppercased())
        }
    }

    /// Strips machine-directed `[NexAgent team] From ...` headers and LLM command-hint footers.
    public static func stripFraming(_ text: String) -> String {
        var out = text.trimmingCharacters(in: .whitespacesAndNewlines)
        out = out.replacingOccurrences(of: teamHeaderPattern, with: "", options: .regularExpression)
        for _ in 0..<3 {
            let next = out.replacingOccurrences(of: teamFooterPattern, with: "", options: .regularExpression)
            if next == out { break }
            out = next
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func stripMarkdownLine(_ line: String) -> String {
        line
            .replacingOccurrences(of: #"^\s*#{1,6}\s+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\*\*([^*]+)\*\*"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"__([^_]+)__"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"`([^`]+)`"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func clip(_ text: String, max: Int) -> String {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard clean.count > max else { return clean }
        let prefix = String(clean.prefix(max - 1))
        let trimmedEnd = prefix.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression)
        return trimmedEnd + "…"
    }

    public static func summarizeFindingCounts(findings: [CliTeamFinding] = [], fallbackText: String? = nil) -> [CliTeamFindingCount] {
        var counts: [String: CliTeamFindingCount] = [:]
        func add(_ raw: String) {
            let norm = normalizeFindingSeverity(raw)
            if var existing = counts[norm.severity] {
                existing.count += 1
                counts[norm.severity] = existing
            } else {
                counts[norm.severity] = CliTeamFindingCount(severity: norm.severity, label: norm.label, count: 1)
            }
        }
        if !findings.isEmpty {
            for f in findings { add(f.severity.isEmpty ? "medium" : f.severity) }
        } else if let fallbackText, !fallbackText.isEmpty {
            let cleaned = stripFraming(fallbackText)
            let stopRe = try? NSRegularExpression(pattern: reviewStopHeadingPattern, options: .caseInsensitive)
            let findRe = try? NSRegularExpression(pattern: findingLinePattern, options: .caseInsensitive)
            var inCode = false
            for rawLine in cleaned.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
                let line = String(rawLine)
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("```") { inCode.toggle(); continue }
                if inCode { continue }
                if let stopRe, stopRe.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)) != nil { break }
                if let findRe, let m = findRe.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) {
                    for g in 1...3 {
                        if let r = Range(m.range(at: g), in: line) {
                            add(String(line[r]))
                            break
                        }
                    }
                }
            }
        }
        return counts.values.sorted { a, b in
            let oa = severityOrder[a.severity] ?? 99
            let ob = severityOrder[b.severity] ?? 99
            if oa != ob { return oa < ob }
            return a.label.localizedStandardCompare(b.label) == .orderedAscending
        }
    }

    public static func formatFindingCountsSummary(_ counts: [CliTeamFindingCount]) -> String {
        guard !counts.isEmpty else { return "未发现问题" }
        let parts = counts.map { entry -> String in
            let isP = entry.label.range(of: #"^P\d$"#, options: [.regularExpression, .caseInsensitive]) != nil
            return isP ? "\(entry.count) 个 \(entry.label)" : "\(entry.count) 个\(entry.label)优先级"
        }
        return "发现 \(parts.joined(separator: "、"))问题"
    }

    public static func buildReportBrief(
        brief: String?,
        body: String?,
        findings: [CliTeamFinding],
        isReview: Bool,
        outcome: String?
    ) -> (brief: String, findingCounts: [CliTeamFindingCount]) {
        let cleanedBody = body.map(stripFraming) ?? ""
        let findingCounts = summarizeFindingCounts(findings: findings, fallbackText: isReview ? cleanedBody : nil)

        let explicit = brief.map(stripFraming) ?? ""
        if !explicit.isEmpty {
            let lines = explicit
                .split(whereSeparator: \.isNewline)
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
                .prefix(4)
            return (clip(lines.joined(separator: "\n"), max: 320), findingCounts)
        }

        let stopRe = try? NSRegularExpression(pattern: isReview ? reviewStopHeadingPattern : reportStopHeadingPattern, options: .caseInsensitive)
        let findRe = try? NSRegularExpression(pattern: findingLinePattern, options: .caseInsensitive)
        let conclRe = try? NSRegularExpression(pattern: conclusionLinePattern, options: .caseInsensitive)

        var contentLines: [String] = []
        var inCode = false
        for raw in cleanedBody.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") { inCode.toggle(); continue }
            if inCode || trimmed.isEmpty { continue }
            if let stopRe, stopRe.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)) != nil { break }
            contentLines.append(trimmed)
        }

        func conclusionText(_ line: String) -> String? {
            guard let conclRe, let m = conclRe.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
                  let r = Range(m.range(at: 1), in: line) else { return nil }
            let val = line[r].trimmingCharacters(in: .whitespaces)
            return val.isEmpty ? nil : val
        }

        func isFindingLine(_ line: String) -> Bool {
            guard let findRe else { return false }
            return findRe.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil
        }

        if isReview {
            for line in contentLines {
                let clean = stripMarkdownLine(line)
                if let verdict = conclusionText(clean) {
                    return (clip(verdict, max: 160), findingCounts)
                }
            }
            let proseCandidates = contentLines.filter { $0.range(of: #"^#{1,6}\s"#, options: .regularExpression) == nil && !isFindingLine($0) }
            if let prose = proseCandidates.first {
                let clean = stripMarkdownLine(prose)
                let nextProse = proseCandidates.dropFirst().first
                let hasPunct = clean.range(of: #"[。！？.!?]"#, options: .regularExpression) != nil
                let chosen = (clean.count <= 24 && !hasPunct && nextProse != nil) ? stripMarkdownLine(nextProse!) : clean
                if !chosen.isEmpty { return (clip(chosen, max: 160), findingCounts) }
            }
            if !findingCounts.isEmpty {
                return ("\(formatFindingCountsSummary(findingCounts))，详情可点进会话查看。", findingCounts)
            }
            let fallback = contentLines.first.map(stripMarkdownLine) ?? ""
            let chosen = !fallback.isEmpty ? fallback : (outcome == "failed" ? "审查未能完成" : "审查完成，未发现阻塞问题。")
            return (clip(chosen, max: 160), findingCounts)
        }

        var picked: [String] = []
        for (i, line) in contentLines.enumerated() {
            let isHeading = line.range(of: #"^#{1,6}\s"#, options: .regularExpression) != nil
            let clean = stripMarkdownLine(line)
            if clean.isEmpty { continue }
            if isHeading && i == 0 && contentLines.count > 1 { continue }
            if isHeading {
                if !picked.isEmpty { break }
                continue
            }
            let bulletPrefix = #"^\s*(?:[-*•]|\d+[.)、])\s+"#
            if line.range(of: bulletPrefix, options: .regularExpression) != nil {
                let bulletBody = stripMarkdownLine(line.replacingOccurrences(of: bulletPrefix, with: "", options: .regularExpression))
                if bulletBody.isEmpty { continue }
                let firstSentence = firstSentenceOf(bulletBody)
                picked.append("- \(clip(firstSentence, max: 90))")
            } else {
                let sentence = conclusionText(clean) ?? clean
                picked.append(clip(sentence, max: 140))
            }
            if picked.count >= 3 { break }
        }
        let joined = picked.joined(separator: "\n")
        let fallback = outcome == "failed" ? "任务执行失败" : "任务已完成。"
        return (clip(joined.isEmpty ? fallback : joined, max: 280), findingCounts)
    }

    private static func firstSentenceOf(_ text: String) -> String {
        if let r = text.range(of: #"(?:[。！？；]\s*|[.!?]\s+)"#, options: .regularExpression) {
            return String(text[..<r.upperBound]).trimmingCharacters(in: .whitespaces)
        }
        return text
    }
}

public struct CliTeamWorkerView: Sendable, Hashable, Identifiable, Decodable {
    public var id: String
    public var runId: String
    public var name: String
    public var engine: CliEngine
    public var sessionKey: CliSessionKey?
    public var cwd: String
    public var role: String?
    public var title: String
    public var permissions: CliPermissionMode
    public var model: String?
    public var status: CliTeamWorkerStatus
    public var summary: String?
    public var findingsCount: Int?
    public var unreadCount: Int?
    public var context: CliContextUsage?
    public var createdAt: Int
    public var updatedAt: Int
    public var isVisible: Bool { status.isVisible }

    public init(id: String, runId: String, name: String, engine: CliEngine, sessionKey: CliSessionKey? = nil, cwd: String = "",
                role: String? = nil, title: String = "", permissions: CliPermissionMode = .full, model: String? = nil,
                status: CliTeamWorkerStatus = .stopped, summary: String? = nil, findingsCount: Int? = nil, unreadCount: Int? = nil,
                context: CliContextUsage? = nil, createdAt: Int = 0, updatedAt: Int = 0) {
        self.id = id; self.runId = runId; self.name = name; self.engine = engine; self.sessionKey = sessionKey; self.cwd = cwd
        self.role = role; self.title = title.isEmpty ? name : title; self.permissions = permissions; self.model = model
        self.status = status; self.summary = summary; self.findingsCount = findingsCount; self.unreadCount = unreadCount
        self.context = context; self.createdAt = createdAt; self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case id, runId, name, engine, sessionKey, cwd, role, title, permissions, model, status, summary, findingsCount, unreadCount, context, createdAt, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = String((try c.decode(String.self, forKey: .id)).prefix(128))
        runId = String((try c.decode(String.self, forKey: .runId)).prefix(128))
        name = String((try c.decode(String.self, forKey: .name)).prefix(64))
        engine = try c.decode(CliEngine.self, forKey: .engine)
        let rawKey = try? c.decodeIfPresent(String.self, forKey: .sessionKey)
        sessionKey = (rawKey?.split(separator: ":").count == 3) ? rawKey : nil
        cwd = (try? c.decodeIfPresent(String.self, forKey: .cwd)) ?? ""
        let rawRole = (try? c.decodeIfPresent(String.self, forKey: .role))?.trimmingCharacters(in: .whitespacesAndNewlines)
        role = rawRole?.isEmpty == false ? String(rawRole!.prefix(40)) : nil
        let rawTitle = (try? c.decodeIfPresent(String.self, forKey: .title))?.trimmingCharacters(in: .whitespacesAndNewlines)
        title = rawTitle?.isEmpty == false ? String(rawTitle!.prefix(200)) : name
        permissions = (try? c.decodeIfPresent(String.self, forKey: .permissions)).flatMap(CliPermissionMode.init(rawValue:)) ?? .full
        let rawModel = (try? c.decodeIfPresent(String.self, forKey: .model))?.trimmingCharacters(in: .whitespacesAndNewlines)
        model = rawModel?.isEmpty == false ? String(rawModel!.prefix(200)) : nil
        status = (try? c.decodeIfPresent(CliTeamWorkerStatus.self, forKey: .status)) ?? .stopped
        let rawSummary = (try? c.decodeIfPresent(String.self, forKey: .summary))?.trimmingCharacters(in: .whitespacesAndNewlines)
        summary = rawSummary?.isEmpty == false ? String(rawSummary!.prefix(2000)) : nil
        if let n = try? c.decodeIfPresent(Int.self, forKey: .findingsCount), n >= 0 { findingsCount = n } else { findingsCount = nil }
        if let n = try? c.decodeIfPresent(Int.self, forKey: .unreadCount), n >= 0 { unreadCount = n } else { unreadCount = nil }
        context = try? c.decodeIfPresent(CliContextUsage.self, forKey: .context)
        createdAt = (try? c.decodeIfPresent(Int.self, forKey: .createdAt)) ?? 0
        updatedAt = (try? c.decodeIfPresent(Int.self, forKey: .updatedAt)) ?? 0
    }
}

public struct CliTeamRunView: Sendable, Hashable, Identifiable, Decodable {
    public var id: String
    public var leadKey: CliSessionKey
    public var title: String
    public var status: CliTeamRunStatus
    public var limit: Int
    public var limitHit: String?
    public var heldCount: Int?
    public var summary: String?
    public var workers: [CliTeamWorkerView]
    public var createdAt: Int
    public var updatedAt: Int
    public var finishedAt: Int?
    public var visibleWorkers: [CliTeamWorkerView] { workers.filter(\.isVisible) }

    public init(id: String, leadKey: CliSessionKey, title: String = "协作", status: CliTeamRunStatus = .active, limit: Int = 5,
                limitHit: String? = nil, heldCount: Int? = nil, summary: String? = nil, workers: [CliTeamWorkerView] = [],
                createdAt: Int = 0, updatedAt: Int = 0, finishedAt: Int? = nil) {
        self.id = id; self.leadKey = leadKey; self.title = title; self.status = status; self.limit = limit
        self.limitHit = limitHit; self.heldCount = heldCount; self.summary = summary; self.workers = workers
        self.createdAt = createdAt; self.updatedAt = updatedAt; self.finishedAt = finishedAt
    }

    enum CodingKeys: String, CodingKey {
        case id, leadKey, title, status, limit, limitHit, heldCount, summary, workers, createdAt, updatedAt, finishedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = String((try c.decode(String.self, forKey: .id)).prefix(128))
        leadKey = try c.decode(String.self, forKey: .leadKey)
        let rawTitle = (try? c.decodeIfPresent(String.self, forKey: .title))?.trimmingCharacters(in: .whitespacesAndNewlines)
        title = rawTitle?.isEmpty == false ? String(rawTitle!.prefix(200)) : "协作"
        status = (try? c.decodeIfPresent(CliTeamRunStatus.self, forKey: .status)) ?? .finished
        let rawLimit = (try? c.decodeIfPresent(Int.self, forKey: .limit)) ?? 5
        limit = max(1, min(20, rawLimit))
        let rawLimitHit = (try? c.decodeIfPresent(String.self, forKey: .limitHit))?.trimmingCharacters(in: .whitespacesAndNewlines)
        limitHit = rawLimitHit?.isEmpty == false ? String(rawLimitHit!.prefix(300)) : nil
        if let n = try? c.decodeIfPresent(Int.self, forKey: .heldCount), n > 0 { heldCount = n } else { heldCount = nil }
        let rawSummary = (try? c.decodeIfPresent(String.self, forKey: .summary))?.trimmingCharacters(in: .whitespacesAndNewlines)
        summary = rawSummary?.isEmpty == false ? String(rawSummary!.prefix(4000)) : nil
        workers = (try? c.decodeIfPresent(LossyList<CliTeamWorkerView>.self, forKey: .workers))?.values ?? []
        createdAt = (try? c.decodeIfPresent(Int.self, forKey: .createdAt)) ?? 0
        updatedAt = (try? c.decodeIfPresent(Int.self, forKey: .updatedAt)) ?? 0
        finishedAt = try? c.decodeIfPresent(Int.self, forKey: .finishedAt)
    }
}

public struct CliTeamLimits: Sendable, Hashable, Codable {
    public var mailPerHour: Int
    public var idlePauseHours: Int
    public var circuitBreakerFailures: Int

    public static let defaults = CliTeamLimits(mailPerHour: 60, idlePauseHours: 24, circuitBreakerFailures: 3)

    public init(mailPerHour: Int = 60, idlePauseHours: Int = 24, circuitBreakerFailures: Int = 3) {
        self.mailPerHour = max(1, mailPerHour)
        self.idlePauseHours = max(1, idlePauseHours)
        self.circuitBreakerFailures = max(1, circuitBreakerFailures)
    }

    enum CodingKeys: String, CodingKey { case mailPerHour, idlePauseHours, circuitBreakerFailures }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Self.defaults
        mailPerHour = max(1, (try? c.decodeIfPresent(Int.self, forKey: .mailPerHour)) ?? d.mailPerHour)
        idlePauseHours = max(1, (try? c.decodeIfPresent(Int.self, forKey: .idlePauseHours)) ?? d.idlePauseHours)
        circuitBreakerFailures = max(1, (try? c.decodeIfPresent(Int.self, forKey: .circuitBreakerFailures)) ?? d.circuitBreakerFailures)
    }
}

public struct CliTeamSettings: Sendable, Hashable, Decodable {
    public var dispatchMode: CliTeamDispatchMode
    public var maxWorkers: Int
    public var allowNexInAsk: Bool
    public var enabledEngines: [CliEngine]
    public var installedEngines: [CliEngine]
    public var defaultPermissions: [String: String]
    public var limits: CliTeamLimits

    public static let defaults = CliTeamSettings(
        dispatchMode: .prompt,
        maxWorkers: 5,
        allowNexInAsk: true,
        enabledEngines: [.claude, .codex, .agy],
        installedEngines: [.claude, .codex, .agy],
        defaultPermissions: ["claude": "default", "codex": "default", "agy": "default"],
        limits: .defaults
    )

    public init(dispatchMode: CliTeamDispatchMode = .prompt, maxWorkers: Int = 5, allowNexInAsk: Bool = true,
                enabledEngines: [CliEngine] = [.claude, .codex, .agy], installedEngines: [CliEngine] = [.claude, .codex, .agy],
                defaultPermissions: [String: String] = [:], limits: CliTeamLimits = .defaults) {
        self.dispatchMode = dispatchMode
        self.maxWorkers = max(1, min(10, maxWorkers))
        self.allowNexInAsk = allowNexInAsk
        self.enabledEngines = enabledEngines
        self.installedEngines = installedEngines
        self.defaultPermissions = defaultPermissions
        self.limits = limits
    }

    enum CodingKeys: String, CodingKey {
        case dispatchMode, maxWorkers, allowNexInAsk, allowNexagentInAsk, enabledEngines, installedEngines, defaultPermissions, limits
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Self.defaults
        dispatchMode = (try? c.decodeIfPresent(CliTeamDispatchMode.self, forKey: .dispatchMode)) ?? d.dispatchMode
        maxWorkers = max(1, min(10, (try? c.decodeIfPresent(Int.self, forKey: .maxWorkers)) ?? d.maxWorkers))
        if let v = try? c.decodeIfPresent(Bool.self, forKey: .allowNexInAsk) {
            allowNexInAsk = v
        } else if let v = try? c.decodeIfPresent(Bool.self, forKey: .allowNexagentInAsk) {
            allowNexInAsk = v
        } else {
            allowNexInAsk = d.allowNexInAsk
        }
        let installed = (try? c.decodeIfPresent(LossyList<CliEngine>.self, forKey: .installedEngines))?.values ?? d.installedEngines
        installedEngines = installed
        enabledEngines = (try? c.decodeIfPresent(LossyList<CliEngine>.self, forKey: .enabledEngines))?.values ?? installed
        defaultPermissions = (try? c.decodeIfPresent([String: String].self, forKey: .defaultPermissions)) ?? d.defaultPermissions
        limits = (try? c.decodeIfPresent(CliTeamLimits.self, forKey: .limits)) ?? .defaults
    }
}

public struct CliTeamSettingsPatch: Encodable, Sendable {
    public var dispatchMode: CliTeamDispatchMode?
    public var maxWorkers: Int?
    public var allowNexInAsk: Bool?
    public var enabledEngines: [CliEngine]?

    public init(dispatchMode: CliTeamDispatchMode? = nil, maxWorkers: Int? = nil, allowNexInAsk: Bool? = nil, enabledEngines: [CliEngine]? = nil) {
        self.dispatchMode = dispatchMode
        self.maxWorkers = maxWorkers
        self.allowNexInAsk = allowNexInAsk
        self.enabledEngines = enabledEngines
    }
}

// MARK: Lead / Worker Index

public struct CliTeamWorkerBinding: Sendable, Hashable {
    public var run: CliTeamRunView
    public var worker: CliTeamWorkerView
    public var isActiveRun: Bool
    public var inPrimaryGroup: Bool
}

public struct CliTeamIndex: Sendable {
    public let runs: [CliTeamRunView]
    public let runsByLead: [CliSessionKey: [CliTeamRunView]]
    public let activeRunByLead: [CliSessionKey: CliTeamRunView]
    public let workerBySession: [CliSessionKey: CliTeamWorkerBinding]
    public let workerKeysByLead: [CliSessionKey: [CliSessionKey]]

    public static let empty = CliTeamIndex(runs: [], runsByLead: [:], activeRunByLead: [:], workerBySession: [:], workerKeysByLead: [:])

    public static func build(_ runs: [CliTeamRunView]) -> CliTeamIndex {
        var byLead: [CliSessionKey: [CliTeamRunView]] = [:]
        var activeByLead: [CliSessionKey: CliTeamRunView] = [:]
        var workerBySession: [CliSessionKey: CliTeamWorkerBinding] = [:]
        var workerKeysByLead: [CliSessionKey: [CliSessionKey]] = [:]

        for run in runs {
            byLead[run.leadKey, default: []].append(run)
        }
        for (leadKey, var list) in byLead {
            list.sort { a, b in
                let la = a.status.isLive ? 1 : 0, lb = b.status.isLive ? 1 : 0
                if la != lb { return la > lb }
                let ta = a.finishedAt ?? a.updatedAt, tb = b.finishedAt ?? b.updatedAt
                if ta != tb { return ta > tb }
                return a.createdAt > b.createdAt
            }
            byLead[leadKey] = list
            let active = list.first { $0.status.isLive }
            if let active { activeByLead[leadKey] = active }
            let primaryRunId = active?.id ?? list.first?.id
            var keys: [CliSessionKey] = []
            for run in list {
                for worker in run.workers {
                    guard let sk = worker.sessionKey, !sk.isEmpty else { continue }
                    keys.append(sk)
                    workerBySession[sk] = CliTeamWorkerBinding(
                        run: run,
                        worker: worker,
                        isActiveRun: run.id == active?.id,
                        inPrimaryGroup: run.id == primaryRunId
                    )
                }
            }
            workerKeysByLead[leadKey] = keys
        }
        return CliTeamIndex(runs: runs, runsByLead: byLead, activeRunByLead: activeByLead, workerBySession: workerBySession, workerKeysByLead: workerKeysByLead)
    }

    public func activeWorkingWorkers(
        for leadKey: CliSessionKey,
        sessionsByKey: [CliSessionKey: CliSession],
        pending: [CliSessionKey: Int] = [:]
    ) -> (working: Int, waiting: Int) {
        guard let run = activeRunByLead[leadKey], run.status.isLive else { return (0, 0) }
        var working = 0
        var waiting = 0
        for worker in run.workers {
            guard worker.isVisible else { continue }
            let session = worker.sessionKey.flatMap { sessionsByKey[$0] }
            let hasPending = worker.sessionKey.map { (pending[$0] ?? 0) > 0 } ?? false
            if hasPending || worker.status == .waiting || (session?.online == true && session?.state == .waiting) {
                waiting += 1
            } else if worker.status.isWorking || (session?.online == true && session?.state == .running) {
                working += 1
            }
        }
        return (working, waiting)
    }
}

// MARK: Transcript Collaboration Cards

public enum CliTeamCardKind: String, Sendable, Hashable, Codable {
    case task, report, review, followup, question, answer, nudge, escalation, done

    public var badge: String {
        switch self {
        case .task: "派发"
        case .report: "汇报"
        case .review: "审查"
        case .followup: "修改"
        case .question: "提问"
        case .answer: "答复"
        case .nudge: "催促"
        case .escalation: "异常"
        case .done: "交付"
        }
    }

    public var typeLabel: String {
        switch self {
        case .task: "任务派发"
        case .report: "完成报告"
        case .review: "审查结果"
        case .followup: "修改要求"
        case .question: "提问"
        case .answer: "答复"
        case .nudge: "催促汇报"
        case .escalation: "异常升级"
        case .done: "交付摘要"
        }
    }
}

public struct CliTeamCard: Sendable, Hashable {
    public var kind: CliTeamCardKind
    public var heading: String
    public var subtitle: String?
    public var actorEngine: CliEngine?
    public var actorLabel: String?
    public var targetEngine: CliEngine?
    public var targetLabel: String?
    public var targetSessionKey: CliSessionKey?
    public var sourceSessionKey: CliSessionKey?
    public var role: String?
    public var outcome: String? // "succeeded" | "failed"
    public var brief: String?
    public var findingCounts: [CliTeamFindingCount] = []
    public var body: String?
    public var files: [String]
    public var findings: [CliTeamFinding]

    public var jumpKey: CliSessionKey? { sourceSessionKey ?? targetSessionKey }

    public static func parse(_ text: String) -> CliTeamCard? {
        if let envelope = matchEnvelope(text) { return envelope }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let plain = matchPlainHead(trimmed) { return plain }
        if let nudge = matchNudge(trimmed) { return nudge }
        if trimmed.range(of: #"^\[NexAgent\]\s+The lead assigned you a task\."#, options: .regularExpression) != nil {
            return CliTeamCard(kind: .task, heading: "主会话 · 已派发任务", subtitle: "通过 nex task 读取任务说明", files: [], findings: [])
        }
        if let regex = try? NSRegularExpression(pattern: #"^\[NexAgent\]\s+You have (\d+) new team messages?\."#),
           let m = regex.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)),
           let r = Range(m.range(at: 1), in: trimmed) {
            return CliTeamCard(kind: .nudge, heading: "协作通知 · \(trimmed[r]) 条新消息", subtitle: "通过 nex inbox 读取", files: [], findings: [])
        }
        return nil
    }

    private static func parseFindingCounts(_ raw: Any?) -> [CliTeamFindingCount]? {
        guard let arr = raw as? [[String: Any]] else { return nil }
        var out: [CliTeamFindingCount] = []
        for entry in arr.prefix(20) {
            guard let sev = entry["severity"] as? String,
                  let countNum = entry["count"] as? NSNumber,
                  countNum.doubleValue.isFinite, countNum.doubleValue > 0 else { continue }
            let norm = CliTeamBriefing.normalizeFindingSeverity(sev)
            let customLabel = (entry["label"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let label = (customLabel?.isEmpty == false) ? String(customLabel!.prefix(16)) : norm.label
            out.append(CliTeamFindingCount(severity: norm.severity, label: label, count: Int(countNum.doubleValue.rounded())))
        }
        return out.isEmpty ? nil : out
    }

    private static func matchEnvelope(_ text: String) -> CliTeamCard? {
        guard let regex = try? NSRegularExpression(pattern: #"^\s*<!--\s*nexagent-team:([\s\S]*?)-->\s*([\s\S]*)$"#),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let metaRange = Range(match.range(at: 1), in: text),
              let bodyRange = Range(match.range(at: 2), in: text) else { return nil }
        let metaText = text[metaRange].trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = metaText.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let kindRaw = obj["kind"] as? String,
              let kind = CliTeamCardKind(rawValue: kindRaw),
              let heading = obj["heading"] as? String else { return nil }
        let trailingBody = text[bodyRange].trimmingCharacters(in: .whitespacesAndNewlines)
        let metaBody = (obj["body"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let rawBody = !trailingBody.isEmpty ? trailingBody : (metaBody?.isEmpty == false ? metaBody : nil)
        let cleanedBody = rawBody.map(CliTeamBriefing.stripFraming).flatMap { $0.isEmpty ? nil : $0 }
        let subtitle = (obj["subtitle"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let findings: [CliTeamFinding] = ((obj["findings"] as? [[String: Any]]) ?? []).compactMap { entry in
            guard let file = entry["file"] as? String, let issue = entry["issue"] as? String else { return nil }
            let sev = (entry["severity"] as? String) ?? "medium"
            let line = entry["line"] as? Int
            return CliTeamFinding(severity: sev, file: file, line: line, issue: issue)
        }
        let files = ((obj["files"] as? [String]) ?? []).filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        func validKey(_ raw: Any?) -> CliSessionKey? {
            guard let s = raw as? String, s.split(separator: ":").count == 3 else { return nil }
            return s
        }
        let outcomeRaw = obj["outcome"] as? String
        let outcome = (outcomeRaw == "succeeded" || outcomeRaw == "failed") ? outcomeRaw : nil
        let explicitBrief = (obj["brief"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        let metaCounts = parseFindingCounts(obj["findingCounts"])
        let isReportLike = kind == .report || kind == .review
        let summary = isReportLike
            ? CliTeamBriefing.buildReportBrief(brief: explicitBrief, body: cleanedBody, findings: findings, isReview: kind == .review, outcome: outcome)
            : nil
        let findingCounts = metaCounts ?? summary?.findingCounts ?? []
        let brief = summary?.brief.nilIfEmpty ?? explicitBrief
        return CliTeamCard(
            kind: kind,
            heading: heading,
            subtitle: subtitle?.isEmpty == false ? subtitle : nil,
            actorEngine: (obj["actorEngine"] as? String).flatMap(CliEngine.init(rawValue:)),
            actorLabel: obj["actorLabel"] as? String,
            targetEngine: (obj["targetEngine"] as? String).flatMap(CliEngine.init(rawValue:)),
            targetLabel: obj["targetLabel"] as? String,
            targetSessionKey: validKey(obj["targetSessionKey"]),
            sourceSessionKey: validKey(obj["sourceSessionKey"]),
            role: obj["role"] as? String,
            outcome: outcome,
            brief: brief,
            findingCounts: findingCounts,
            body: cleanedBody,
            files: files,
            findings: findings
        )
    }

    private static func matchPlainHead(_ text: String) -> CliTeamCard? {
        guard let regex = try? NSRegularExpression(pattern: #"^\[NexAgent team\]\s+From\s+([^\s·]+)\s+·\s+([^\s·]+)\s+·\s+([^\n]+)(?:\n+([\s\S]*))?$"#),
              let m = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let rSender = Range(m.range(at: 1), in: text),
              let rType = Range(m.range(at: 2), in: text),
              let rSub = Range(m.range(at: 3), in: text) else { return nil }
        let sender = String(text[rSender])
        let type = text[rType].lowercased()
        let subject = text[rSub].trimmingCharacters(in: .whitespacesAndNewlines)
        let rawBody = Range(m.range(at: 4), in: text).map { text[$0].trimmingCharacters(in: .whitespacesAndNewlines) }
        let cleanedBody = rawBody.map(CliTeamBriefing.stripFraming).flatMap { $0.isEmpty ? nil : $0 }
        let looksLikeReview = type == "report" && (
            subject.range(of: #"审|review"#, options: [.regularExpression, .caseInsensitive]) != nil ||
            !(cleanedBody.map { CliTeamBriefing.summarizeFindingCounts(fallbackText: $0) } ?? []).isEmpty
        )
        let kind: CliTeamCardKind = if looksLikeReview {
            .review
        } else {
            switch type {
            case "report": .report
            case "task": .task
            case "question": .question
            case "answer": .answer
            case "escalation": .escalation
            case "message": .followup
            default: .report
            }
        }
        let isReportLike = kind == .report || kind == .review
        let summary = isReportLike
            ? CliTeamBriefing.buildReportBrief(brief: nil, body: cleanedBody, findings: [], isReview: kind == .review, outcome: nil)
            : nil
        return CliTeamCard(
            kind: kind,
            heading: "\(sender) · \(kind.typeLabel)",
            subtitle: subject.isEmpty ? nil : subject,
            actorLabel: sender,
            brief: summary?.brief.nilIfEmpty,
            findingCounts: summary?.findingCounts ?? [],
            body: cleanedBody,
            files: [],
            findings: []
        )
    }

    private static func matchNudge(_ text: String) -> CliTeamCard? {
        guard let regex = try? NSRegularExpression(pattern: #"^\[NexAgent\]\s+(Your turn ended without a report\.[\s\S]*)$"#),
              let m = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let rBody = Range(m.range(at: 1), in: text) else { return nil }
        return CliTeamCard(kind: .nudge, heading: "系统催促", subtitle: "本轮结束但尚未汇报", body: String(text[rBody]), files: [], findings: [])
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

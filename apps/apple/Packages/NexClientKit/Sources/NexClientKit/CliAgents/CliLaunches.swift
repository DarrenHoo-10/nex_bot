import Foundation

// New sessions and the models a computer's CLI offers, ported from the web client
// (`use-launches.ts`, `CliModelMenu.tsx`, `shared/cli-agents.ts`).

/// One row of a CLI's own `/model` picker, as the computer reads it from the CLI's settings.
public struct CliModelOption: Sendable, Hashable, Identifiable, Decodable {
    public var id: String
    public var label: String
    public var description: String?
    /// Effort levels the model takes; nil when the CLI does not say (every level of the engine is offered).
    public var efforts: [String]?
    /// Stable provider / plan id when a CLI groups models by provider or plan (e.g. ZCode).
    public var provider: String?
    public var providerLabel: String?
    public var providerBadge: String?
    /// `"plan"` for subscription plans, `"api"` for API-key providers.
    public var providerKind: String?
    public init(id: String, label: String, description: String? = nil, efforts: [String]? = nil,
                provider: String? = nil, providerLabel: String? = nil, providerBadge: String? = nil, providerKind: String? = nil) {
        self.id = id; self.label = label; self.description = description; self.efforts = efforts
        self.provider = provider; self.providerLabel = providerLabel; self.providerBadge = providerBadge; self.providerKind = providerKind
    }
}

/// One provider / plan section of a grouped CLI model catalog (plans before API providers).
public struct CliModelProviderGroup: Sendable, Hashable, Identifiable {
    public var id: String
    public var label: String
    public var badge: String?
    public var isPlan: Bool
    public var models: [CliModelOption]
    public init(id: String, label: String, badge: String? = nil, isPlan: Bool, models: [CliModelOption]) {
        self.id = id; self.label = label; self.badge = badge; self.isPlan = isPlan; self.models = models
    }
    public var displayTitle: String {
        if let badge, !badge.isEmpty { return "\(label) · \(badge)" }
        return label
    }
}

/// What `GET /api/cli-agents/models` answers: the picker rows in the CLI's order and what its settings choose.
public struct CliModelCatalog: Sendable, Hashable, Decodable {
    public var models: [CliModelOption]
    public var current: String?
    public var currentEffort: String?
    public init(models: [CliModelOption] = [], current: String? = nil, currentEffort: String? = nil) {
        self.models = models; self.current = current; self.currentEffort = currentEffort
    }
    enum CodingKeys: String, CodingKey { case models, current, currentEffort }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        models = try c.decodeIfPresent(LossyList<CliModelOption>.self, forKey: .models)?.values ?? []
        current = try? c.decodeIfPresent(String.self, forKey: .current)
        currentEffort = try? c.decodeIfPresent(String.self, forKey: .currentEffort)
    }
}

/// How a launched CLI asks before it acts: each CLI's own permission modes, passed through (same as the web client).
/// "full" skips every prompt; "ask" keeps the CLI's prompts (they arrive as cards); "edits" lets file edits through
/// (Claude `acceptEdits`, Antigravity `auto_edit`); "plan" is Claude's plan mode; "auto" Claude's own reviewer;
/// "readonly" Codex's read-only sandbox.
public enum CliPermissionMode: String, Codable, Sendable, Hashable, CaseIterable { case full, ask, edits, plan, auto, readonly }

public enum CliPermissions {
    /// A CLI's permission modes in the order a menu shows them, the most cautious first. An executor without
    /// `permissionModes` takes only full access and asking.
    public static func modes(engine: CliEngine, features: [String]) -> [CliPermissionMode] {
        guard features.contains("permissions") else { return [] }
        let all: [CliPermissionMode] = switch engine {
        case .claude: [.plan, .ask, .edits, .auto, .full]
        case .codex: [.readonly, .ask, .full]
        case .zcode: [.plan, .ask, .edits, .full]
        case .agy: [.ask, .edits, .full]
        }
        return features.contains("permissionModes") ? all : all.filter { $0 == .full || $0 == .ask }
    }

    /// What a mode is called for a CLI (Codex's default writes in its workspace without asking).
    public static func label(engine: CliEngine, mode: CliPermissionMode) -> String {
        if engine == .codex && mode == .ask { return "默认" }
        switch mode {
        case .full: return "完全访问"
        case .ask: return "每次询问"
        case .edits: return "自动接受编辑"
        case .plan: return "计划模式"
        case .auto: return "自动审批"
        case .readonly: return "只读"
        }
    }
}

/// What a new session is started with; empty model and effort leave the CLI's own defaults.
public struct CliImageUpload: Sendable, Hashable, Identifiable {
    public let id = UUID()
    public let name: String
    public let data: Data

    public init(name: String, data: Data) { self.name = name; self.data = data }
}

public struct CliLaunchRequest: Sendable, Hashable {
    public var deviceId: String
    public var engine: CliEngine
    public var cwd: String
    /// a new worktree on this branch; nil runs in `cwd` itself
    public var branch: String?
    /// base branch for a new worktree; nil uses the repository's current HEAD
    public var baseBranch: String?
    /// existing local branch to switch to in `cwd` when not using a worktree
    public var switchBranch: String?
    /// the first message; may be empty
    public var message: String
    public var model: String
    public var effort: String
    /// make `cwd` first: it did not exist when it was picked
    public var createDir: Bool
    /// nil leaves the computer's default (full access); only sent to computers that list `permissions`
    public var permissions: CliPermissionMode?
    public var images: [CliImageUpload]
    public init(deviceId: String, engine: CliEngine, cwd: String, branch: String? = nil, message: String = "", model: String = "", effort: String = "", createDir: Bool = false,
                permissions: CliPermissionMode? = nil, images: [CliImageUpload] = [], baseBranch: String? = nil, switchBranch: String? = nil) {
        self.deviceId = deviceId; self.engine = engine; self.cwd = cwd; self.branch = branch; self.baseBranch = baseBranch; self.switchBranch = switchBranch
        self.message = message; self.model = model; self.effort = effort; self.createDir = createDir
        self.permissions = permissions
        self.images = images
    }
}

public enum CliLaunchPhase: Sendable, Hashable { case starting, sending, sent, failed(String) }

/// A session being started: it shows in the list and the detail until the real session is listed and its first message is out.
public struct CliLaunch: Sendable, Hashable, Identifiable {
    public let id: String
    public let key: CliSessionKey
    public let request: CliLaunchRequest
    public let createdAt: Int
    public var phase: CliLaunchPhase = .starting
    public var target: CliSessionKey?
    var preparedMessage: String? = nil
    /// one id per launch, so a retried worktree start reuses the tree it built
    public let requestId: String
}

public enum CliLaunches {
    public static let keyPrefix = "launch-"

    public static func messagePreview(_ text: String, images: [CliImageUpload]) -> String {
        ([text.trimmingCharacters(in: .whitespacesAndNewlines)] + images.map { "图片：" + $0.name }).filter { !$0.isEmpty }.joined(separator: "\n")
    }
    public static let efforts: [CliEngine: [String]] = [
        .claude: ["low", "medium", "high", "xhigh", "max"],
        .codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
        .zcode: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
        .agy: ["low", "medium", "high", "xhigh", "max"],
    ]
    /// Suggestions for a computer that cannot list its CLI's models.
    public static let fallbackModels: [CliEngine: [CliModelOption]] = [
        .claude: [CliModelOption(id: "fable", label: "Fable"), CliModelOption(id: "opus", label: "Opus"), CliModelOption(id: "sonnet", label: "Sonnet"), CliModelOption(id: "haiku", label: "Haiku")],
        .codex: ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"].map { CliModelOption(id: $0, label: $0) },
    ]
    public static let reasoningLevels = ["low", "medium", "high", "xhigh", "max"]

    public static func reasoningChoice(_ value: String?) -> String {
        if value == "minimal" { return "low" }
        if value == "ultra" { return "max" }
        return reasoningLevels.first { $0 == value } ?? "high"
    }

    public static let effortLabels: [String: String] = ["": "默认", "minimal": "极低", "low": "低", "medium": "中", "high": "高", "xhigh": "很高", "max": "最高", "ultra": "超高"]
    public static func effortLabel(_ level: String) -> String { effortLabels[level] ?? level }

    private static let zcodeAccountProviders: [String: (label: String, badge: String)] = [
        "account:bigmodel-individual-coding-plan": ("BigModel", "个人"),
        "account:bigmodel-team-coding-plan": ("BigModel", "团队"),
        "account:bigmodel-start-plan": ("Start Plan", "免费"),
        "account:bigmodel-offpeak-idle-plan": ("BigModel", "闲时"),
        "account:bigmodel-highspeed-card": ("BigModel", "高速"),
        "account:zai-individual-coding-plan": ("Z.AI", "个人"),
        "account:zai-team-coding-plan": ("Z.AI", "团队"),
        "account:zai-start-plan": ("Start Plan", "免费"),
        "account:zai-offpeak-idle-plan": ("Z.AI", "闲时"),
        "account:zai-highspeed-card": ("Z.AI", "高速"),
    ]

    /// Groups provider-scoped models (e.g. ZCode plans & API providers), placing plans before API providers.
    public static func providerGroups(_ models: [CliModelOption]) -> [CliModelProviderGroup] {
        guard models.contains(where: { !($0.provider?.trimmingCharacters(in: .whitespaces).isEmpty ?? true) }) else { return [] }
        var indexById: [String: Int] = [:]
        var groups: [CliModelProviderGroup] = []
        for row in models {
            let trimmed = row.provider?.trimmingCharacters(in: .whitespaces) ?? ""
            let id = trimmed.isEmpty ? "__other__" : trimmed
            if let idx = indexById[id] {
                groups[idx].models.append(row)
            } else {
                let pLabel = row.providerLabel?.trimmingCharacters(in: .whitespaces)
                let desc = row.description?.trimmingCharacters(in: .whitespaces)
                let label = (pLabel?.isEmpty == false ? pLabel : nil) ?? (desc?.isEmpty == false ? desc : nil) ?? (id == "__other__" ? "其他" : id)
                let badge = row.providerBadge?.trimmingCharacters(in: .whitespaces)
                let isPlan = row.providerKind == "plan"
                indexById[id] = groups.count
                groups.append(CliModelProviderGroup(id: id, label: label, badge: badge?.isEmpty == false ? badge : nil, isPlan: isPlan, models: [row]))
            }
        }
        return groups.filter(\.isPlan) + groups.filter { !$0.isPlan }
    }

    /// Display label for a model id, adding the plan/provider name when multiple providers share the same model label.
    public static func modelDisplayLabel(_ models: [CliModelOption], id: String) -> String {
        if let row = models.first(where: { $0.id == id }) {
            let pLabel = row.providerLabel?.trimmingCharacters(in: .whitespaces) ?? ""
            if !pLabel.isEmpty, let provider = row.provider {
                let key = row.label.trimmingCharacters(in: .whitespaces).lowercased()
                let duplicates = models.filter { $0.provider != provider && $0.label.trimmingCharacters(in: .whitespaces).lowercased() == key }
                if !duplicates.isEmpty {
                    let sameLabel = duplicates.contains { ($0.providerLabel?.trimmingCharacters(in: .whitespaces) ?? "") == pLabel }
                    let badge = row.providerBadge?.trimmingCharacters(in: .whitespaces) ?? ""
                    let prefix = sameLabel && !badge.isEmpty ? "\(pLabel) \(badge)" : pLabel
                    return "\(prefix) · \(row.label)"
                }
            }
            return row.label
        }
        if let slash = id.firstIndex(of: "/"), slash > id.startIndex, id.index(after: slash) < id.endIndex {
            let provider = String(id[..<slash])
            if let known = zcodeAccountProviders[provider] {
                return "\(known.label) · \(id[id.index(after: slash)...])"
            }
        }
        return id
    }

    /// Effort levels `model` takes: what the CLI says for it, else every level of the engine.
    public static func efforts(engine: CliEngine, models: [CliModelOption], model: String) -> [String] {
        models.first { $0.id == model }?.efforts ?? (engine == .agy || engine == .zcode ? [] : efforts[engine] ?? [])
    }

    public static func resolveEffort(engine: CliEngine, offered: [String], preferred: String = "high") -> String? {
        if offered.contains(preferred) { return preferred }
        let order = efforts[engine] ?? []
        guard let high = order.firstIndex(of: "high") else { return nil }
        let wanted = order.firstIndex(of: preferred) ?? high
        return order.indices.filter { offered.contains(order[$0]) }
            .sorted { (abs($0 - wanted), $0) < (abs($1 - wanted), $1) }
            .first.map { order[$0] }
    }

    /// `nexagent/` and six random characters.
    public static func randomBranch() -> String {
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        return "nexagent/" + String((0..<6).map { _ in alphabet.randomElement()! })
    }

    /// Why `branch` cannot be a new branch, or nil.
    public static func branchProblem(_ branch: String) -> String? {
        let name = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return "需要分支名称" }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._/-")
        let first = name.unicodeScalars.first!
        let valid = name.count <= 120 && name.unicodeScalars.allSatisfy { allowed.contains($0) } && CharacterSet.alphanumerics.contains(first) && first.isASCII
            && !name.contains("..") && !name.contains("//") && !name.hasSuffix("/") && !name.hasSuffix(".") && !name.hasSuffix(".lock")
        return valid ? nil : "分支名称不合法"
    }

    public static func isLaunchKey(_ key: CliSessionKey?) -> Bool {
        guard let key else { return false }
        let parts = key.split(separator: ":", maxSplits: 2)
        return parts.count == 3 && parts[2].hasPrefix(keyPrefix)
    }

    public static func make(_ request: CliLaunchRequest, now: Int) -> CliLaunch {
        let id = UUID().uuidString.lowercased()
        return CliLaunch(id: id, key: "\(request.deviceId):\(request.engine.rawValue):\(keyPrefix)\(id.prefix(8))", request: request, createdAt: now, requestId: UUID().uuidString.lowercased())
    }

    /// The list row a launch shows as until its session is listed.
    public static func row(_ launch: CliLaunch) -> CliSession {
        let first = launch.request.message.split(separator: "\n", maxSplits: 1).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        var failed = false
        if case .failed = launch.phase { failed = true }
        return CliSession(key: launch.key, deviceId: launch.request.deviceId, engine: launch.request.engine, nativeId: String(launch.key.split(separator: ":").last ?? ""),
                          cwd: launch.request.cwd, title: first.isEmpty ? "新会话" : String(first.prefix(80)), gitBranch: launch.request.branch ?? launch.request.switchBranch,
                          state: failed ? .stopped : .running, lastActivityAt: launch.createdAt, repoRoot: launch.request.cwd)
    }
}

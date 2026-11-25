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
    public init(id: String, label: String, description: String? = nil, efforts: [String]? = nil) {
        self.id = id; self.label = label; self.description = description; self.efforts = efforts
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

/// How a launched CLI asks before it acts: "full" skips every prompt, "ask" keeps the CLI's own prompts (they arrive as cards).
public enum CliPermissionMode: String, Sendable, Hashable, CaseIterable { case full, ask }

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
                permissions: CliPermissionMode? = nil, images: [CliImageUpload] = []) {
        self.deviceId = deviceId; self.engine = engine; self.cwd = cwd; self.branch = branch; self.message = message; self.model = model; self.effort = effort; self.createDir = createDir
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
    /// one id per launch, so a retried worktree start reuses the tree it built
    public let requestId: String
}

public enum CliLaunches {
    public static let keyPrefix = "launch-"
    public static let efforts: [CliEngine: [String]] = [
        .claude: ["low", "medium", "high", "xhigh", "max"],
        .codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
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

    /// Effort levels `model` takes: what the CLI says for it, else every level of the engine.
    public static func efforts(engine: CliEngine, models: [CliModelOption], model: String) -> [String] {
        models.first { $0.id == model }?.efforts ?? (engine == .agy ? [] : efforts[engine] ?? [])
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
                          cwd: launch.request.cwd, title: first.isEmpty ? "新会话" : String(first.prefix(80)), gitBranch: launch.request.branch,
                          state: failed ? .stopped : .running, lastActivityAt: launch.createdAt)
    }
}

import Foundation

// MARK: - Per-assistant model, visible models, unified memory

extension Bot {
    /// The model this assistant chats with (`selected_model`); nil while it follows the account default model.
    public var selectedModel: String? { row.string("selected_model").flatMap { $0.isEmpty ? nil : $0 } }
    /// Echoed as `version` by ``WorkspaceStore/setAgentModel(botID:model:)`` (`model_selection_version`, 0 until first change).
    public var modelSelectionVersion: Int { row.int("model_selection_version") ?? 0 }
    /// What the header and menus show: the assistant's own model, else the default model, else nil.
    public func effectiveModel(default defaultModel: String?) -> String? {
        selectedModel ?? defaultModel.flatMap { $0.isEmpty ? nil : $0 }
    }
}

/// `modelVisibility` of the state: which models the pickers offer for the current connection.
/// `models == nil` shows the whole provider directory; an array (possibly empty) is the saved shortlist.
public struct ModelVisibility: Sendable, Hashable, Codable {
    public var models: [String]?
    public var version: Int
    public init(models: [String]? = nil, version: Int = 0) { self.models = models; self.version = version }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        models = c.lenient(.init("models"))?.arrayValue?.compactMap(\.stringValue)
        version = c.lenient(.init("version"))?.intValue ?? 0
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        if let models { try c.encode(models, forKey: .init("models")) } else { try c.encodeNil(forKey: .init("models")) }
        try c.encode(version, forKey: .init("version"))
    }
}

/// `memory/summary` and `memory/settings`: the account-wide long-term memory switch, the memory model
/// (empty follows the account default model) and lifetime memory token usage.
public struct MemorySummary: Sendable, Hashable, Codable {
    public var enabled: Bool
    public var model: String
    public var version: Int
    public var totalTokens: Int
    /// Some usage could not be measured: show the total as "≥ n".
    public var incomplete: Bool
    public init(enabled: Bool = false, model: String = "", version: Int = 0, totalTokens: Int = 0, incomplete: Bool = false) {
        self.enabled = enabled; self.model = model; self.version = version; self.totalTokens = totalTokens; self.incomplete = incomplete
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        enabled = c.lenient(.init("enabled"))?.boolValue ?? false
        model = c.lenient(.init("model"))?.stringValue ?? ""
        version = c.lenient(.init("version"))?.intValue ?? 0
        totalTokens = c.lenient(.init("totalTokens"))?.intValue ?? 0
        incomplete = c.lenient(.init("incomplete"))?.boolValue ?? false
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(enabled, forKey: .init("enabled")); try c.encode(model, forKey: .init("model")); try c.encode(version, forKey: .init("version"))
        try c.encode(totalTokens, forKey: .init("totalTokens")); try c.encode(incomplete, forKey: .init("incomplete"))
    }
    /// "1,234" or "≥ 1,234" when ``incomplete``.
    public var totalLabel: String {
        let f = NumberFormatter(); f.numberStyle = .decimal; f.locale = Locale(identifier: "en_US")
        return (incomplete ? "≥ " : "") + (f.string(from: NSNumber(value: totalTokens)) ?? String(totalTokens))
    }
}

struct BotModelBody: Encodable { let id: String; let model: String; let provider: String; let endpoint: String; let version: Int }
struct ModelVisibilityBody: Encodable {
    let provider: String, endpoint: String, models: [String]?, version: Int
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(provider, forKey: .init("provider")); try c.encode(endpoint, forKey: .init("endpoint"))
        if let models { try c.encode(models, forKey: .init("models")) } else { try c.encodeNil(forKey: .init("models")) }
        try c.encode(version, forKey: .init("version"))
    }
}
struct MemorySettingsBody: Encodable { let enabled: Bool; let model: String?; let version: Int }

extension CoreClient {
    /// `POST /api/bots/model`. `model == ""` follows the account default model. Errors: 请等待当前任务结束或停止任务后切换模型,
    /// 模型连接已变化，请重新选择, 模型已在其他设备更新，请重新选择.
    public func updateModel(id: String, model: String, provider: String, endpoint: String, version: Int) async throws {
        try await post("/api/bots/model", body: BotModelBody(id: id, model: model, provider: provider, endpoint: endpoint, version: version))
    }
    /// `POST /api/models/visibility` (owner only). `models == nil` shows every model. Returns the stored value.
    public func saveModelVisibility(provider: String, endpoint: String, models: [String]?, version: Int) async throws -> ModelVisibility {
        try await post("/api/models/visibility", body: ModelVisibilityBody(provider: provider, endpoint: endpoint, models: models, version: version))
    }
    /// `POST /api/memory/summary` (owner only).
    public func memorySummary() async throws -> MemorySummary { try await post("/api/memory/summary", body: EmptyBody()) }
    /// `POST /api/memory/settings` (owner only). `model == nil` keeps the stored memory model; `""` follows the default model.
    public func saveMemorySettings(enabled: Bool, model: String?, version: Int) async throws -> MemorySummary {
        try await post("/api/memory/settings", body: MemorySettingsBody(enabled: enabled, model: model, version: version))
    }
}

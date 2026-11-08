import Foundation

// MARK: - Model providers ("供应商") and reasoning effort ("思考强度")

/// A reasoning level a model offers. "off" (关闭) is always available and is not a level.
public enum ReasoningLevel: String, CaseIterable, Sendable, Hashable, Codable {
    case low, medium, high, xhigh, max
    public var label: String {
        switch self { case .low: "低"; case .medium: "中"; case .high: "高"; case .xhigh: "很高"; case .max: "最高" }
    }
    /// The label of a stored choice: a level, or "off".
    public static func label(_ choice: String) -> String { ReasoningLevel(rawValue: choice)?.label ?? "关闭" }
    /// Same rule as Core (`reasoning.ts`): the choice when offered, else the nearest offered level (lower on a tie);
    /// `medium` is aimed for when nothing was chosen. A model offering no levels is "off".
    public static func resolve(_ choice: String?, offered: [ReasoningLevel]) -> String {
        guard !offered.isEmpty, choice != "off" else { return "off" }
        let wanted = choice.flatMap(ReasoningLevel.init(rawValue:)) ?? .medium
        if offered.contains(wanted) { return wanted.rawValue }
        let order = ReasoningLevel.allCases, at = order.firstIndex(of: wanted)!
        return offered.sorted {
            let a = abs(order.firstIndex(of: $0)! - at), b = abs(order.firstIndex(of: $1)! - at)
            return a != b ? a < b : order.firstIndex(of: $0)! < order.firstIndex(of: $1)!
        }[0].rawValue
    }
}

/// A model's settings on one provider: image input (nil: not set) and the reasoning levels it offers.
public struct ModelOptions: Sendable, Hashable {
    public var imageInput: Bool?
    public var reasoning: [ReasoningLevel]
    public var version: Int
    public init(imageInput: Bool? = nil, reasoning: [ReasoningLevel] = [], version: Int = 0) { self.imageInput = imageInput; self.reasoning = reasoning; self.version = version }
    init(row: Row) {
        imageInput = row["imageInput"].flatMap { if case .null = $0 { nil } else { $0.boolValue } }
        reasoning = (row["reasoning"]?.arrayValue ?? []).compactMap { $0.stringValue.flatMap(ReasoningLevel.init(rawValue:)) }
        version = row.int("version") ?? 0
    }
}

/// One entry of `connections` in the state. The API key is never returned. `models == nil` offers every model the
/// provider lists; an array is its 启用 list.
public struct ModelConnection: RowBacked, Identifiable {
    public let row: Row
    public init(row: Row) { self.row = row }
    public var id: String { row.string("id") ?? "" }
    public var name: String { row.string("name") ?? "" }
    /// `openai` or `anthropic`.
    public var provider: String { row.string("provider") ?? "openai" }
    public var endpoint: String { row.string("endpoint") ?? "" }
    public var defaultModel: String { row.string("defaultModel") ?? "" }
    public var enabled: Bool { row.bool("enabled") ?? true }
    public var isDefault: Bool { row.bool("isDefault") ?? false }
    public var configured: Bool { row.bool("configured") ?? false }
    public var version: Int { row.int("version") ?? 0 }
    public var models: [String]? { if case .null? = row["models"] { nil } else { row["models"]?.arrayValue?.compactMap(\.stringValue) } }
    public var modelsVersion: Int { row.int("modelsVersion") ?? 0 }
    public var options: [String: ModelOptions] { (row["options"]?.objectValue ?? [:]).compactMapValues { $0.objectValue.map(ModelOptions.init(row:)) } }
    /// 「API」 or 「Anthropic」, as the chat menu tags it.
    public var formatTag: String { provider == "anthropic" ? "Anthropic" : "API" }
    public var usable: Bool { enabled && configured }
}

extension Bot {
    /// The provider this assistant uses (`selected_connection`); nil on older Cores.
    public var selectedConnectionID: String? { row.string("selected_connection").flatMap { $0.isEmpty ? nil : $0 } }
    /// The reasoning effort this assistant chose (`selected_reasoning`): a level, "off", or nil (not chosen yet).
    public var selectedReasoning: String? { row.string("selected_reasoning").flatMap { $0.isEmpty ? nil : $0 } }
}

extension WorkspaceState {
    /// Providers, default first. Empty on older Cores (only ``config`` exists there).
    public var connections: [ModelConnection] { connectionRows.map(ModelConnection.init(row:)) }
    /// The provider an assistant uses: its own while usable, else the default one.
    public func connection(forBot bot: Bot?) -> ModelConnection? {
        let all = connections
        return all.first { $0.id == bot?.selectedConnectionID && $0.enabled } ?? all.first(where: \.isDefault)
    }
    /// What an assistant chats with: its provider, model (or the provider's default) and the resolved effort.
    public func modelChoice(forBot bot: Bot?) -> (connection: ModelConnection?, model: String, reasoning: String) {
        let connection = connection(forBot: bot)
        let model = bot?.selectedModel ?? connection?.defaultModel ?? config?.defaultModel ?? ""
        let offered = connection?.options[model]?.reasoning ?? []
        return (connection, model, ReasoningLevel.resolve(bot?.selectedReasoning, offered: offered))
    }
    /// The label menus show: "model · 高", or just the model when reasoning is off.
    public func modelLabel(forBot bot: Bot?) -> String {
        let choice = modelChoice(forBot: bot)
        guard !choice.model.isEmpty else { return "未连接模型" }
        return choice.reasoning == "off" ? choice.model : "\(choice.model) · \(ReasoningLevel.label(choice.reasoning))"
    }
}

struct ConnectionBody: Encodable {
    let id: String?, version: Int?, name: String, provider: String, endpoint: String, apiKey: String?, enabled: Bool?, defaultModel: String?
}
struct ConnectionRef: Encodable { let id: String; let version: Int? }
struct ConnectionSaved: Decodable, Sendable { let id: String }
struct ModelOptionsBody: Encodable {
    let connectionId: String, model: String, version: Int, imageInput: Bool, reasoning: [String]
    let contextWindow: Int?, maxOutputTokens: Int?
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(connectionId, forKey: .init("connectionId")); try c.encode(model, forKey: .init("model")); try c.encode(version, forKey: .init("version"))
        try c.encode(imageInput, forKey: .init("imageInput")); try c.encode(reasoning, forKey: .init("reasoning"))
        // null clears a manual limit (automatic); the key is always sent.
        if let contextWindow { try c.encode(contextWindow, forKey: .init("contextWindow")) } else { try c.encodeNil(forKey: .init("contextWindow")) }
        if let maxOutputTokens { try c.encode(maxOutputTokens, forKey: .init("maxOutputTokens")) } else { try c.encodeNil(forKey: .init("maxOutputTokens")) }
    }
}
struct ConnectionModelsQuery: Encodable { let connectionId: String }
struct ConnectionVisibilityBody: Encodable {
    let connectionId: String, models: [String]?, version: Int
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(connectionId, forKey: .init("connectionId"))
        if let models { try c.encode(models, forKey: .init("models")) } else { try c.encodeNil(forKey: .init("models")) }
        try c.encode(version, forKey: .init("version"))
    }
}
struct BotChoiceBody: Encodable { let id: String; let connectionId: String; let model: String; let reasoning: String?; let version: Int }

extension CoreClient {
    /// `POST /api/connections/save` (owner only): adds (no `id`) or edits a provider. An empty key keeps the saved one.
    public func saveConnection(id: String?, version: Int?, name: String, provider: String, endpoint: String, apiKey: String, enabled: Bool?, defaultModel: String?) async throws -> String {
        let saved: ConnectionSaved = try await post("/api/connections/save", body: ConnectionBody(id: id, version: version, name: name, provider: provider, endpoint: endpoint, apiKey: apiKey.isEmpty ? nil : apiKey, enabled: enabled, defaultModel: defaultModel))
        return saved.id
    }
    /// `POST /api/connections/default` (owner only).
    public func setDefaultConnection(id: String) async throws { try await post("/api/connections/default", body: ConnectionRef(id: id, version: nil)) }
    /// `POST /api/connections/remove` (owner only): erases its key; its assistants go back to the default provider.
    public func removeConnection(id: String, version: Int) async throws { try await post("/api/connections/remove", body: ConnectionRef(id: id, version: version)) }
    /// `POST /api/connections/model` (owner only): image input, reasoning levels and limits (nil = automatic) of one model.
    public func saveModelOptions(connectionID: String, model: String, version: Int, imageInput: Bool, reasoning: [ReasoningLevel], contextWindow: Int?, maxOutputTokens: Int?) async throws {
        try await post("/api/connections/model", body: ModelOptionsBody(connectionId: connectionID, model: model, version: version, imageInput: imageInput, reasoning: reasoning.map(\.rawValue), contextWindow: contextWindow, maxOutputTokens: maxOutputTokens))
    }
    /// `POST /api/models/list` for a saved provider, with its saved key.
    public func listModels(connectionID: String) async throws -> ModelCatalog { try await post("/api/models/list", body: ConnectionModelsQuery(connectionId: connectionID)) }
    /// `POST /api/models/visibility` for one provider (`nil` = every model).
    public func saveModelVisibility(connectionID: String, models: [String]?, version: Int) async throws -> ModelVisibility {
        try await post("/api/models/visibility", body: ConnectionVisibilityBody(connectionId: connectionID, models: models, version: version))
    }
    /// `POST /api/bots/model` with a provider: model `""` is the provider's default model; `reasoning == nil` keeps the stored effort.
    public func updateModel(id: String, connectionID: String, model: String, reasoning: String?, version: Int) async throws {
        try await post("/api/bots/model", body: BotChoiceBody(id: id, connectionId: connectionID, model: model, reasoning: reasoning, version: version))
    }
}

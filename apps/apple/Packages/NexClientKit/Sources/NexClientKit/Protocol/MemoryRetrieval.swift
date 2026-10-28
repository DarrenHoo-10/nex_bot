import Foundation

// MARK: - 记忆检索 (web `RetrievalSettings.tsx`, server `retrieval-config.ts`)

/// The two independently configured models of memory retrieval.
public enum RetrievalKind: String, Sendable, Hashable, CaseIterable {
    case embedding, rerank
    /// 向量模型 / 重排模型.
    public var title: String { self == .embedding ? "向量模型" : "重排模型" }
}

/// Where the model in effect comes from: the user's own settings, the server default, or nothing.
public enum RetrievalSource: String, Sendable, Hashable {
    case custom, `default`, disabled
    /// 自定义 / 默认 / 未启用.
    public var label: String {
        switch self { case .custom: "自定义"; case .default: "默认"; case .disabled: "未启用" }
    }
}

/// Request format of the rerank service.
public enum RerankFormat: String, Sendable, Hashable, CaseIterable {
    case cohere, tei
    public var title: String { self == .cohere ? "Cohere" : "TEI" }
}

/// A server default: its model name (and rerank format) only. Core never sends the address or any key of a default.
public struct RetrievalDefault: Sendable, Hashable {
    public var model: String
    public var format: RerankFormat?
}

/// The user's own settings of one item. Core never sends the API key, only whether one is stored.
public struct RetrievalCustom: Sendable, Hashable {
    public var enabled: Bool
    public var baseURL: String
    public var model: String
    /// Embedding only; nil lets the service choose.
    public var dimensions: Int?
    /// Rerank only.
    public var format: RerankFormat?
    public var hasKey: Bool
}

/// One item (embedding or rerank) of ``RetrievalView``.
public struct RetrievalItem: Sendable, Hashable, Decodable {
    public var source: RetrievalSource
    /// The model in effect (custom or default); nil when ``source`` is `disabled`.
    public var model: String?
    public var format: RerankFormat?
    /// Echoed by a save; a stale one fails with "检索设置已变化，请刷新".
    public var version: Int
    public var defaultModel: RetrievalDefault?
    public var custom: RetrievalCustom?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        source = c.lenient(.init("source"))?.stringValue.flatMap { RetrievalSource(rawValue: $0) } ?? .disabled
        model = c.lenient(.init("model"))?.stringValue
        format = c.lenient(.init("format"))?.stringValue.flatMap { RerankFormat(rawValue: $0) }
        version = c.lenient(.init("version"))?.intValue ?? 0
        defaultModel = c.lenient(.init("default"))?.objectValue.map {
            RetrievalDefault(model: $0.string("model") ?? "", format: $0.string("format").flatMap { RerankFormat(rawValue: $0) })
        }
        custom = c.lenient(.init("custom"))?.objectValue.map {
            RetrievalCustom(enabled: $0.bool("enabled") ?? false, baseURL: $0.string("baseUrl") ?? "", model: $0.string("model") ?? "",
                            dimensions: $0.int("dimensions"), format: $0.string("format").flatMap { RerankFormat(rawValue: $0) },
                            hasKey: $0.bool("hasKey") ?? false)
        }
    }

    /// "自定义 · 模型名", "默认 · 模型名" or "未启用": the item in effect.
    public var statusText: String {
        if source == .disabled { return RetrievalSource.disabled.label }
        let name = model.flatMap { $0.isEmpty ? nil : $0 } ?? (format == .tei ? "TEI" : "—")
        return "\(source.label) · \(name)"
    }
}

/// `GET /api/memory/retrieval` and the result of a save.
public struct RetrievalView: Sendable, Hashable, Decodable {
    public var embedding: RetrievalItem
    public var rerank: RetrievalItem
    public func item(_ kind: RetrievalKind) -> RetrievalItem { kind == .embedding ? embedding : rerank }
}

/// Body of `POST /api/memory/retrieval` for one item. Core tests the settings with a real request before storing them
/// (up to 15 s); ``useDefault(kind:version:)`` removes the user's settings and key instead.
public struct RetrievalSaveRequest: Sendable, Hashable, Encodable {
    public enum Change: Sendable, Hashable {
        /// A blank `apiKey` keeps the stored key while the address stays on the same origin; it is never sent when blank.
        case settings(enabled: Bool, baseURL: String, model: String, dimensions: Int?, format: RerankFormat, apiKey: String)
        case useDefault
    }
    public var kind: RetrievalKind
    /// ``RetrievalItem/version`` the edit started from.
    public var version: Int
    public var change: Change

    public static func save(kind: RetrievalKind, version: Int, enabled: Bool, baseURL: String, model: String,
                            dimensions: Int? = nil, format: RerankFormat = .cohere, apiKey: String = "") -> RetrievalSaveRequest {
        RetrievalSaveRequest(kind: kind, version: version, change: .settings(enabled: enabled, baseURL: baseURL, model: model, dimensions: dimensions, format: format, apiKey: apiKey))
    }
    /// Largest embedding dimension Core accepts.
    public static let maxDimensions = 8192
    /// The 维度 field: blank (or 0) lets the service choose, otherwise a whole number of 1 to 8192, else "维度须为 1 至 8192".
    public static func dimensions(from text: String) throws -> Int? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        guard let value = Int(trimmed), (0...maxDimensions).contains(value) else {
            throw CoreError(kind: .unsupported, message: "维度须为 1 至 \(maxDimensions)")
        }
        return value == 0 ? nil : value
    }
    /// 使用默认: drops the user's own settings, so the server default (or nothing) applies again.
    public static func useDefault(kind: RetrievalKind, version: Int) -> RetrievalSaveRequest {
        RetrievalSaveRequest(kind: kind, version: version, change: .useDefault)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(kind.rawValue, forKey: .init("kind")); try c.encode(version, forKey: .init("version"))
        switch change {
        case .useDefault:
            try c.encode(true, forKey: .init("reset"))
        case .settings(let enabled, let baseURL, let model, let dimensions, let format, let apiKey):
            try c.encode(enabled, forKey: .init("enabled"))
            try c.encode(baseURL.trimmingCharacters(in: .whitespacesAndNewlines), forKey: .init("baseUrl"))
            try c.encode(model.trimmingCharacters(in: .whitespacesAndNewlines), forKey: .init("model"))
            let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
            if !key.isEmpty { try c.encode(key, forKey: .init("apiKey")) }
            if kind == .embedding {
                if let dimensions { try c.encode(dimensions, forKey: .init("dimensions")) } else { try c.encodeNil(forKey: .init("dimensions")) }
            } else {
                try c.encode(format.rawValue, forKey: .init("format"))
            }
        }
    }
}

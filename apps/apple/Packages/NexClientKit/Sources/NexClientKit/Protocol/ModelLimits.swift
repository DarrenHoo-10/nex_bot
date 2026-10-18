import Foundation

/// Model limit defaults and input parsing, mirroring Core's `model-limits.ts`.
public enum ModelLimits {
    /// Used when neither a manual value nor the models.dev catalog knows the model.
    public static let defaultContextWindow = 256_000
    public static let defaultMaxOutputTokens = 32_000
    public static let contextWindowRange = 1_024...10_000_000
    public static let maxOutputTokensRange = 1...10_000_000
    public static let contextWindowInvalid = "上下文窗口须为 1,024 至 10,000,000 的整数"
    public static let maxOutputTokensInvalid = "最大输出 Token 须为 1 至 10,000,000 的整数"

    public enum Field: Sendable { case contextWindow, maxOutputTokens }

    /// Turns a text field into a setting: blank = ``LimitSetting/automatic``, digits within range = manual.
    /// Throws Core's validation message otherwise. Spaces around the number are ignored.
    public static func parse(_ text: String, field: Field) throws -> LimitSetting {
        let t = text.trimmingCharacters(in: .whitespaces)
        if t.isEmpty { return .automatic }
        let range = field == .contextWindow ? contextWindowRange : maxOutputTokensRange
        guard t.allSatisfy({ $0.isASCII && $0.isNumber }), let n = Int(t), range.contains(n) else {
            throw CoreError(kind: .unsupported, message: field == .contextWindow ? contextWindowInvalid : maxOutputTokensInvalid)
        }
        return .manual(n)
    }
}

/// How `POST /api/config` treats one model limit. Overrides are stored per provider + endpoint + model.
public enum LimitSetting: Sendable, Hashable {
    /// Field omitted: keep the saved override (what old clients do).
    case preserve
    /// `null`: clear the override; Core detects the value from models.dev or the default.
    case automatic
    /// A manual override.
    case manual(Int)

    /// A settings form value: the saved manual value of ``ModelLimitInfo/manual``, or `.automatic` when blank.
    public init(_ manual: Int?) { self = manual.map(LimitSetting.manual) ?? .automatic }
}

/// `source` of a limit value.
public enum ModelLimitSource: String, Sendable, Hashable {
    case manual, modelsDev = "models.dev", `default`
    init(_ value: String?) { self = value.flatMap(ModelLimitSource.init(rawValue:)) ?? .default }
    /// 手动配置 / models.dev / 默认.
    public var label: String { switch self { case .manual: "手动配置"; case .modelsDev: "models.dev"; case .default: "默认" } }
}

/// How the model id matched the catalog.
public enum ModelLimitStatus: String, Sendable, Hashable {
    case matched, ambiguous, unknown
    init(_ value: String?) { self = value.flatMap(ModelLimitStatus.init(rawValue:)) ?? .unknown }
    /// The status line of the web settings form.
    public var text: String {
        switch self {
        case .matched: "留空自动识别，手动值优先"
        case .ambiguous: "目录中存在不同配置，请手动填写"
        case .unknown: "未识别到此模型，使用默认值；可手动填写"
        }
    }
}

public struct ModelLimitSources: Sendable, Hashable {
    public var contextWindow: ModelLimitSource, maxOutputTokens: ModelLimitSource
}

/// The values Core would use with no manual override.
public struct ModelLimitAutomatic: Sendable, Hashable {
    public var contextWindow: Int, maxOutputTokens: Int
    public var source: ModelLimitSources
}

/// `POST /api/models/limits` and `/refresh`: the effective limits of one provider + endpoint + model.
public struct ModelLimitInfo: Decodable, Sendable, Hashable {
    /// Saved overrides; nil = automatic.
    public struct Manual: Sendable, Hashable { public var contextWindow: Int?, maxOutputTokens: Int? }
    /// Effective values (manual wins over automatic).
    public var contextWindow: Int
    public var maxOutputTokens: Int
    public var manual: Manual
    public var source: ModelLimitSources
    public var status: ModelLimitStatus
    /// The matched catalog entry, e.g. `openai/gpt-5`.
    public var matched: String?
    /// When the models.dev catalog behind the answer was last updated.
    public var updatedAt: Date?
    public var automatic: ModelLimitAutomatic
    /// Result of the online lookup, only on `/refresh`: for example `updated`, `fresh`, `failed` or `disabled`. Unknown values pass through.
    public var refresh: String?
    /// The online lookup failed; the web shows "联网识别失败，使用缓存或默认值".
    public var refreshFailed: Bool { refresh == "failed" }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        func sources(_ v: JSONValue?) -> ModelLimitSources {
            ModelLimitSources(contextWindow: ModelLimitSource(v?["contextWindow"]?.stringValue), maxOutputTokens: ModelLimitSource(v?["maxOutputTokens"]?.stringValue))
        }
        contextWindow = c.lenient(.init("contextWindow"))?.intValue ?? ModelLimits.defaultContextWindow
        maxOutputTokens = c.lenient(.init("maxOutputTokens"))?.intValue ?? ModelLimits.defaultMaxOutputTokens
        let m = c.lenient(.init("manual"))
        manual = Manual(contextWindow: m?["contextWindow"]?.intValue, maxOutputTokens: m?["maxOutputTokens"]?.intValue)
        source = sources(c.lenient(.init("source")))
        status = ModelLimitStatus(c.lenient(.init("status"))?.stringValue)
        matched = c.lenient(.init("matched"))?.stringValue
        updatedAt = dateFromMilliseconds(c.lenient(.init("updatedAt"))?.doubleValue)
        let a = c.lenient(.init("automatic"))
        automatic = ModelLimitAutomatic(contextWindow: a?["contextWindow"]?.intValue ?? ModelLimits.defaultContextWindow,
                                        maxOutputTokens: a?["maxOutputTokens"]?.intValue ?? ModelLimits.defaultMaxOutputTokens,
                                        source: sources(a?["source"]))
        refresh = c.lenient(.init("refresh"))?.stringValue
    }
}

struct ModelLimitQuery: Encodable {
    let provider: String, endpoint: String, model: String, force: Bool?
}

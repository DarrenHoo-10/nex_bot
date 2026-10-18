import Foundation

/// Escape hatch for Core rows that are open records (`Record<string, string | number | null>` in TypeScript).
public enum JSONValue: Codable, Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }

    /// Strings as-is; numbers and booleans are stringified (integers without a fraction); null is nil.
    public var stringValue: String? {
        switch self {
        case .string(let s): s
        case .number(let n): n == n.rounded() && abs(n) < 1e15 ? String(Int64(n)) : String(n)
        case .bool(let b): String(b)
        default: nil
        }
    }
    /// Numbers (Int or Double on the wire) and numeric strings.
    public var doubleValue: Double? {
        switch self {
        case .number(let n): n
        case .string(let s): Double(s)
        case .bool(let b): b ? 1 : 0
        default: nil
        }
    }
    public var intValue: Int? { doubleValue.flatMap { $0.isFinite && abs($0) < 9e15 ? Int($0) : nil } }
    public var boolValue: Bool? {
        switch self {
        case .bool(let b): b
        case .number(let n): n != 0
        case .string(let s): ["true", "1"].contains(s) ? true : ["false", "0"].contains(s) ? false : nil
        default: nil
        }
    }
    public var arrayValue: [JSONValue]? { if case .array(let a) = self { a } else { nil } }
    public var objectValue: [String: JSONValue]? { if case .object(let o) = self { o } else { nil } }
    public subscript(key: String) -> JSONValue? { objectValue?[key] }
}

/// An open Core row.
public typealias Row = [String: JSONValue]

extension Dictionary where Key == String, Value == JSONValue {
    public func string(_ key: String) -> String? { self[key]?.stringValue }
    public func int(_ key: String) -> Int? { self[key]?.intValue }
    public func double(_ key: String) -> Double? { self[key]?.doubleValue }
    public func bool(_ key: String) -> Bool? { self[key]?.boolValue }
}

extension KeyedDecodingContainer {
    /// Never throws: a missing key or a mismatched type yields nil.
    func lenient(_ key: Key) -> JSONValue? { (try? decodeIfPresent(JSONValue.self, forKey: key)) ?? nil }
}

/// Core timestamps are epoch milliseconds.
public func dateFromMilliseconds(_ value: Double?) -> Date? { value.map { Date(timeIntervalSince1970: $0 / 1000) } }

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByBooleanLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
}

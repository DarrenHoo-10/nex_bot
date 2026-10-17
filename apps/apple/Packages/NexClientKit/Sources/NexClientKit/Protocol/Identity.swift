import Foundation

/// `GET /api/client/identity`
public struct ClientIdentity: Codable, Sendable, Equatable {
    public var version: Int
    public var coreId: String
    public var loginRequired: Bool
    public var loginMethods: [String]
    public var initialized: Bool
    public var mode: String?

    public init(version: Int = 1, coreId: String, loginRequired: Bool = true, loginMethods: [String] = ["password"], initialized: Bool = true, mode: String? = nil) {
        self.version = version; self.coreId = coreId; self.loginRequired = loginRequired
        self.loginMethods = loginMethods; self.initialized = initialized; self.mode = mode
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        version = c.lenient(.init("version"))?.intValue ?? 0
        coreId = c.lenient(.init("coreId"))?.stringValue ?? ""
        loginRequired = c.lenient(.init("loginRequired"))?.boolValue ?? false
        loginMethods = c.lenient(.init("loginMethods"))?.arrayValue?.compactMap(\.stringValue) ?? []
        initialized = c.lenient(.init("initialized"))?.boolValue ?? false
        mode = c.lenient(.init("mode"))?.stringValue
    }
}

/// `POST /api/auth/start` response. Echoed back, plus the password, to `/api/auth/respond`.
public struct LoginTransaction: Codable, Sendable, Equatable {
    public var transactionId: String
    public var bindingToken: String
    public var stepId: String
    public var challenge: JSONValue
    public var expiresAt: Double

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let t = c.lenient(.init("transactionId"))?.stringValue, let b = c.lenient(.init("bindingToken"))?.stringValue, let s = c.lenient(.init("stepId"))?.stringValue
        else { throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Incomplete login transaction")) }
        transactionId = t; bindingToken = b; stepId = s
        challenge = c.lenient(.init("challenge")) ?? .null
        expiresAt = c.lenient(.init("expiresAt"))?.doubleValue ?? 0
    }
}

/// `POST /api/auth/respond` response.
public struct LoginSession: Codable, Sendable, Equatable {
    public var token: String
    public var coreId: String
    public var sessionId: String
    /// Epoch milliseconds.
    public var expiresAt: Double

    public init(token: String, coreId: String, sessionId: String, expiresAt: Double) {
        self.token = token; self.coreId = coreId; self.sessionId = sessionId; self.expiresAt = expiresAt
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let t = c.lenient(.init("token"))?.stringValue else { throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Missing token")) }
        token = t
        coreId = c.lenient(.init("coreId"))?.stringValue ?? ""
        sessionId = c.lenient(.init("sessionId"))?.stringValue ?? ""
        expiresAt = c.lenient(.init("expiresAt"))?.doubleValue ?? 0
    }
}

/// `POST /api/session` response.
public struct SessionCheck: Codable, Sendable, Equatable {
    public var authenticated: Bool
    public var coreId: String
    public var sessionId: String?
    public var expiresAt: Double?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        authenticated = c.lenient(.init("authenticated"))?.boolValue ?? false
        coreId = c.lenient(.init("coreId"))?.stringValue ?? ""
        sessionId = c.lenient(.init("sessionId"))?.stringValue
        expiresAt = c.lenient(.init("expiresAt"))?.doubleValue
    }
}

/// The `sync` object of `/api/state` and every feed response.
public struct SyncIdentity: Codable, Sendable, Equatable {
    public var cursor: Int
    public var privacyEpoch: Int
    public var coreId: String
    public var bootId: String

    public init(cursor: Int = 0, privacyEpoch: Int = 0, coreId: String, bootId: String) {
        self.cursor = cursor; self.privacyEpoch = privacyEpoch; self.coreId = coreId; self.bootId = bootId
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        cursor = c.lenient(.init("cursor"))?.intValue ?? 0
        privacyEpoch = c.lenient(.init("privacyEpoch"))?.intValue ?? 0
        coreId = c.lenient(.init("coreId"))?.stringValue ?? ""
        bootId = c.lenient(.init("bootId"))?.stringValue ?? ""
    }
    /// True when cached content from `self` may be merged with content from `other` (cursor may differ).
    public func sameGeneration(as other: SyncIdentity) -> Bool {
        privacyEpoch == other.privacyEpoch && coreId == other.coreId && bootId == other.bootId
    }
}

/// SSE `change` event data.
public struct ChangeEvent: Codable, Sendable, Equatable {
    public var sync: SyncIdentity
    public var reset: Bool

    public init(sync: SyncIdentity, reset: Bool = false) { self.sync = sync; self.reset = reset }
    public init(from decoder: Decoder) throws {
        sync = try SyncIdentity(from: decoder)
        reset = try decoder.container(keyedBy: AnyKey.self).lenient(.init("reset"))?.boolValue ?? false
    }
    public func encode(to encoder: Encoder) throws {
        try sync.encode(to: encoder)
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(reset, forKey: .init("reset"))
    }
}

struct AnyKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

/// `GET /api/auth/status`: whether the token is signed in, and the NexorAI account it belongs to.
public struct AccountStatus: Decodable, Sendable, Equatable {
    public var authenticated: Bool
    /// The account's display name from the user center, e.g. 演示账号.
    public var displayName: String?
    public var deviceName: String?
    public var expiresAt: Double?

    public init(authenticated: Bool, displayName: String? = nil, deviceName: String? = nil, expiresAt: Double? = nil) {
        self.authenticated = authenticated; self.displayName = displayName; self.deviceName = deviceName; self.expiresAt = expiresAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        authenticated = c.lenient(.init("authenticated"))?.boolValue ?? false
        expiresAt = c.lenient(.init("expiresAt"))?.doubleValue
        let account = c.lenient(.init("account"))?.objectValue
        displayName = account?["displayName"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        deviceName = account?["deviceName"]?.stringValue
    }
}

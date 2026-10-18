import Foundation

/// Any failure talking to Core. `message` is user-presentable (Core's own `error` text where available).
public struct CoreError: Error, LocalizedError, Sendable, Equatable {
    public enum Kind: Sendable, Equatable { case http, network, invalidOrigin, unsupported, identityChanged, decoding, cancelled }
    public var kind: Kind
    public var message: String
    /// HTTP status, when the failure came from a response.
    public var status: Int?
    /// Core's machine-readable `code`, e.g. `identity_unavailable`.
    public var code: String?

    public init(kind: Kind, message: String, status: Int? = nil, code: String? = nil) {
        self.kind = kind; self.message = message; self.status = status; self.code = code
    }
    public var errorDescription: String? { message }

    public static func invalidOrigin(_ message: String) -> CoreError { .init(kind: .invalidOrigin, message: message) }
    public static let cancelled = CoreError(kind: .cancelled, message: "已取消")
    public static func identityChanged(_ message: String) -> CoreError { .init(kind: .identityChanged, message: message, status: 409) }

    /// The stored credential is no longer valid (401/403/409).
    public var invalidatesCredential: Bool { [401, 403, 409].contains(status ?? 0) }
    /// The signed-in session is over (401 or `identity_unavailable`).
    public var endsSession: Bool { status == 401 || code == "identity_unavailable" }
    public var isCancellation: Bool { kind == .cancelled }

    /// Maps any thrown error to a `CoreError`.
    public static func wrap(_ error: Error) -> CoreError {
        if let e = error as? CoreError { return e }
        if error is CancellationError { return .cancelled }
        if let e = error as? URLError {
            if e.code == .cancelled { return .cancelled }
            return .init(kind: .network, message: e.code == .timedOut ? "连接 Core 超时" : "无法连接 Core")
        }
        if error is DecodingError { return .init(kind: .decoding, message: "Core 返回了无法识别的数据") }
        return .init(kind: .network, message: error.localizedDescription)
    }
}

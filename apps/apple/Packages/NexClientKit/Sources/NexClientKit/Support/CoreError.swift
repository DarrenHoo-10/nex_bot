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
    /// Core explicitly rejected the current login.
    public var endsSession: Bool { status == 401 }
    public var isCancellation: Bool { kind == .cancelled }

    /// Maps any thrown error to a `CoreError`.
    public static func wrap(_ error: Error) -> CoreError {
        if let e = error as? CoreError { return e }
        if error is CancellationError { return .cancelled }
        if let e = error as? URLError {
            if e.code == .cancelled { return .cancelled }
            return .init(kind: .network, message: e.code == .timedOut ? "服务响应超时，请稍后重试" : "网络连接失败，请检查网络后重试")
        }
        if error is DecodingError { return .init(kind: .decoding, message: "服务返回的数据无法识别，请稍后重试") }
        // system wording is not for people: one plain line instead
        return .init(kind: .network, message: "操作失败，请稍后重试")
    }

    /// The line for a failed HTTP status when the server sent no wording of its own (same as the web client).
    public static func statusText(_ status: Int) -> String {
        switch status {
        case 0: return "网络连接失败，请检查网络后重试"
        case 401: return "登录已过期，请重新登录"
        case 403: return "没有权限执行这个操作"
        case 404: return "当前服务版本不支持这个功能"
        case 408, 504: return "服务响应超时，请稍后重试"
        case 413: return "内容太大，无法发送"
        case 429: return "请求太频繁，请稍后再试"
        case 502, 503: return "服务暂时不可用，可能正在更新，请稍后重试"
        case 500...: return "服务出错了，请稍后重试"
        default: return "请求失败，请稍后重试"
        }
    }
}

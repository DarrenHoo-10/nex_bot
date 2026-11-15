import Foundation
import Observation

/// A view-owned authorization attempt. Backgrounding suspends polling, not consent.
/// Leaving the connector page cancels both an active attempt and a late start reply.
/// Gmail always uses the web redirect; GitHub uses the redirect when Core has an OAuth
/// app configured and the device-code flow otherwise (a code the user types in).
@MainActor @Observable
public final class ConnectorAuthorization {
    public private(set) var attempt: ConnectorOAuthAttempt?
    public private(set) var authorizationURL: URL?
    /// Device flow: the code the user types in and the page it belongs in.
    public private(set) var userCode: String?
    public private(set) var deviceURL: URL?
    public private(set) var starting = false
    public private(set) var error: String?
    public private(set) var connectedID: String?
    public var busy: Bool { starting || attempt != nil }
    @ObservationIgnored private let workspace: WorkspaceStore
    @ObservationIgnored private let provider: String
    @ObservationIgnored private let allowLoopbackFixture: Bool
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let now: @Sendable () -> Date

    public init(workspace: WorkspaceStore, provider: String = "gmail", allowLoopbackFixture: Bool = false, now: @escaping @Sendable () -> Date = { Date() }) {
        self.workspace = workspace; self.provider = provider; self.allowLoopbackFixture = allowLoopbackFixture; self.now = now
    }

    /// Opens the authorization URL (web flow) or the device page (device flow); nil on failure.
    @discardableResult
    public func start(provider overrideProvider: String? = nil, connectorID: String? = nil) async -> URL? {
        let provider = overrideProvider ?? self.provider
        guard !busy else { return nil }
        generation += 1; let run = generation
        starting = true; error = nil; connectedID = nil
        defer { if generation == run { starting = false } }
        var created: ConnectorOAuthAttempt?
        do {
            let result = try await workspace.startConnectorAuthorization(provider: provider, connectorID: connectorID)
            created = result
            guard generation == run, !Task.isCancelled else { await workspace.cancelConnectorAuthorization(id: result.id); return nil }
            guard !result.id.isEmpty, result.expiresAt.isFinite, result.expiresAt > now().timeIntervalSince1970 * 1000 else {
                throw CoreError(kind: .unsupported, message: "授权已过期，请重新连接")
            }
            let url: URL
            if let code = result.userCode, !code.isEmpty {
                userCode = code
                url = try GithubTools.verificationURL(result.verificationUri ?? "", origin: workspace.client.origin, allowLoopbackFixture: allowLoopbackFixture)
                attempt = result; authorizationURL = nil; deviceURL = url
                return url
            }
            guard let raw = result.authorizationUrl, !raw.isEmpty else {
                throw CoreError(kind: .unsupported, message: "授权响应无效，请重试")
            }
            url = provider == "github"
                ? try GithubTools.authorizationURL(raw, origin: workspace.client.origin, allowLoopbackFixture: allowLoopbackFixture)
                : try GmailTools.authorizationURL(raw, origin: workspace.client.origin, allowLoopbackFixture: allowLoopbackFixture)
            attempt = result; authorizationURL = url; userCode = nil; deviceURL = nil
            return url
        } catch {
            if let created { await workspace.cancelConnectorAuthorization(id: created.id) }
            if generation == run { self.error = CoreError.wrap(error).message; userCode = nil; deviceURL = nil }
            return nil
        }
    }

    public func failedToOpenBrowser() {
        if attempt != nil { error = "无法打开浏览器，请重试" }
    }

    public func poll() async {
        guard let pending = attempt else { return }
        let run = generation
        do {
            guard pending.expiresAt > now().timeIntervalSince1970 * 1000 else { throw CoreError(kind: .unsupported, message: "授权已过期，请重新连接") }
            let result = try await workspace.connectorAuthorizationStatus(id: pending.id)
            guard generation == run, attempt?.id == pending.id, !Task.isCancelled else { return }
            guard result.id == pending.id else { throw CoreError(kind: .unsupported, message: "授权状态无效，请重试") }
            switch result.status {
            case "pending", "exchanging": return
            case "connected":
                guard let id = result.connectorId, !id.isEmpty else { throw CoreError(kind: .unsupported, message: "连接结果无效，请重试") }
                await workspace.refresh()
                guard generation == run, !workspace.ended else { return }
                attempt = nil; authorizationURL = nil; userCode = nil; deviceURL = nil; error = nil; connectedID = id
            case "error", "cancelled": throw CoreError(kind: .unsupported, message: result.error ?? "连接已取消")
            default: throw CoreError(kind: .unsupported, message: "授权状态无效，请重试")
            }
        } catch {
            guard generation == run, !Task.isCancelled else { return }
            self.error = CoreError.wrap(error).message; attempt = nil; authorizationURL = nil; userCode = nil; deviceURL = nil
            await workspace.cancelConnectorAuthorization(id: pending.id)
        }
    }

    public func waitForCompletion() async {
        let run = generation
        while generation == run, attempt != nil, !Task.isCancelled {
            await poll()
            if attempt == nil || Task.isCancelled { return }
            do { try await Task.sleep(for: .seconds(1.2)) } catch { return }
        }
    }

    public func cancel() {
        generation += 1; let pending = attempt
        attempt = nil; authorizationURL = nil; userCode = nil; deviceURL = nil; starting = false; error = nil
        if let pending { Task { await workspace.cancelConnectorAuthorization(id: pending.id) } }
    }
}

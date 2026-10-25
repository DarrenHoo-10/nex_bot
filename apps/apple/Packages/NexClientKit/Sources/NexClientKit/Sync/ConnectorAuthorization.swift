import Foundation
import Observation

/// A view-owned authorization attempt. Backgrounding suspends polling, not consent.
/// Leaving the connector page cancels both an active attempt and a late start reply.
@MainActor @Observable
public final class ConnectorAuthorization {
    public private(set) var attempt: ConnectorOAuthAttempt?
    public private(set) var authorizationURL: URL?
    public private(set) var starting = false
    public private(set) var error: String?
    public private(set) var connectedID: String?
    public var busy: Bool { starting || attempt != nil }
    @ObservationIgnored private let workspace: WorkspaceStore
    @ObservationIgnored private let allowLoopbackFixture: Bool
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let now: @Sendable () -> Date

    public init(workspace: WorkspaceStore, allowLoopbackFixture: Bool = false, now: @escaping @Sendable () -> Date = { Date() }) {
        self.workspace = workspace; self.allowLoopbackFixture = allowLoopbackFixture; self.now = now
    }

    @discardableResult
    public func start(connectorID: String? = nil) async -> URL? {
        guard !busy else { return nil }
        generation += 1; let run = generation
        starting = true; error = nil; connectedID = nil
        defer { if generation == run { starting = false } }
        var created: ConnectorOAuthAttempt?
        do {
            let result = try await workspace.startGmailAuthorization(connectorID: connectorID)
            created = result
            guard generation == run, !Task.isCancelled else { await workspace.cancelGmailAuthorization(id: result.id); return nil }
            guard !result.id.isEmpty, result.expiresAt.isFinite, result.expiresAt > now().timeIntervalSince1970 * 1000 else {
                throw CoreError(kind: .unsupported, message: "授权已过期，请重新连接")
            }
            let url = try GmailTools.authorizationURL(result.authorizationUrl, origin: workspace.client.origin, allowLoopbackFixture: allowLoopbackFixture)
            attempt = result; authorizationURL = url
            return url
        } catch {
            if let created { await workspace.cancelGmailAuthorization(id: created.id) }
            if generation == run { self.error = CoreError.wrap(error).message }
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
            let result = try await workspace.gmailAuthorizationStatus(id: pending.id)
            guard generation == run, attempt?.id == pending.id, !Task.isCancelled else { return }
            guard result.id == pending.id else { throw CoreError(kind: .unsupported, message: "授权状态无效，请重试") }
            switch result.status {
            case "pending", "exchanging": return
            case "connected":
                guard let id = result.connectorId, !id.isEmpty else { throw CoreError(kind: .unsupported, message: "连接结果无效，请重试") }
                await workspace.refresh()
                guard generation == run, !workspace.ended else { return }
                attempt = nil; authorizationURL = nil; error = nil; connectedID = id
            case "error", "cancelled": throw CoreError(kind: .unsupported, message: result.error ?? "连接已取消")
            default: throw CoreError(kind: .unsupported, message: "授权状态无效，请重试")
            }
        } catch {
            guard generation == run, !Task.isCancelled else { return }
            self.error = CoreError.wrap(error).message; attempt = nil; authorizationURL = nil
            await workspace.cancelGmailAuthorization(id: pending.id)
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
        attempt = nil; authorizationURL = nil; starting = false; error = nil
        if let pending { Task { await workspace.cancelGmailAuthorization(id: pending.id) } }
    }
}

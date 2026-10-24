import Foundation
import Observation

public enum ConnectionStatus: Sendable, Equatable {
    /// First connect, nothing loaded yet.
    case connecting
    case connected
    /// The link dropped; private content is hidden until the next successful sync.
    case resyncing
}

/// Timing knobs. Defaults are the values from the design; tests shrink them.
public struct SyncTiming: Sendable {
    public var debounce: Double = 0.15
    public var fallbackInterval: Double = 10
    public var backoff = Backoff()
    public init(debounce: Double = 0.15, fallbackInterval: Double = 10, backoff: Backoff = Backoff()) {
        self.debounce = debounce; self.fallbackInterval = fallbackInterval; self.backoff = backoff
    }
}

/// Why a signed-in session ended.
public struct SessionEnd: Sendable, Equatable {
    public var message: String
    /// The stored credential must be deleted (401/403/409 or a `revoked` event).
    public var deleteCredential: Bool
}

/// Owns the `/api/state` snapshot, the sync identity, the SSE lifecycle and the per-bot ``ConversationStore``s.
@MainActor @Observable
public final class WorkspaceStore {
    public static let resyncMessage = "正在重新同步…"
    public static let expiredMessage = "此设备的登录已过期或被撤销，请重新连接。"

    /// The Core client. Its bearer token changes when the session is refreshed (see ``enableSessionRefresh(expiresAt:coreID:persist:)``),
    /// so read it at call time instead of keeping a copy.
    public private(set) var client: CoreClient
    /// Latest snapshot; nil until the first sync and while resyncing.
    public private(set) var state: WorkspaceState?
    public private(set) var sync: SyncIdentity?
    public private(set) var connection: ConnectionStatus = .connecting
    /// Human-readable status such as "正在重新同步…"; nil when healthy.
    public private(set) var notice: String?
    /// The bot whose conversation is kept in sync. Set with ``select(_:)``.
    public private(set) var selectedBotID: String?
    public private(set) var sessions: [ClientSession] = []
    public private(set) var currentSessionID: String?
    /// The signed-in NexorAI account (display name), loaded when the store starts; nil until then or if unavailable.
    public private(set) var account: AccountStatus?
    /// Called once when the session ends (expired, revoked, identity unavailable).
    @ObservationIgnored public var onSessionEnded: (@MainActor (SessionEnd) -> Void)?

    public var bots: [Bot] { state?.bots ?? [] }
    public var approvals: [Approval] { state?.approvals ?? [] }
    public func approvalRules(botID: String) -> [ApprovalRule] { state?.approvalRules.filter { $0.botID == botID } ?? [] }
    public var pendingApprovalCount: Int { approvals.count }
    public func bot(_ id: String) -> Bot? { state?.bots.first { $0.id == id } }

    @ObservationIgnored private let timing: SyncTiming
    @ObservationIgnored private var conversations: [String: ConversationStore] = [:]
    @ObservationIgnored private var serial = 0
    @ObservationIgnored private var started = false
    @ObservationIgnored private(set) var ended = false
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var timerTask: Task<Void, Never>?
    @ObservationIgnored private var debounceTask: Task<Void, Never>?
    @ObservationIgnored private var lastEventID: String?
    @ObservationIgnored private var streamEpoch = 0
    @ObservationIgnored private var tokenGeneration = 0
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var sessionExpiry: Double?
    @ObservationIgnored private var sessionCoreID: String?
    @ObservationIgnored private var persistRefresh: (@MainActor (LoginSession) async -> Void)?
    /// Clock for the refresh policy; tests replace it.
    @ObservationIgnored var now: @Sendable () -> Date = { Date() }

    public init(client: CoreClient, timing: SyncTiming = SyncTiming()) {
        self.client = client; self.timing = timing
    }

    /// The (cached) conversation for a bot. Drafts and the send retry record live as long as the store.
    public func conversation(for botID: String) -> ConversationStore {
        if let c = conversations[botID] { return c }
        let c = ConversationStore(botID: botID, workspace: self); conversations[botID] = c; return c
    }

    /// Chooses the open conversation and loads it.
    public func select(_ botID: String?) {
        // Choosing another contact (or none) leaves a search-result view; the open conversation keeps it. Use ``showLatest(botID:)``
        // to leave it deliberately.
        for (id, c) in conversations where id != botID && c.focusedMessageID != nil { leaveHistory(id, reload: false) }
        guard botID != selectedBotID else { return }
        selectedBotID = botID
        if started { scheduleRefresh(after: 0) }
    }

    /// Opens the conversation around a search hit: the window from 40 messages before it to 60 from it, see
    /// ``ConversationStore/focusedMessageID``. If the message is forgotten or archived meanwhile, the latest messages load instead.
    public func openSearchResult(_ match: ConversationMatch) {
        for (id, c) in conversations where id != match.botID && c.focusedMessageID != nil { leaveHistory(id, reload: false) }
        serial += 1
        let conv = conversation(for: match.botID)
        conv.reset()
        conv.focusedMessageID = match.id
        selectedBotID = match.botID
        if started { scheduleRefresh(after: 0) }
    }

    /// Ends the search-result view of `botID` and loads the latest messages.
    public func showLatest(botID: String) { leaveHistory(botID) }

    /// Returns true when `botID` was in a search-result view.
    @discardableResult
    func leaveHistory(_ botID: String, reload: Bool = true) -> Bool {
        guard let conv = conversations[botID], conv.focusedMessageID != nil else { return false }
        serial += 1
        conv.focusedMessageID = nil
        conv.reset()
        if reload, started, selectedBotID == botID { scheduleRefresh(after: 0) }
        return true
    }

    // MARK: Lifecycle

    /// Opens the event stream and the fallback timer and does a full refresh. Call again after ``stop()`` (iOS foreground).
    public func start() {
        guard !ended, !started else { return }
        started = true
        if state == nil { connection = .connecting }
        openStream()
        let interval = timing.fallbackInterval
        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(interval))
                guard !Task.isCancelled, let self else { return }
                // Rotate a near-expiry token first, so the poll below already uses the new one.
                await self.refreshSessionIfNeeded()
                guard !Task.isCancelled else { return }
                self.scheduleRefresh()
            }
        }
        scheduleRefresh(after: 0)
        if account == nil { Task { await loadAccount() } }
        Task { await refreshSessionIfNeeded() }
    }

    private func openStream() {
        streamTask?.cancel()
        streamEpoch += 1
        let epoch = streamEpoch
        let stream = EventStream(client: client, lastEventID: lastEventID, backoff: timing.backoff)
        streamTask = Task { [weak self] in
            for await event in stream.events() { guard let self, self.streamEpoch == epoch else { return }; self.handle(event) }
        }
    }

    // MARK: Session refresh

    /// Starts the refresh policy for this login. The session is refreshed (`POST /api/auth/refresh`) when `expiresAt`
    /// (epoch ms) is within 30 minutes, checked on the fallback tick, on ``start()`` and by ``refreshSessionIfNeeded()``.
    /// `AppModel` does this for you. `persist` runs after the new token is already in use; it must save the credential.
    public func enableSessionRefresh(expiresAt: Double, coreID: String, persist: @escaping @MainActor (LoginSession) async -> Void) {
        sessionExpiry = expiresAt; sessionCoreID = coreID; persistRefresh = persist
    }

    /// Lead time before expiry at which a refresh starts (30 minutes, as on Android).
    public static let refreshLead: Double = 30 * 60_000
    /// True when `expiresAt` is in the future but at most ``refreshLead`` away.
    public static func shouldRefresh(now: Date, expiresAt: Double) -> Bool {
        let ms = now.timeIntervalSince1970 * 1000
        return expiresAt > ms && expiresAt - ms <= refreshLead
    }

    /// Refreshes the session token when it is close to expiry; never runs two refreshes at once. 401 ends the session as
    /// usual. 409 (another rotation won), 429, network and malformed answers keep the current token and retry on the next tick.
    /// A success swaps ``client``'s token, calls the persist hook and restarts the event stream without clearing content.
    public func refreshSessionIfNeeded() async {
        if let task = refreshTask { await task.value; return }
        guard !ended, let expiry = sessionExpiry, Self.shouldRefresh(now: now(), expiresAt: expiry) else { return }
        let task = Task { await performSessionRefresh() }
        refreshTask = task
        await task.value
    }

    private func performSessionRefresh() async {
        defer { refreshTask = nil }
        do {
            let granted = try await client.refreshSession()
            guard !granted.token.isEmpty, granted.coreId == (sessionCoreID ?? sync?.coreId ?? granted.coreId), granted.expiresAt > 0 else { return }
            guard !ended else { return }
            tokenGeneration += 1
            client = client.withToken(granted.token)
            sessionExpiry = granted.expiresAt
            if started { openStream() }
            await persistRefresh?(granted)
        } catch {
            let e = CoreError.wrap(error)
            if e.status == 401 { refreshTask = nil; report(e) }
        }
    }

    /// Loads ``account`` from `/api/auth/status`. Failures leave it unchanged; session expiry is handled by sync.
    public func loadAccount() async {
        if let status = try? await client.authStatus(), status.authenticated { account = status }
    }

    /// Closes the stream and timers and discards in-flight responses. Cached content is kept.
    public func stop() {
        started = false; serial += 1
        streamTask?.cancel(); timerTask?.cancel(); debounceTask?.cancel()
        streamTask = nil; timerTask = nil; debounceTask = nil
    }

    // MARK: Refresh

    /// Refreshes now (pull to refresh, after an action).
    public func refresh() async {
        debounceTask?.cancel(); debounceTask = nil
        await reload()
    }

    func scheduleRefresh(after delay: Double? = nil) {
        guard started, !ended, debounceTask == nil else { return }
        let wait = delay ?? timing.debounce
        debounceTask = Task { [weak self] in
            if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
            guard !Task.isCancelled, let self else { return }
            self.debounceTask = nil
            await self.reload()
        }
    }

    func handle(_ event: StreamEvent) {
        switch event {
        case .connected: break
        case .event(let e):
            if let id = e.id { lastEventID = id }
            switch e.event {
            case "change":
                guard let data = e.data.data(using: .utf8), let change = try? JSONDecoder().decode(ChangeEvent.self, from: data) else { return }
                handleChange(change)
            case "revoked": endSession(SessionEnd(message: Self.expiredMessage, deleteCredential: true))
            default: break
            }
        case .disconnected: offline()
        case .failed(let error): _ = report(error)
        }
    }

    func handleChange(_ change: ChangeEvent) {
        if change.reset || (sync.map { !$0.sameGeneration(as: change.sync) } ?? false) { clearContent() }
        scheduleRefresh()
    }

    /// Drops every cached message, streaming text and snapshot; in-flight responses become stale.
    func clearContent() {
        serial += 1
        state = nil; sync = nil; sessions = []
        for c in conversations.values { c.reset() }
    }

    func offline() {
        clearContent()
        connection = .resyncing; notice = Self.resyncMessage
    }

    /// Routes an error: ends the session when needed, otherwise returns it for display.
    @discardableResult
    func report(_ error: Error) -> CoreError {
        let e = CoreError.wrap(error)
        // While a refresh is in flight a 401 may just mean the old token was rotated; the refresh result decides.
        if e.endsSession && !(e.status == 401 && refreshTask != nil) { endSession(SessionEnd(message: Self.expiredMessage, deleteCredential: e.invalidatesCredential)) }
        return e
    }

    func endSession(_ end: SessionEnd) {
        guard !ended else { return }
        ended = true
        stop(); clearContent()
        for c in conversations.values { c.discardDraft() }
        connection = .resyncing; notice = end.message
        onSessionEnded?(end)
    }

    private func reload() async {
        let generation = tokenGeneration
        do { try await performReload() }
        catch {
            let e = CoreError.wrap(error)
            if e.isCancellation { return }
            if e.status == 401 {
                // A request signed with a token that was rotated meanwhile is not a lost session.
                if let task = refreshTask { await task.value }
                if generation != tokenGeneration, !ended { scheduleRefresh(after: 0); return }
            }
            if e.endsSession { report(e) } else { offline() }
        }
    }

    private func performReload() async throws {
        serial += 1
        let request = serial, current = selectedBotID
        let conv = current.map(conversation(for:))
        // The feed request goes out together with the state; its sync identity is checked against the state afterwards.
        let target = conv?.focusedMessageID
        let guess = (target == nil && conv?.loadedSync != nil && conv?.messages.isEmpty == false) ? conv : nil
        let afterSeq = guess?.messages.last?.seq
        async let early = Self.capture(client, bot: current, after: afterSeq, around: target)
        let next = try await client.state(view: .summary)
        guard request == serial else { return }
        if let old = sync, !old.sameGeneration(as: next.sync) { for c in conversations.values { c.reset() } }
        state = next; sync = next.sync; connection = .connected

        if let current, let conv {
            if !next.bots.contains(where: { $0.id == current }) {
                conv.focusedMessageID = nil; conv.reset(); selectedBotID = next.bots.first?.id; notice = nil
                if selectedBotID != nil { scheduleRefresh(after: 0) }
                return
            }
            let same = conv.loadedSync?.sameGeneration(as: next.sync) == true && guess != nil
            var history = same ? conv.messages : []
            var feed: Feed
            do { feed = try await (same || guess == nil ? early!.get() : client.feed(bot: current)) }
            catch {
                // The searched message was forgotten or its assistant archived: fall back to the latest messages.
                guard target != nil, CoreError.wrap(error).message == messageGoneMessage else { throw error }
                guard request == serial, selectedBotID == current else { return }
                conv.focusedMessageID = nil
                feed = try await client.feed(bot: current)
            }
            let fresh = !same, firstCount = feed.messages.count
            while true {
                guard request == serial, selectedBotID == current else { return }
                guard feed.sync.sameGeneration(as: next.sync) else { clearContent(); scheduleRefresh(after: 0); return }
                let last = history.last?.seq ?? 0
                history += feed.messages.filter { $0.seq > last }
                if !feed.hasMore { break }
                feed = try await client.feed(bot: current, after: history.last?.seq ?? 0)
            }
            guard request == serial, selectedBotID == current else { return }
            conv.commit(history, sync: feed.sync, streaming: feed.streaming, hasOlder: fresh ? firstCount >= 100 : nil)
            if conv.focusedMessageID == nil { Task { await conv.markReadIfNeeded() } }
        }
        if request == serial { notice = nil }
    }

    private static func capture(_ client: CoreClient, bot: String?, after: Int?, around: String?) async -> Result<Feed, CoreError>? {
        guard let bot else { return nil }
        do { return .success(try await client.feed(bot: bot, after: after, around: around)) } catch { return .failure(CoreError.wrap(error)) }
    }

    // MARK: Actions

    /// Approve or deny. Only the first decision wins; later ones throw Core's error text.
    public func decide(_ approval: Approval, allow: Bool, remember: Bool = false) async throws {
        do { try await client.decide(approval: approval.id, hash: approval.argumentHash, allow: allow, remember: remember) } catch { throw report(error) }
        await refresh()
    }

    public func revokeApprovalRule(_ rule: ApprovalRule) async throws {
        do { try await client.revokeApprovalRule(id: rule.id, botID: rule.botID) } catch { throw report(error) }
        await refresh()
    }

    /// Loads `/api/clients` into ``sessions``.
    public func loadSessions() async throws {
        do { let list = try await client.clientSessions(); sessions = list.sessions; currentSessionID = list.currentSessionId }
        catch { throw report(error) }
    }

    public func revokeSession(_ id: String) async throws {
        do { try await client.revoke(sessionID: id) } catch { throw report(error) }
        try await loadSessions()
    }
}

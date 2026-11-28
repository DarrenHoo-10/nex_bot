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
    var cacheSessionID: String?
    @ObservationIgnored var diskCacheScope: String?
    public var contentCacheScope: String? { state == nil ? nil : diskCacheScope }
    public private(set) var connection: ConnectionStatus = .connecting
    /// Human-readable status such as "正在重新同步…"; nil when healthy.
    public private(set) var notice: String?
    /// The bot whose conversation is kept in sync. Set with ``select(_:)``.
    public private(set) var financeBotID: String?
    public private(set) var selectedBotID: String?
    public private(set) var sessions: [ClientSession] = []
    public private(set) var currentSessionID: String?
    /// The signed-in NexorAI account (display name), loaded when the store starts; nil until then or if unavailable.
    public private(set) var account: AccountStatus?
    var pendingAgentModels: [String: AgentModelChoice] = [:]
    var savedAgentModels: [String: AgentModelReceipt] = [:]
    /// Called once when the session ends (expired, revoked, identity unavailable).
    @ObservationIgnored private var memoryEpochs: [String: Int] = [:]
    @ObservationIgnored public var onSessionEnded: (@MainActor (SessionEnd) -> Void)?

    @ObservationIgnored private var topicWindows: [String: [AgentMessage]] = [:]
    @ObservationIgnored private var recentTopicKeys: [String] = []

    public func cachedTopicMessages(botID: String, topicID: String) -> [AgentMessage] {
        topicWindows[botID + ":" + topicID] ?? []
    }

    public func rememberTopicMessages(_ messages: [AgentMessage], botID: String, topicID: String, generation: SyncIdentity) {
        guard sync?.sameGeneration(as: generation) == true else { return }
        let key = botID + ":" + topicID
        topicWindows[key] = Array(messages.suffix(250))
        recentTopicKeys.removeAll { $0 == key }
        recentTopicKeys.append(key)
        if recentTopicKeys.count > 12 { topicWindows.removeValue(forKey: recentTopicKeys.removeFirst()) }
    }

    @ObservationIgnored var feishuGroupLists: [String: (expires: Date, value: FeishuGroupList)] = [:]

    @ObservationIgnored private var assetEpoch = 0
    @ObservationIgnored private var localAssets: [String: (expires: Date, data: Data, filename: String)] = [:]

    func cachedAsset(_ key: String, load: () async throws -> (data: Data, filename: String)) async throws -> (data: Data, filename: String) {
        let now = Date()
        if let cached = localAssets[key], cached.expires > now { return (cached.data, cached.filename) }
        let epoch = assetEpoch
        let result = try await load()
        guard assetEpoch == epoch else { throw CancellationError() }
        if result.data.count <= 2 * 1024 * 1024 {
            localAssets = localAssets.filter { $0.value.expires > now }
            if localAssets.count >= 16, let oldest = localAssets.min(by: { $0.value.expires < $1.value.expires })?.key {
                localAssets.removeValue(forKey: oldest)
            }
            localAssets[key] = (Date().addingTimeInterval(300), result.data, result.filename)
        }
        return result
    }

    func clearLocalAssets() {
        assetEpoch += 1
        localAssets.removeAll()
        feishuGroupLists.removeAll()
    }

    public var bots: [Bot] { state?.bots ?? [] }

    public func feishuReceiverID(selection: String) -> String {
        bots.contains(where: { $0.id == selection }) ? selection : ""
    }
    public var approvals: [Approval] { state?.approvals ?? [] }
    public func approvalRules(botID: String) -> [ApprovalRule] { state?.approvalRules.filter { $0.botID == botID } ?? [] }
    public var pendingApprovalCount: Int { approvals.count }
    public func bot(_ id: String) -> Bot? { state?.bots.first { $0.id == id } }
    public func hasTopics(for botID: String) -> Bool {
        if let bot = bot(botID), bot.topicCount > 0 { return true }
        return state?.feishu?.apps.contains(where: { $0.botID == botID }) == true
    }

    @ObservationIgnored private let timing: SyncTiming
    @ObservationIgnored private var conversations: [String: ConversationStore] = [:]
    @ObservationIgnored private var serial = 0
    @ObservationIgnored private var started = false
    @ObservationIgnored private(set) var ended = false
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var timerTask: Task<Void, Never>?
    @ObservationIgnored private var debounceTask: Task<Void, Never>?
    @ObservationIgnored private var lastEventID: String?
    @ObservationIgnored private var lastFrame: Date?
    @ObservationIgnored private var chatVisible = true
    @ObservationIgnored private var visibleResources: Set<String> = []

    public func setResourceVisible(_ resource: String, _ visible: Bool) {
        let changed = visible ? visibleResources.insert(resource).inserted : visibleResources.remove(resource) != nil
        if changed { serial += 1; scheduleRefresh(after: 0) }
    }
    @ObservationIgnored private var activeTopic: (bot: String, id: String)?
    @ObservationIgnored private var needsLiveCatchUp = true
    @ObservationIgnored private var refreshQueued = false
    public private(set) var topicLiveReplies: [StreamingText] = []
    public private(set) var topicRecovery = 0
    @ObservationIgnored var topicCatchUpRequired = true

    func didSyncTopic(botID: String, conversationID: String) {
        if activeTopic?.bot == botID && activeTopic?.id == conversationID { topicCatchUpRequired = false }
    }
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

    public func loadFinanceAssistant() async {
        guard connection == .connected else { return }
        let token = client.token
        do {
            let assistant = try await client.financeAssistant()
            guard !ended, token == client.token, connection == .connected else { return }
            financeBotID = assistant.botId
            await refresh()
            if selectedBotID == nil { select(assistant.botId) }
        } catch { if selectedBotID == nil { select(bots.first?.id) } }
    }

    /// The (cached) conversation for a bot. Drafts and the send retry record live as long as the store.
    public func conversation(for botID: String) -> ConversationStore {
        if let c = conversations[botID] { return c }
        let c = ConversationStore(botID: botID, workspace: self); conversations[botID] = c; return c
    }

    private func armConversationEntry(_ botID: String) {
        let conv = conversation(for: botID)
        if let bot = self.bot(botID), bot.unreadCount > bot.topicUnreadCount {
            conv.prepareUnreadJump(readSeq: bot.readSeq)
        } else {
            conv.prepareBottomEntry()
        }
    }

    /// Chooses the open conversation and loads it.
    public func select(_ botID: String?) {
        // Choosing another contact (or none) leaves a search-result view; the open conversation keeps it. Use ``showLatest(botID:)``
        // to leave it deliberately.
        for (id, c) in conversations where id != botID && c.focusedMessageID != nil { leaveHistory(id, reload: false) }
        guard botID != selectedBotID else { return }
        if let botID {
            armConversationEntry(botID)
        }
        selectedBotID = botID
        if started { openStream(); scheduleRefresh(after: 0) }
    }

    public func setChatVisible(_ visible: Bool) {
        guard chatVisible != visible else { return }
        chatVisible = visible
        if visible, let botID = selectedBotID, conversation(for: botID).pendingUnreadReadSeq == nil {
            armConversationEntry(botID)
        }
        serial += 1
        if started { openStream(); scheduleRefresh(after: 0) }
    }

    public func watchTopic(botID: String, conversationID: String?) {
        let id = conversationID ?? ""
        guard activeTopic?.bot != botID || activeTopic?.id != id else { return }
        activeTopic = (botID, id)
        topicLiveReplies = []
        serial += 1
        if started { openStream(); scheduleRefresh(after: 0) }
    }

    public func leaveTopics(botID: String) {
        guard activeTopic?.bot == botID else { return }
        activeTopic = nil
        topicLiveReplies = []
        serial += 1
        if started { openStream(); scheduleRefresh(after: 0) }
    }

    public func updateTopicLiveReplies(_ replies: [StreamingText], botID: String, conversationID: String) {
        guard activeTopic?.bot == botID, activeTopic?.id == conversationID else { return }
        topicLiveReplies = replies.map { reply in
            if let live = topicLiveReplies.first(where: { $0.taskId == reply.taskId }), live.text.hasPrefix(reply.text) { return live }
            return reply
        }
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
        if started { openStream(); scheduleRefresh(after: 0) }
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
                if self.lastFrame.map({ Date().timeIntervalSince($0) < 25 }) != true { self.scheduleRefresh() }
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
        lastFrame = nil
        needsLiveCatchUp = true
        topicCatchUpRequired = true
        var query = [("incremental", "1")]
        if chatVisible {
            if let topic = activeTopic {
                if !topic.id.isEmpty { query += [("bot", topic.bot), ("conversationId", topic.id)] }
            } else if let bot = selectedBotID, bot != financeBotID {
                query.append(("bot", bot))
            }
        }
        let stream = EventStream(client: client, query: query, lastEventID: lastEventID, backoff: timing.backoff)
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

    /// Records that Core accepted `conversation`'s send at the current reload serial.
    func noteAcceptedSend(_ conversation: ConversationStore) {
        conversation.sendAcceptedSerial = serial
    }

    /// Drops typing rows whose accept is older than this published snapshot.
    private func releaseAcceptedSends(_ request: Int) {
        for conversation in conversations.values {
            if let mark = conversation.sendAcceptedSerial, request > mark { conversation.finishSending() }
        }
    }

    /// Refreshes now (pull to refresh, after an action).
    public func refresh() async {
        debounceTask?.cancel(); debounceTask = nil
        await reload()
    }

    func scheduleRefresh(after delay: Double? = nil) {
        guard started, !ended else { return }
        if debounceTask != nil { refreshQueued = true; return }
        let wait = delay ?? timing.debounce
        debounceTask = Task { [weak self] in
            if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
            guard !Task.isCancelled, let self else { return }
            await self.reload()
            guard !Task.isCancelled else { return }
            self.debounceTask = nil
            if self.refreshQueued {
                self.refreshQueued = false
                self.scheduleRefresh()
            }
        }
    }

    func handle(_ event: StreamEvent) {
        switch event {
        case .connected:
            needsLiveCatchUp = true
            if activeTopic?.id.isEmpty == false { topicCatchUpRequired = true; topicRecovery += 1 }
        case .event(let e):
            lastFrame = Date()
            if let id = e.id { lastEventID = id }
            switch e.event {
            case "change":
                guard let data = e.data.data(using: .utf8), let change = try? JSONDecoder().decode(ChangeEvent.self, from: data) else { return }
                handleChange(change)
            case "delta":
                struct Delta: Decodable { var taskId: String; var offset: Int; var text: String }
                guard chatVisible, let delta = try? JSONDecoder().decode(Delta.self, from: Data(e.data.utf8)) else { return }
                let applied: Bool
                if activeTopic != nil {
                    applied = ConversationStore.applyDelta(to: &topicLiveReplies, taskID: delta.taskId, offset: delta.offset, text: delta.text)
                } else if let botID = selectedBotID {
                    applied = conversation(for: botID).appendLiveReply(taskID: delta.taskId, offset: delta.offset, text: delta.text)
                } else { return }
                if !applied {
                    if activeTopic != nil {
                        if !topicCatchUpRequired { topicCatchUpRequired = true; topicRecovery += 1 }
                    } else if !needsLiveCatchUp { needsLiveCatchUp = true; scheduleRefresh() }
                }
            case "revoked": endSession(SessionEnd(message: Self.expiredMessage, deleteCredential: true))
            default: break
            }
        case .disconnected: lastFrame = nil; offline()
        case .failed(let error): _ = report(error)
        }
    }

    func handleChange(_ change: ChangeEvent) {
        if (change.reset && change.sync.revision == nil)
            || sync.map({ !$0.sameGeneration(as: change.sync) || $0.cursor > change.sync.cursor }) == true { clearContent() }
        if needsLiveCatchUp || change.sync.revision == nil || sync != change.sync { scheduleRefresh() }
    }

    /// Drops every cached message, streaming text and snapshot; in-flight responses become stale.
    func clearContent(invalidateDisk: Bool = true) {
        serial += 1
        if invalidateDisk, let scope = diskCacheScope {
            diskCacheScope = nil
            Task { await LocalContentCache.shared.clear(scope) }
        }
        state = nil; sync = nil; sessions = []; financeBotID = nil
        clearLocalAssets()
        topicWindows.removeAll(); recentTopicKeys.removeAll(); topicLiveReplies = []
        for c in conversations.values { c.reset() }
    }

    func offline() {
        clearContent(invalidateDisk: false)
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
        let showingChat = chatVisible && activeTopic == nil && (current == nil || current != financeBotID)
        let conv = showingChat ? current.map(conversation(for:)) : nil
        let target = conv?.focusedMessageID
        let topic = activeTopic.flatMap { $0.id.isEmpty ? nil : $0 }
        let next = try await client.workspaceState(page: chatVisible ? "chat" : "tasks",
            botID: chatVisible ? topic?.bot ?? current : nil, conversationID: topic?.id, resources: visibleResources.sorted())
        guard request == serial else { return }
        if let sessionID = cacheSessionID, !sessionID.isEmpty, !next.sync.coreId.isEmpty, !next.sync.bootId.isEmpty {
            let scope = LocalContentCache.digest("\(sessionID):\(next.sync.coreId):\(next.sync.bootId):\(next.sync.privacyEpoch)")
            if diskCacheScope != scope {
                await LocalContentCache.shared.authorize(scope)
                guard request == serial else { return }
                diskCacheScope = scope
            }
        }
        let nextEpochs = Dictionary(uniqueKeysWithValues: next.bots.map { ($0.id, $0.row.int("memory_epoch") ?? 0) })
        for (id, epoch) in memoryEpochs where nextEpochs[id] != epoch {
            conversations[id]?.discardDraft()
            conversations[id]?.focusedMessageID = nil
        }
        memoryEpochs = nextEpochs
        if let old = sync, !old.sameGeneration(as: next.sync) {
            clearLocalAssets()
            topicWindows.removeAll(); recentTopicKeys.removeAll(); topicLiveReplies = []
            for c in conversations.values { c.reset() }
        }
        if let current, let conv {
            if !next.bots.contains(where: { $0.id == current }) {
                state = next; sync = next.sync; connection = .connected
                conv.focusedMessageID = nil; conv.reset(); selectedBotID = next.bots.first(where: { $0.row.string("replaces_id") == current })?.id ?? next.bots.first?.id; notice = nil
                releaseAcceptedSends(request)
                if selectedBotID != nil { scheduleRefresh(after: 0) }
                return
            }
            let memoryHit = target == nil && conv.loadedSync?.sameGeneration(as: next.sync) == true
            let cached = !memoryHit && target == nil ? await cachedHistory(for: current) : nil
            guard request == serial, selectedBotID == current else { return }
            let cacheHit = cached?.sync.sameGeneration(as: next.sync) == true && (cached?.sync.cursor ?? 0) <= next.sync.cursor
            let same = memoryHit || cacheHit
            var history = memoryHit ? conv.messages : cacheHit ? cached?.messages ?? [] : []
            let known = memoryHit ? conv.loadedSync : cacheHit ? cached?.sync : nil
            let feedAfterAccept = target == nil && conv.sendAcceptedSerial.map { request > $0 } == true
            let advanced = next.historySeq.map { $0 > (history.last?.seq ?? 0) } ?? (known?.cursor != next.sync.cursor)
            var feed: Feed?
            if !same || target != nil || feedAfterAccept || advanced
                || (needsLiveCatchUp && (next.unfinishedTask(botID: current) != nil || !conv.streaming.isEmpty)) || next.sync.revision == nil {
                do {
                    feed = try await client.feed(bot: current, after: same ? (history.last?.seq ?? 0) : nil, around: target,
                        at: target != nil || !same ? next.sync.at : history.last?.row.int("created_at") ?? 0)
                } catch {
                    guard target != nil, CoreError.wrap(error).message == messageGoneMessage else { throw error }
                    guard request == serial, selectedBotID == current else { return }
                    conv.focusedMessageID = nil
                    feed = try await client.feed(bot: current, at: next.sync.at)
                }
            }
            var older = same ? (memoryHit ? conv.hasOlder : cached?.hasOlder) : feed.map { $0.hasOlder ?? ($0.messages.count >= 100) }
            while let page = feed {
                guard request == serial, selectedBotID == current else { return }
                guard page.sync.sameGeneration(as: next.sync) else { clearContent(); scheduleRefresh(after: 0); return }
                let last = history.last?.seq ?? 0
                history += page.messages.filter { $0.seq > last }
                guard page.hasMore, let lastRow = page.messages.last, lastRow.seq > last else { break }
                feed = try await client.feed(bot: current, after: lastRow.seq, at: lastRow.row.int("created_at") ?? 0)
            }
            guard request == serial, selectedBotID == current else { return }
            if target == nil, (!conv.isLoaded || conv.awaitingFreshUnread), conv.pendingUnreadReadSeq == nil,
               let nextBot = next.bots.first(where: { $0.id == current }),
               nextBot.unreadCount > nextBot.topicUnreadCount {
                conv.prepareUnreadJump(readSeq: nextBot.readSeq)
            }
            if target == nil, let unreadReadSeq = conv.pendingUnreadReadSeq {
                var backfilled = 0
                while backfilled < 4, older == true, let first = history.first, first.seq > unreadReadSeq + 1 {
                    let page = try await client.feed(bot: current, before: first.seq, at: first.row.int("created_at"))
                    guard request == serial, selectedBotID == current else { return }
                    guard page.sync.sameGeneration(as: next.sync) else { break }
                    older = page.hasOlder ?? (page.messages.count >= 100)
                    let prepended = page.messages.filter { $0.seq < first.seq }
                    if prepended.isEmpty { older = false; break }
                    history = prepended + history
                    backfilled += 1
                }
            }
            let feedSync = feed?.sync ?? next.sync
            let streaming = feed.map { page in
                page.streaming.map { partial in
                    conv.streaming.first(where: { $0.taskId == partial.taskId && $0.text.hasPrefix(partial.text) }) ?? partial
                }
            } ?? conv.streaming
            conv.commit(history, sync: feedSync, streaming: streaming, hasOlder: older)
            if target == nil, feed != nil, let scope = diskCacheScope {
                let page = Feed(messages: Array(history.suffix(200)), sync: feedSync, hasOlder: history.count > 200 || (older ?? false))
                Task { await LocalContentCache.shared.enqueue(page, scope: scope, key: "history:" + current) }
            }
            if conv.focusedMessageID == nil { Task { await conv.markReadIfNeeded() } }
        }
        // Publish task status and the matching transcript in one MainActor turn.
        // Otherwise a finished task hides the typing row while its reply is still loading.
        if request == serial {
            needsLiveCatchUp = false
            state = next; sync = next.sync; connection = .connected; notice = nil
            releaseAcceptedSends(request)
        }
    }

    private func cachedHistory(for bot: String) async -> Feed? {
        guard let scope = diskCacheScope else { return nil }
        let cached = await LocalContentCache.shared.load(Feed.self, scope: scope, key: "history:" + bot)
        return scope == diskCacheScope ? cached : nil
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

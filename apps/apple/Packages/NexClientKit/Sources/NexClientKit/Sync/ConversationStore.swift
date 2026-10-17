import Foundation
import Observation

/// One bot's conversation: message window, live streaming text, draft and send/stop actions.
@MainActor @Observable
public final class ConversationStore {
    public let botID: String
    /// Oldest first, strictly increasing `seq`.
    public private(set) var messages: [AgentMessage] = []
    /// Live partial replies, one per running task.
    public private(set) var streaming: [StreamingText] = []
    /// More history exists before ``messages``.first; call ``loadOlder()``.
    public private(set) var hasOlder = false
    public private(set) var isLoadingOlder = false
    /// The first page for the current generation has arrived.
    public private(set) var isLoaded = false
    /// Last send or load error text (Core's message).
    public private(set) var sendError: String?
    public private(set) var isSending = false
    /// Composer text. Survives resets; discarded only when the session ends.
    public var draft = ""
    /// Set by the UI while this conversation is visible and the window/scene is active; enables read receipts.
    public var isActive = false { didSet { if isActive && !oldValue { Task { await markReadIfNeeded() } } } }

    @ObservationIgnored let workspace: WorkspaceStore
    @ObservationIgnored var loadedSync: SyncIdentity?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var readPosition = 0
    /// Same text keeps the same clientId, so a retry after a network error is never a duplicate.
    @ObservationIgnored private(set) var pending: (text: String, clientID: String)?

    init(botID: String, workspace: WorkspaceStore) { self.botID = botID; self.workspace = workspace }

    /// The bot's newest unfinished task, if any.
    public var activeTask: AgentTask? { workspace.state?.unfinishedTask(botID: botID) }
    public var canStop: Bool { activeTask.map { $0.status != "cancelling" } ?? false }

    func commit(_ history: [AgentMessage], sync: SyncIdentity, streaming: [StreamingText], hasOlder: Bool?) {
        messages = history; loadedSync = sync; isLoaded = true
        self.streaming = streaming.filter { !$0.text.isEmpty }
        if let hasOlder { self.hasOlder = hasOlder }
    }

    func reset() {
        generation += 1
        messages = []; streaming = []; hasOlder = false; isLoadingOlder = false; isLoaded = false
        loadedSync = nil; readPosition = 0
    }

    func discardDraft() { draft = ""; pending = nil; sendError = nil }

    /// Fetches the 100 messages before the oldest loaded one.
    public func loadOlder() async {
        guard hasOlder, !isLoadingOlder, let first = messages.first?.seq, let sync = loadedSync else { return }
        isLoadingOlder = true
        let gen = generation
        defer { if gen == generation { isLoadingOlder = false } }
        do {
            let feed = try await workspace.client.feed(bot: botID, before: first)
            guard gen == generation else { return }
            guard feed.sync.sameGeneration(as: sync) else { workspace.clearContent(); await workspace.refresh(); return }
            messages = feed.messages.filter { $0.seq < first } + messages
            hasOlder = feed.messages.count >= 100
        } catch {
            guard gen == generation else { return }
            sendError = workspace.report(error).message
        }
    }

    /// Sends `text` (default: the draft). Returns true when Core accepted it. On failure the draft stays and
    /// calling again with the same text reuses the same `clientId`.
    @discardableResult
    public func send(text override: String? = nil) async -> Bool {
        let text = (override ?? draft).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return false }
        if pending?.text != text { pending = (text, UUID().uuidString) }
        let clientID = pending!.clientID
        isSending = true; sendError = nil
        defer { isSending = false }
        do {
            try await workspace.client.sendInput(bot: botID, text: text, clientID: clientID)
            pending = nil
            if override == nil && draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = "" }
            await workspace.refresh()
            return true
        } catch {
            sendError = workspace.report(error).message
            return false
        }
    }

    /// Cancels the bot's unfinished task.
    public func stop() async {
        guard let task = activeTask else { return }
        do { try await workspace.client.cancel(task: task.id); await workspace.refresh() }
        catch { sendError = workspace.report(error).message }
    }

    /// Posts the read position once per new last `seq`, only while ``isActive`` and selected.
    public func markReadIfNeeded() async {
        guard isActive, workspace.selectedBotID == botID, let through = messages.last?.seq, through > readPosition else { return }
        readPosition = through
        let gen = generation
        do { try await workspace.client.markRead(bot: botID, seq: through) }
        catch {
            if gen == generation, readPosition == through { readPosition = 0 }
            workspace.report(error)
        }
    }
}

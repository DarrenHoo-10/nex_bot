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
    /// A search hit is being viewed: ``messages`` is the window around that message (up to 40 before, 60 from it), not the
    /// latest page. Older history, read receipts and "back to bottom" are off until ``WorkspaceStore/showLatest(botID:)``
    /// or a sent message ends the view.
    public internal(set) var focusedMessageID: String?
    /// Last send or load error text (Core's message).
    public private(set) var sendError: String?
    public private(set) var isSending = false
    /// Composer text. Survives resets; discarded only when the session ends.
    public var draft = ""
    /// Files attached to the next message (up to 5), in the order they were added. Survive resets like ``draft``.
    public private(set) var attachments: [PendingAttachment] = []
    /// At least one file is still uploading; ``send(text:)`` waits (returns false) until it finishes.
    public var isUploadingAttachments: Bool { attachments.contains { $0.isUploading } }
    /// Files that are uploaded and will be sent with the next message.
    public var readyAttachments: [ChatAttachment] { attachments.compactMap(\.attachment) }
    /// The composer can send: there is text or a ready file, nothing is uploading or sending.
    public var canSend: Bool {
        !isSending && !isUploadingAttachments && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !readyAttachments.isEmpty)
    }
    /// Set by the UI while this conversation is visible and the window/scene is active; enables read receipts.
    public var isActive = false { didSet { if isActive && !oldValue { Task { await markReadIfNeeded() } } } }

    @ObservationIgnored let workspace: WorkspaceStore
    @ObservationIgnored var loadedSync: SyncIdentity?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var readPosition = 0
    /// Same text keeps the same clientId, so a retry after a network error is never a duplicate.
    @ObservationIgnored private(set) var pending: (text: String, attachmentIDs: [String], clientID: String)?

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

    func discardDraft() { draft = ""; attachments = []; pending = nil; sendError = nil }

    /// Uploads a file for the next message. A file over 5 MiB or empty, or a sixth file, sets ``sendError`` ("文件不能超过 5 MB" /
    /// "最多添加 5 个附件") and adds nothing. A failed upload stays in ``attachments`` as `.failed` until removed.
    public func addAttachment(name: String, data: Data) async {
        guard attachments.count < ChatAttachment.maxCount else { sendError = ChatAttachment.tooManyMessage; return }
        guard !data.isEmpty, data.count <= ChatAttachment.maxBytes else { sendError = ChatAttachment.tooLargeMessage; return }
        sendError = nil
        let picture = AttachmentLink(id: "", name: name).isImage
        let local = PendingAttachment(id: UUID().uuidString, name: name, size: data.count, state: .uploading, preview: picture ? data : nil)
        attachments.append(local)
        do {
            let uploaded = try await workspace.client.uploadAttachment(botID: botID, name: name, data: data)
            update(local.id, .ready(uploaded))
        } catch {
            update(local.id, .failed(workspace.report(error).message))
        }
    }

    /// Drops a pending file (uploaded files simply stay unreferenced on Core and expire).
    public func removeAttachment(_ attachment: PendingAttachment) { attachments.removeAll { $0.id == attachment.id } }

    private func update(_ id: String, _ state: PendingAttachment.State) {
        guard let i = attachments.firstIndex(where: { $0.id == id }) else { return }
        attachments[i].state = state
    }

    /// Fetches the 100 messages before the oldest loaded one.
    public func loadOlder() async {
        guard hasOlder, focusedMessageID == nil, !isLoadingOlder, let first = messages.first?.seq, let sync = loadedSync else { return }
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

    /// Sends `text` (default: the draft) with the ready ``attachments``. The text may be empty when files are attached.
    /// Returns true when Core accepted it. On failure the draft and files stay and calling again with the same text and
    /// the same files reuses the same `clientId` and attachment ids, so a retry is never a duplicate. Files are cleared only
    /// after success. Returns false while a file is uploading.
    @discardableResult
    public func send(text override: String? = nil) async -> Bool {
        let text = (override ?? draft).trimmingCharacters(in: .whitespacesAndNewlines)
        let ids = readyAttachments.map(\.id)
        guard (!text.isEmpty || !ids.isEmpty), !isSending, !isUploadingAttachments else { return false }
        if pending?.text != text || pending?.attachmentIDs != ids { pending = (text, ids, UUID().uuidString) }
        let clientID = pending!.clientID
        isSending = true; sendError = nil
        defer { isSending = false }
        do {
            try await workspace.client.sendInput(bot: botID, text: text, clientID: clientID, attachments: ids)
            pending = nil
            if focusedMessageID != nil { workspace.leaveHistory(botID, reload: false) }
            attachments.removeAll { $0.attachment.map { ids.contains($0.id) } ?? false }
            if override == nil && draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = "" }
            await workspace.refresh()
            return true
        } catch {
            sendError = workspace.report(error).message
            return false
        }
    }

    /// Downloads a sent file; see ``WorkspaceStore/downloadAttachment(id:)``.
    public func download(_ link: AttachmentLink) async throws -> (data: Data, filename: String) {
        try await workspace.downloadAttachment(id: link.id)
    }

    /// Image bytes of a sent or generated picture, served by Core (clients never receive storage URLs).
    public func image(_ link: AttachmentLink) async throws -> Data {
        try await workspace.downloadAttachment(id: link.id).data
    }

    /// Cancels the bot's unfinished task.
    public func stop() async {
        guard let task = activeTask else { return }
        do { try await workspace.client.cancel(task: task.id); await workspace.refresh() }
        catch { sendError = workspace.report(error).message }
    }

    /// Posts the read position once per new last `seq`, only while ``isActive`` and selected.
    public func markReadIfNeeded() async {
        guard isActive, focusedMessageID == nil, workspace.selectedBotID == botID, let through = messages.last?.seq, through > readPosition else { return }
        readPosition = through
        let gen = generation
        do { try await workspace.client.markRead(bot: botID, seq: through) }
        catch {
            if gen == generation, readPosition == through { readPosition = 0 }
            workspace.report(error)
        }
    }
}

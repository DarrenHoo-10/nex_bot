import Foundation
import Observation

/// Search of message text across the account's active assistants (the sidebar search). One instance per query: make a new one
/// when the text changes, and drop it with the view. Matching is a literal substring match done by Core, 50 hits per page.
@MainActor @Observable
public final class ConversationSearch {
    public static let debounce: Duration = .milliseconds(250)
    /// Core refuses longer queries.
    public static let maxLength = 200

    public let query: String
    /// Newest first, pages appended.
    public private(set) var results: [ConversationMatch] = []
    /// More hits exist; ``loadMore()`` fetches them.
    public var hasMore: Bool { nextBefore != nil }
    public private(set) var isLoading = true
    /// The first page has arrived.
    public private(set) var isLoaded = false
    /// Core's message, or "会话记录已变化，请重新搜索" when the account's history changed under the search.
    public private(set) var error: String?
    /// The search ran and found nothing.
    public var isEmpty: Bool { isLoaded && !isLoading && error == nil && results.isEmpty }

    @ObservationIgnored private let workspace: WorkspaceStore
    @ObservationIgnored private let sync: SyncIdentity?
    @ObservationIgnored private var nextBefore: Int?
    @ObservationIgnored private var inFlight = false

    /// `query` is trimmed and cut to ``maxLength``. The workspace's current sync identity is pinned: results from another
    /// generation (Core restarted, privacy reset) are discarded.
    public init(query: String, workspace: WorkspaceStore) {
        self.query = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maxLength))
        self.workspace = workspace
        self.sync = workspace.sync
    }

    /// Waits ``debounce`` and loads the first page. Run it from `.task`, so leaving the view cancels it.
    public func start() async {
        try? await Task.sleep(for: Self.debounce)
        guard !Task.isCancelled, !query.isEmpty else { return }
        await load(before: nil)
    }

    /// Fetches the next page.
    public func loadMore() async { if let nextBefore { await load(before: nextBefore) } }

    /// Repeats the request that failed (the first page when none has arrived yet).
    public func retry() async { await load(before: nextBefore) }

    func load(before: Int?) async {
        guard !inFlight else { return }
        inFlight = true; isLoading = true; error = nil
        defer { inFlight = false; isLoading = false }
        do {
            let page = try await workspace.client.searchConversations(query: query, before: before)
            guard !Task.isCancelled else { return }
            if let sync, !page.sync.sameGeneration(as: sync) {
                results = []; nextBefore = nil; error = searchChangedMessage; return
            }
            results = before == nil ? page.results : results + page.results
            nextBefore = page.nextBefore
            isLoaded = true
        } catch {
            let e = workspace.report(error)
            if !e.isCancellation { self.error = e.message }
        }
    }
}

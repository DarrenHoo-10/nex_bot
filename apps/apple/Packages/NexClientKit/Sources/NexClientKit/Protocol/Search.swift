import Foundation

/// One message hit of `GET /api/agents/search`.
public struct ConversationMatch: Sendable, Hashable, Identifiable {
    /// The message id; open it with ``WorkspaceStore/openSearchResult(_:)``.
    public var id: String
    public var botID: String
    public var botName: String
    public var createdAt: Date?
    /// An excerpt around the first literal occurrence, up to about 180 characters, with "…" at cut ends.
    public var snippet: String

    public init(id: String, botID: String, botName: String, createdAt: Date? = nil, snippet: String) {
        self.id = id; self.botID = botID; self.botName = botName; self.createdAt = createdAt; self.snippet = snippet
    }
}

/// `GET /api/agents/search`: up to 50 hits, newest first.
public struct ConversationSearchPage: Decodable, Sendable {
    public var results: [ConversationMatch]
    /// Pass as `before` to get the next page; nil on the last page.
    public var nextBefore: Int?
    public var sync: SyncIdentity

    public init(results: [ConversationMatch] = [], nextBefore: Int? = nil, sync: SyncIdentity) {
        self.results = results; self.nextBefore = nextBefore; self.sync = sync
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        sync = try c.decode(SyncIdentity.self, forKey: .init("sync"))
        nextBefore = c.lenient(.init("nextBefore"))?.intValue
        results = c.lenient(.init("results"))?.arrayValue?.compactMap(\.objectValue).compactMap { row in
            guard let id = row["id"]?.stringValue, !id.isEmpty, let botID = row["botId"]?.stringValue, !botID.isEmpty else { return nil }
            return ConversationMatch(id: id, botID: botID, botName: row["botName"]?.stringValue ?? "", createdAt: dateFromMilliseconds(row["createdAt"]?.doubleValue),
                                     snippet: row["snippet"]?.stringValue ?? "")
        } ?? []
    }
}

extension CoreClient {
    /// `GET /api/agents/search`. `query` is a literal substring (at most 200 characters, not empty); `before` continues from a
    /// previous page's ``ConversationSearchPage/nextBefore``.
    public func searchConversations(query: String, before: Int? = nil) async throws -> ConversationSearchPage {
        var q = [("q", query)]
        if let before { q.append(("before", String(before))) }
        return try await get("/api/agents/search", query: q)
    }
}

/// Core's answer when the message of a history view was forgotten or its assistant archived meanwhile.
let messageGoneMessage = "该消息已不存在或已遗忘"
let searchChangedMessage = "会话记录已变化，请重新搜索"

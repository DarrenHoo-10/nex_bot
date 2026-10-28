import Foundation

// MARK: - 核心记忆 (web `CoreMemoryEditor.tsx`, server `core-memory.ts`)

/// One line of the 主题索引: "标题 — 一句话 (memory:<id>)".
public struct CoreMemoryTopic: Sendable, Hashable, Codable {
    public var title: String
    public var line: String
    /// `memory:<id>` or `episode:<id>`; empty when the topic points at nothing.
    public var ref: String
    public init(title: String, line: String, ref: String = "") { self.title = title; self.line = line; self.ref = ref }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        title = c.lenient(.init("title"))?.stringValue ?? ""
        line = c.lenient(.init("line"))?.stringValue ?? ""
        ref = c.lenient(.init("ref"))?.stringValue ?? ""
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(title, forKey: .init("title")); try c.encode(line, forKey: .init("line")); try c.encode(ref, forKey: .init("ref"))
    }
}

/// The two lists of one scope: 关于用户 and 主题索引.
public struct CoreMemoryContent: Sendable, Hashable {
    public var about: [String]
    public var topics: [CoreMemoryTopic]
    public init(about: [String] = [], topics: [CoreMemoryTopic] = []) { self.about = about; self.topics = topics }
}

/// A scope's lines and the version a save must echo ("核心记忆已被更新" when stale).
public struct CoreMemoryEntry: Sendable, Hashable {
    public var content: CoreMemoryContent
    public var version: Int
    public init(content: CoreMemoryContent = CoreMemoryContent(), version: Int = 0) { self.content = content; self.version = version }
}

/// 私有 (one assistant's own lines) or 共享 (the workspace's, carried by every assistant).
public enum CoreMemoryScope: String, Sendable, Hashable, CaseIterable {
    case bot, workspace
}

/// `GET /api/memory/core?botId=` and the result of a save.
public struct CoreMemoryView: Sendable, Hashable, Decodable {
    /// Token cap of everything rendered into the prompt (1500).
    public var limit: Int
    public var tokens: Int
    public var bot: CoreMemoryEntry
    public var workspace: CoreMemoryEntry

    public init(limit: Int = 1500, tokens: Int = 0, bot: CoreMemoryEntry = CoreMemoryEntry(), workspace: CoreMemoryEntry = CoreMemoryEntry()) {
        self.limit = limit; self.tokens = tokens; self.bot = bot; self.workspace = workspace
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        limit = c.lenient(.init("limit"))?.intValue ?? 1500
        tokens = c.lenient(.init("tokens"))?.intValue ?? 0
        func entry(_ key: String) -> CoreMemoryEntry {
            guard let object = c.lenient(.init(key))?.objectValue else { return CoreMemoryEntry() }
            let content = object["content"]?.objectValue ?? [:]
            let topics = content["topics"]?.arrayValue?.compactMap(\.objectValue).map {
                CoreMemoryTopic(title: $0.string("title") ?? "", line: $0.string("line") ?? "", ref: $0.string("ref") ?? "")
            } ?? []
            return CoreMemoryEntry(content: CoreMemoryContent(about: content["about"]?.arrayValue?.compactMap(\.stringValue) ?? [], topics: topics),
                                   version: object.int("version") ?? 0)
        }
        bot = entry("bot"); workspace = entry("workspace")
    }
    public func entry(_ scope: CoreMemoryScope) -> CoreMemoryEntry { scope == .bot ? bot : workspace }
    /// "123 / 1500 Token".
    public var usageText: String { "\(tokens) / \(limit) Token" }
}

/// Body of `POST /api/memory/core` (owner only).
struct CoreMemorySaveBody: Encodable {
    let botId: String, scope: String, about: [String], topics: [CoreMemoryTopic], version: Int
}

/// The plain-line form of the two lists, as the editors show them (the same rules as the web editor).
public enum CoreMemoryText {
    private static let separator = " — "
    private static let bullets: Set<Character> = ["-", "•"]

    /// A topic as one editable line: "标题 — 一句话 (memory:<id>)".
    public static func topicLine(_ topic: CoreMemoryTopic) -> String {
        "\(topic.title)\(separator)\(topic.line)\(topic.ref.isEmpty ? "" : " (\(topic.ref))")"
    }
    public static func topicText(_ topics: [CoreMemoryTopic]) -> String { topics.map(topicLine).joined(separator: "\n") }
    public static func aboutText(_ about: [String]) -> String { about.joined(separator: "\n") }

    private static func lines(_ value: String) -> [String] {
        value.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
    /// Drops one leading list marker (`-` or `•`) and the blanks after it.
    private static func unbulleted(_ raw: String) -> String {
        guard let first = raw.first, bullets.contains(first) else { return raw }
        return String(raw.dropFirst().drop(while: { $0.isWhitespace }))
    }

    /// 关于用户: one fact per line; a leading list marker is dropped and blank lines are skipped.
    public static func parseAbout(_ value: String) -> [String] {
        lines(value).map(unbulleted).filter { !$0.isEmpty }
    }

    /// 主题索引: every line must be "标题 — 一句话", optionally ending in " (memory:<id>)" or " (episode:<id>)".
    /// A line that is not throws "格式应为“标题 — 一句话”：…".
    public static func parseTopics(_ value: String) throws -> [CoreMemoryTopic] {
        let pattern = try NSRegularExpression(pattern: #"^(.*?) — (.+?)(?: \(((?:memory|episode):[A-Za-z0-9_-]+)\))?$"#)
        return try lines(value).map { raw in
            let text = unbulleted(raw), whole = NSRange(text.startIndex..., in: text)
            func group(_ match: NSTextCheckingResult, _ index: Int) -> String? {
                let range = match.range(at: index)
                return range.location == NSNotFound ? nil : Range(range, in: text).map { String(text[$0]) }
            }
            guard let match = pattern.firstMatch(in: text, range: whole),
                  let title = group(match, 1)?.trimmingCharacters(in: .whitespaces), !title.isEmpty,
                  let line = group(match, 2) else {
                throw CoreError(kind: .unsupported, message: "格式应为“标题 — 一句话”：\(String(raw.prefix(40)))")
            }
            return CoreMemoryTopic(title: title, line: line.trimmingCharacters(in: .whitespaces), ref: group(match, 3) ?? "")
        }
    }
}

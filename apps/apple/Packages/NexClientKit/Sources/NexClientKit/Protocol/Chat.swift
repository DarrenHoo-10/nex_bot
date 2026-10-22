import Foundation

// MARK: - Attachments

/// An uploaded file (`POST /api/attachments` response). It is bound to the session and bot that uploaded it
/// and becomes downloadable once a message that links it exists.
public struct ChatAttachment: Codable, Sendable, Hashable, Identifiable {
    /// At most this many attachments per message ("最多添加 5 个附件").
    public static let maxCount = 5
    /// Each file is 1 byte to 5 MiB ("文件不能超过 5 MB").
    public static let maxBytes = 5 * 1024 * 1024
    public static let tooLargeMessage = "文件不能超过 5 MB"
    public static let tooManyMessage = "最多添加 5 个附件"

    public var id: String
    public var botID: String
    public var name: String
    /// `image/png`, `image/jpeg`, `image/webp`, `application/pdf` or `application/octet-stream`, sniffed by Core.
    public var mime: String
    public var size: Int

    public init(id: String, botID: String, name: String, mime: String = "application/octet-stream", size: Int) {
        self.id = id; self.botID = botID; self.name = name; self.mime = mime; self.size = size
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let id = c.lenient(.init("id"))?.stringValue, !id.isEmpty else { throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Missing attachment id")) }
        self.id = id
        botID = c.lenient(.init("botId"))?.stringValue ?? ""
        name = c.lenient(.init("name"))?.stringValue ?? ""
        mime = c.lenient(.init("mime"))?.stringValue ?? "application/octet-stream"
        size = c.lenient(.init("size"))?.intValue ?? 0
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(id, forKey: .init("id")); try c.encode(botID, forKey: .init("botId")); try c.encode(name, forKey: .init("name"))
        try c.encode(mime, forKey: .init("mime")); try c.encode(size, forKey: .init("size"))
    }
    public var isImage: Bool { mime.hasPrefix("image/") }
}

/// A file in the composer, before the message is sent. Observe ``ConversationStore/attachments``.
public struct PendingAttachment: Sendable, Hashable, Identifiable {
    public enum State: Sendable, Hashable {
        case uploading
        case ready(ChatAttachment)
        /// The upload failed; the text is Core's message. Remove it with ``ConversationStore/removeAttachment(_:)``.
        case failed(String)
    }
    /// A local id, stable across the state changes.
    public let id: String
    public var name: String
    public var size: Int
    public var state: State
    /// The bytes of a picture, so the composer can show a thumbnail before sending.
    public var preview: Data? = nil
    /// The uploaded file once ``state`` is `.ready`.
    public var attachment: ChatAttachment? { if case .ready(let a) = state { a } else { nil } }
    public var isUploading: Bool { state == .uploading }
    public var errorMessage: String? { if case .failed(let m) = state { m } else { nil } }
}

/// A file link inside a message body: Core appends `[name](/api/attachments/<id>)` lines to the text it was sent with.
public struct AttachmentLink: Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    /// Set for pictures embedded with `![alt](...)`, whatever their name.
    public var picture: Bool
    public init(id: String, name: String, picture: Bool = false) { self.id = id; self.name = name; self.picture = picture }
    /// Pictures render as thumbnails instead of file cards.
    public var isImage: Bool { picture || ["png", "jpg", "jpeg", "webp", "gif"].contains((name as NSString).pathExtension.lowercased()) }

    /// Pictures embedded as `![alt](/api/attachments/<id>)` (generated images), in order.
    public static func embeddedImages(_ content: String) -> [AttachmentLink] {
        guard content.contains("](/api/attachments/") else { return [] }
        let range = NSRange(content.startIndex..., in: content)
        return embedded.matches(in: content, range: range).compactMap { match in
            guard let alt = Range(match.range(at: 1), in: content), let id = Range(match.range(at: 2), in: content) else { return nil }
            return AttachmentLink(id: String(content[id]), name: content[alt].isEmpty ? "图片" : String(content[alt]), picture: true)
        }
    }
    private static let embedded = try! NSRegularExpression(pattern: #"!\[([^\[\]]*)\]\(/api/attachments/([A-Za-z0-9_-]+)\)"#)

    /// Splits trailing attachment link lines off a message. `body` is the remaining Markdown, trimmed;
    /// links are in order. Only a contiguous block at the end of the content counts, so a link the user typed
    /// in the middle of a sentence stays text.
    public static func parse(_ content: String) -> (links: [AttachmentLink], body: String) {
        var lines = content.components(separatedBy: "\n")
        var found: [AttachmentLink] = []
        while let last = lines.last {
            let line = last.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { lines.removeLast(); continue }
            guard let link = parseLine(line) else { break }
            found.append(link); lines.removeLast()
        }
        let body = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return (found.reversed(), found.isEmpty ? content : body)
    }

    private static let prefix = "](/api/attachments/"
    private static func parseLine(_ line: String) -> AttachmentLink? {
        guard line.hasPrefix("["), line.hasSuffix(")"), let r = line.range(of: prefix, options: .backwards) else { return nil }
        let name = String(line[line.index(after: line.startIndex)..<r.lowerBound])
        let id = String(line[r.upperBound..<line.index(before: line.endIndex)])
        guard !name.contains("["), !name.contains("]"), !id.isEmpty,
              id.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_" }) else { return nil }
        return AttachmentLink(id: id, name: name)
    }
}

extension CoreClient {
    /// The file name of a `Content-Disposition` header: `filename*=UTF-8''...` first, then `filename="..."`.
    static func dispositionFilename(_ header: String?) -> String? {
        guard let header else { return nil }
        for part in header.split(separator: ";").map({ $0.trimmingCharacters(in: .whitespaces) }) {
            if part.lowercased().hasPrefix("filename*="), let r = part.range(of: "''") {
                if let name = String(part[r.upperBound...]).removingPercentEncoding, !name.isEmpty { return name }
            }
        }
        for part in header.split(separator: ";").map({ $0.trimmingCharacters(in: .whitespaces) }) where part.lowercased().hasPrefix("filename=") {
            let name = part.dropFirst("filename=".count).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            if !name.isEmpty { return name }
        }
        return nil
    }
}

// MARK: - Permission mode

/// The per-agent operation permission (`bots/approval-mode`), shown as 标准权限 / 完全权限.
public enum ApprovalMode: String, Sendable, CaseIterable, Hashable, Identifiable {
    /// Effects are checked and may ask for approval.
    case standard
    /// Granted tools run without effect approvals; switching to it also releases valid pending approvals.
    case full
    public var id: String { rawValue }
    /// 标准权限 / 完全权限.
    public var title: String { self == .full ? "完全权限" : "标准权限" }
}

extension Bot {
    /// The agent's permission mode (`approval_setting`); `.standard` when absent or unknown.
    public var approvalMode: ApprovalMode { ApprovalMode(rawValue: row.string("approval_setting") ?? "") ?? .standard }
    /// Echoed as `version` by ``WorkspaceStore/setApprovalMode(botID:mode:)`` (`approval_setting_version`, 0 until first change).
    public var approvalModeVersion: Int { row.int("approval_setting_version") ?? 0 }
}

// MARK: - Account

extension AccountStatus {
    /// First character of the display name, for the avatar (no case change, like the web); "N" when unknown.
    public var initial: String {
        displayName?.trimmingCharacters(in: .whitespacesAndNewlines).first.map(String.init) ?? "N"
    }
}

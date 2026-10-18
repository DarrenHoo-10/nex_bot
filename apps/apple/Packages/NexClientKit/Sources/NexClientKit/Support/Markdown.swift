import Foundation

/// Markdown to `AttributedString` for chat bubbles.
public enum Markdown {
    /// Inline Markdown with whitespace and newlines preserved. Only http(s) links stay clickable.
    public static func attributed(_ source: String) -> AttributedString {
        var text = (try? AttributedString(markdown: source, options: .init(allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible))) ?? AttributedString(source)
        for run in text.runs where run.link != nil && !isOpenable(run.link!) { text[run.range].link = nil }
        return text
    }
    /// Links are opened in the system browser only for http(s) without credentials.
    public static func isOpenable(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        return url.user == nil && url.password == nil && url.host != nil
    }
}

/// One block of an agent reply. Inline formatting inside a block goes through ``Markdown/attributed(_:)``.
public enum MarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(level: Int, text: String)
    /// `- item` / `* item`; `level` counts two-space indentation steps.
    case bullet(level: Int, text: String)
    case ordered(level: Int, number: Int, text: String)
    case quote(String)
    case code(language: String, text: String)
    case rule
}

extension Markdown {
    /// Splits Markdown into blocks: headings, lists, quotes, fenced code, rules and paragraphs.
    /// Consecutive plain lines join into one paragraph, keeping their line breaks.
    public static func blocks(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = [], paragraph: [String] = [], fence: (language: String, lines: [String])?
        func flush() { if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] } }
        for raw in source.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if var open = fence {
                if trimmed.hasPrefix("```") { blocks.append(.code(language: open.language, text: open.lines.joined(separator: "\n"))); fence = nil }
                else { open.lines.append(raw); fence = open }
                continue
            }
            if trimmed.hasPrefix("```") { flush(); fence = (String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces), []); continue }
            if trimmed.isEmpty { flush(); continue }
            let level = (raw.prefix { $0 == " " }.count) / 2
            if let match = trimmed.firstMatch(of: /^(#{1,6})\s+(.+)$/) { flush(); blocks.append(.heading(level: match.1.count, text: String(match.2))); continue }
            if trimmed.wholeMatch(of: /(-{3,}|\*{3,}|_{3,})/) != nil { flush(); blocks.append(.rule); continue }
            if let match = trimmed.firstMatch(of: /^[-*+]\s+(.+)$/) { flush(); blocks.append(.bullet(level: level, text: String(match.1))); continue }
            if let match = trimmed.firstMatch(of: /^(\d{1,9})[.)]\s+(.+)$/) { flush(); blocks.append(.ordered(level: level, number: Int(match.1) ?? 1, text: String(match.2))); continue }
            if let match = trimmed.firstMatch(of: /^>\s?(.*)$/) {
                flush()
                if case .quote(let previous) = blocks.last { blocks[blocks.count - 1] = .quote(previous + "\n" + match.1) } else { blocks.append(.quote(String(match.1))) }
                continue
            }
            paragraph.append(raw)
        }
        if let open = fence { blocks.append(.code(language: open.language, text: open.lines.joined(separator: "\n"))) }  // unterminated while streaming
        flush()
        return blocks
    }
}

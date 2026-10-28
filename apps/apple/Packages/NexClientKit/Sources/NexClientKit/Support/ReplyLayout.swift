import Foundation

/// Port of `src/personal/long-reply.ts`: a reply with headings, or with more than ``documentLines`` rendered lines,
/// is shown as a document card instead of a bubble. The decision uses the Markdown source alone, so the layout
/// never changes after render.
public enum ReplyLayout {
    /// A reply with headings, or more than this many rendered lines, becomes a document card.
    public static let documentLines = 12
    /// A reading column fits about 42 CJK characters; CJK counts two units per character.
    static let lineUnits = 84

    public struct Result: Equatable, Sendable {
        public var headings: Bool
        public var lines: Int
        public var document: Bool
    }

    /// Charts and HTML previews are visuals, not text, and are not counted.
    public static func of(_ markdown: String) -> Result {
        var fence: Fence?, headings = false, lines = 0
        for raw in split(markdown) {
            if let open = fence {
                if closes(raw, open) { fence = nil } else if !open.visual { lines += 1 }
                continue
            }
            if let opened = opens(raw) { fence = opened; continue }
            if headingText(raw) != nil { headings = true }
            if !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                lines += max(1, Int((Double(units(raw)) / Double(lineUnits)).rounded(.up)))
            }
        }
        return Result(headings: headings, lines: lines, document: headings || lines > documentLines)
    }

    /// Titles of the h1-h4 headings outside code fences, in order (the document card's outline chips).
    public static func outline(_ markdown: String) -> [String] {
        var fence: Fence?, titles: [String] = []
        for raw in split(markdown) {
            if let open = fence { if closes(raw, open) { fence = nil }; continue }
            if let opened = opens(raw) { fence = opened; continue }
            if let title = headingText(raw) { titles.append(plain(title)) }
        }
        return titles.filter { !$0.isEmpty }
    }

    // MARK: Scanning

    private struct Fence { let char: Character; let length: Int; let visual: Bool }

    private static func split(_ markdown: String) -> [String] {
        markdown.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
    }

    private static func units(_ line: String) -> Int {
        line.unicodeScalars.reduce(0) { $0 + ($1.value > 0x2e7f ? 2 : 1) }
    }

    /// The line without up to three leading spaces, or nil when it is indented further.
    private static func unindented(_ line: String) -> Substring? {
        var rest = Substring(line), spaces = 0
        while spaces < 3, rest.first == " " { rest = rest.dropFirst(); spaces += 1 }
        return rest.first == " " ? nil : rest
    }

    /// `^ {0,3}(`{3,}|~{3,})[ \t]*([\w-]*)`
    private static func opens(_ line: String) -> Fence? {
        guard let rest = unindented(line), let char = rest.first, char == "`" || char == "~" else { return nil }
        let run = rest.prefix { $0 == char }
        guard run.count >= 3 else { return nil }
        let info = rest.dropFirst(run.count).drop { $0 == " " || $0 == "\t" }.prefix { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
        return Fence(char: char, length: run.count, visual: info == "chart" || info == "html-preview")
    }

    /// `^ {0,3}<fence char>{n,}[ \t]*$`
    private static func closes(_ line: String, _ fence: Fence) -> Bool {
        guard let rest = unindented(line) else { return false }
        let run = rest.prefix { $0 == fence.char }
        return run.count >= fence.length && rest.dropFirst(run.count).allSatisfy { $0 == " " || $0 == "\t" }
    }

    /// `^ {0,3}#{1,4}[ \t]+\S`: the heading text, nil for other lines.
    private static func headingText(_ line: String) -> String? {
        guard let rest = unindented(line) else { return nil }
        let marks = rest.prefix { $0 == "#" }
        guard (1...4).contains(marks.count) else { return nil }
        let after = rest.dropFirst(marks.count)
        guard let first = after.first, first == " " || first == "\t" else { return nil }
        let text = after.drop { $0 == " " || $0 == "\t" }
        guard let head = text.first, !head.isWhitespace else { return nil }
        return String(text)
    }

    /// Heading source to the text a reader sees: no closing `#`s, emphasis marks, code ticks or link syntax.
    private static func plain(_ source: String) -> String {
        var text = source.trimmingCharacters(in: .whitespaces)
        text = text.replacingOccurrences(of: #"\s+#+\s*$"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"!?\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(\*\*|__|~~|`|\*)"#, with: "", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespaces)
    }
}

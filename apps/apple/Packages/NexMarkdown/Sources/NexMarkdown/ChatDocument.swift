import Foundation
import cmark_gfm
import cmark_gfm_extensions

/// Value types keep the parser implementation out of the SwiftUI view tree.
public indirect enum ChatInline: Equatable, Sendable {
    case text(String)
    case code(String)
    case emphasis([ChatInline])
    case strong([ChatInline])
    case strikethrough([ChatInline])
    case link(destination: String?, children: [ChatInline])
    case image(source: String?, alt: String)
}

public enum ChatColumnAlignment: Equatable, Sendable { case left, center, right }

public struct ChatTable: Equatable, Sendable {
    public let alignments: [ChatColumnAlignment]
    public let header: [[ChatInline]]
    public let rows: [[[ChatInline]]]
}

public struct ChatListItem: Equatable, Sendable {
    /// Nil is a regular list item; true/false is a read-only GFM task checkbox.
    public let checked: Bool?
    public let blocks: [ChatBlock]
}

public indirect enum ChatBlock: Equatable, Sendable {
    case paragraph([ChatInline])
    case heading(level: Int, content: [ChatInline])
    case code(language: String?, text: String)
    case quote([ChatBlock])
    case list(start: Int?, items: [ChatListItem])
    case table(ChatTable)
    case rule
    case literal(String)
}

/// CommonMark + GFM, including tables, tasks, autolinks and strikethrough.
/// Parsing every streaming snapshot also handles unfinished fences and tables.
public struct ChatDocument: Equatable, Sendable {
    public let blocks: [ChatBlock]
    /// Actual HTML nodes or chart code fences use the isolated rich document.
    public let staticHTML: String?
    private static let registerExtensions: Void = cmark_gfm_core_extensions_ensure_registered()

    public init(_ source: String) {
        // Use the same GFM features as remark-gfm, without smart punctuation or
        // the non-GFM table spanning extension. Registration is once/thread-safe.
        _ = Self.registerExtensions
        guard let parser = cmark_parser_new(CMARK_OPT_DEFAULT) else { blocks = [.literal(source)]; staticHTML = nil; return }
        defer { cmark_parser_free(parser) }
        for name in ["table", "strikethrough", "autolink", "tasklist"] {
            cmark_parser_attach_syntax_extension(parser, cmark_find_syntax_extension(name))
        }
        source.withCString { cmark_parser_feed(parser, $0, source.utf8.count) }
        guard let document = cmark_parser_finish(parser) else { blocks = [.literal(source)]; staticHTML = nil; return }
        defer { cmark_node_free(document) }
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").split(separator: "\n", omittingEmptySubsequences: false).map { Array($0.utf8) }
        Self.repairQuotedTasks(document, sourceLines: lines)
        if Self.containsHTML(document), let rendered = cmark_render_html(document, CMARK_OPT_UNSAFE, cmark_parser_get_syntax_extensions(parser)) {
            staticHTML = StaticHTML.sanitize(String(cString: rendered))
            free(rendered)
        } else { staticHTML = nil }
        blocks = Self.blocks(document, sourceLines: lines)
    }

    private typealias Node = UnsafeMutablePointer<cmark_node>

    private static func children(_ node: Node) -> [Node] {
        var result: [Node] = [], child = cmark_node_first_child(node)
        while let current = child { result.append(current); child = cmark_node_next(current) }
        return result
    }

    private static func string(_ pointer: UnsafePointer<CChar>?) -> String {
        pointer.map { String(cString: $0) } ?? ""
    }

    private static func kind(_ node: Node) -> String { string(cmark_node_get_type_string(node)) }

    private static func containsHTML(_ node: Node) -> Bool {
        ["html_block", "html_inline"].contains(kind(node)) ||
        (kind(node) == "code_block" && string(cmark_node_get_fence_info(node)).split(whereSeparator: { $0.isWhitespace }).first == "chart") ||
        children(node).contains { containsHTML($0) }
    }

    private static func blocks(_ parent: Node, sourceLines: [[UInt8]]) -> [ChatBlock] {
        children(parent).flatMap { node -> [ChatBlock] in
            switch kind(node) {
            case "paragraph": return [.paragraph(inlines(node))]
            case "heading": return [.heading(level: Int(cmark_node_get_heading_level(node)), content: inlines(node))]
            case "code_block":
                let language = string(cmark_node_get_fence_info(node))
                return [.code(language: language.isEmpty ? nil : language, text: string(cmark_node_get_literal(node)))]
            case "block_quote": return [.quote(blocks(node, sourceLines: sourceLines))]
            case "list":
                let start = cmark_node_get_list_type(node) == CMARK_ORDERED_LIST ? Int(cmark_node_get_list_start(node)) : nil
                let items = children(node).map { item in
                    listItem(item, sourceLines: sourceLines)
                }
                return [.list(start: start, items: items)]
            case "table":
                let count = Int(cmark_gfm_extensions_get_table_columns(node))
                let alignmentBytes = cmark_gfm_extensions_get_table_alignments(node)
                let alignments: [ChatColumnAlignment] = (0..<count).map { column in
                    switch alignmentBytes?[column] { case 99: return .center; case 114: return .right; default: return .left }
                }
                let rows = children(node)
                return [.table(ChatTable(
                    alignments: alignments,
                    header: rows.first.map { children($0).map { inlines($0) } } ?? [],
                    rows: rows.dropFirst().map { row in children(row).map { inlines($0) } }
                ))]
            case "thematic_break": return [.rule]
            // Literal fallback tree; mixed markup uses the sanitized staticHTML document.
            case "html_block": return [.literal(string(cmark_node_get_literal(node)))]
            default: return blocks(node, sourceLines: sourceLines)
            }
        }
    }

    private static func repairQuotedTasks(_ node: Node, sourceLines: [[UInt8]]) {
        if kind(node) == "item", let paragraph = cmark_node_first_child(node),
           let text = cmark_node_first_child(paragraph), kind(text) == "text" {
            let repaired = listItem(node, sourceLines: sourceLines)
            if let checked = repaired.checked,
               case .paragraph(let inline) = repaired.blocks.first, case .text(let value) = inline.first {
                cmark_node_set_syntax_extension(node, cmark_find_syntax_extension("tasklist"))
                cmark_gfm_extensions_set_tasklist_item_checked(node, checked)
                cmark_node_set_literal(text, value)
            }
        }
        for child in children(node) { repairQuotedTasks(child, sourceLines: sourceLines) }
    }

    private static func listItem(_ node: Node, sourceLines: [[UInt8]]) -> ChatListItem {
        var content = blocks(node, sourceLines: sourceLines)
        if kind(node) == "tasklist" {
            return ChatListItem(checked: cmark_gfm_extensions_get_tasklist_item_checked(node), blocks: content)
        }
        // cmark's task extension can miss markers behind a quote prefix. Check
        // the original first paragraph bytes, not unescaped display text: \[x]
        // and inline code must remain ordinary list content.
        if let paragraph = cmark_node_first_child(node), kind(paragraph) == "paragraph" {
            let line = Int(cmark_node_get_start_line(paragraph)) - 1
            let column = Int(cmark_node_get_start_column(paragraph)) - 1
            if sourceLines.indices.contains(line), column >= 0, column + 3 <= sourceLines[line].count {
                let bytes = Array(sourceLines[line].dropFirst(column))
                if bytes[0] == 91, [32, 120, 88].contains(bytes[1]), bytes[2] == 93,
                   bytes.count == 3 || bytes[3] == 32 || bytes[3] == 9,
                   case .paragraph(var inlines) = content.first, case .text(let text) = inlines.first {
                    inlines[0] = .text(String(text.dropFirst(3).drop(while: { $0 == " " || $0 == "\t" })))
                    content[0] = .paragraph(inlines)
                    return ChatListItem(checked: bytes[1] != 32, blocks: content)
                }
            }
        }
        return ChatListItem(checked: nil, blocks: content)
    }

    private static func inlines(_ parent: Node) -> [ChatInline] {
        children(parent).flatMap { node -> [ChatInline] in
            switch kind(node) {
            case "text": return [.text(string(cmark_node_get_literal(node)))]
            case "code": return [.code(string(cmark_node_get_literal(node)))]
            case "emph": return [.emphasis(inlines(node))]
            case "strong": return [.strong(inlines(node))]
            case "strikethrough": return [.strikethrough(inlines(node))]
            case "link": return [.link(destination: string(cmark_node_get_url(node)), children: inlines(node))]
            case "image": return [.image(source: string(cmark_node_get_url(node)), alt: plainText(node))]
            case "softbreak": return [.text(" ")]
            case "linebreak": return [.text("\n")]
            case "html_inline": return [.text(string(cmark_node_get_literal(node)))]
            default: return inlines(node)
            }
        }
    }

    private static func plainText(_ node: Node) -> String {
        if let literal = cmark_node_get_literal(node) { return string(literal) }
        return children(node).map { plainText($0) }.joined()
    }
}

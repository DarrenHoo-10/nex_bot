import SwiftUI
import NexClientKit
import NexMarkdown

/// URL schemes used by native Markdown blocks for previewable file paths and inline Core attachments.
enum ChatLinks {
    static let scheme = "nexbot-file"
    static let attachmentScheme = "nexbot-attachment"

    static func url(forPath path: String) -> URL? {
        var c = URLComponents()
        c.scheme = scheme
        c.host = "preview"
        c.queryItems = [URLQueryItem(name: "path", value: path)]
        return c.url
    }

    /// The file path of a chip link, nil for ordinary links.
    static func path(from url: URL) -> String? {
        guard url.scheme == scheme else { return nil }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "path" }?.value
    }

    static func url(forAttachment id: String, name: String) -> URL? {
        var c = URLComponents()
        c.scheme = attachmentScheme
        c.host = "download"
        c.queryItems = [
            URLQueryItem(name: "id", value: id),
            URLQueryItem(name: "name", value: name),
        ]
        return c.url
    }

    /// The attachment id and display name of an inline `/api/attachments/<id>` link.
    static func attachment(from url: URL) -> AttachmentLink? {
        guard url.scheme == attachmentScheme else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard let id = items.first(where: { $0.name == "id" })?.value, !id.isEmpty else { return nil }
        let name = items.first(where: { $0.name == "name" })?.value ?? "附件"
        return AttachmentLink(id: id, name: name.isEmpty ? "附件" : name)
    }
}

/// Separate recursive views keep quotes and list items as real block containers across Mac and iOS.
struct ChatMarkdownBlocks: View {
    let blocks: [ChatBlock]
    let fontSize: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: fontSize * 0.6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                ChatMarkdownBlock(block: block, fontSize: fontSize)
            }
        }
    }
}

private struct ChatMarkdownBlock: View {
    let block: ChatBlock
    let fontSize: CGFloat
    @Environment(\.chatInk) private var ink
    @Environment(\.chatOnAccent) private var onAccent

    @ViewBuilder var body: some View {
        switch block {
        case .paragraph(let content): ChatMarkdownInline(content: content, fontSize: fontSize)
        case .heading(let level, let content):
            ChatMarkdownInline(content: content, fontSize: fontSize + CGFloat(max(0, 4 - level)) * 2, strong: true)
        case .code(_, let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text).font(.system(size: fontSize - 1, design: .monospaced))
                    .foregroundStyle(onAccent ? .white : Theme.foreground)
                    .padding(10)
            }
            .background(onAccent ? Color.white.opacity(0.14) : Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        case .quote(let blocks):
            ChatMarkdownBlocks(blocks: blocks, fontSize: fontSize)
                .foregroundStyle(onAccent ? ink.opacity(0.88) : Theme.muted)
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    Rectangle().fill(onAccent ? ink.opacity(0.55) : Theme.borderStrong).frame(width: 3)
                }
        case .list(let start, let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .top, spacing: 8) {
                        if let checked = item.checked {
                            Image(systemName: checked ? "checkmark.square.fill" : "square")
                                .foregroundStyle(onAccent ? .white : (checked ? Theme.brand : Theme.muted))
                                .font(.system(size: fontSize)).frame(width: fontSize + 2, height: fontSize * 1.4)
                                .accessibilityLabel(checked ? "已完成" : "未完成")
                        } else {
                            Text(start.map { "\($0 + index)." } ?? "•")
                                .font(.system(size: fontSize)).foregroundStyle(ink)
                                .frame(minWidth: fontSize + 2, alignment: .trailing)
                        }
                        ChatMarkdownBlocks(blocks: item.blocks, fontSize: fontSize)
                    }
                }
            }
            .padding(.leading, 4)
        case .table(let table): ChatMarkdownTable(table: table, fontSize: fontSize)
        case .rule: Rectangle().fill(onAccent ? ink.opacity(0.35) : Theme.border).frame(height: 1)
        case .literal(let text): Text(text).font(.system(size: fontSize)).foregroundStyle(ink).textSelection(.enabled)
        }
    }
}

private struct ChatMarkdownTable: View {
    let table: ChatTable
    let fontSize: CGFloat

    var body: some View {
        // A Grid shares widths between rows; horizontal scrolling confines wide
        // tables to the transcript instead of widening the entire window.
        ScrollView(.horizontal) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                row(table.header, header: true)
                ForEach(Array(table.rows.enumerated()), id: \.offset) { _, cells in
                    row(cells, header: false)
                }
            }
            .overlay(Rectangle().strokeBorder(Theme.border, lineWidth: 1))
        }
        .accessibilityLabel("表格")
    }

    private func alignment(_ column: Int) -> Alignment {
        guard table.alignments.indices.contains(column) else { return .leading }
        switch table.alignments[column] { case .left: return .leading; case .center: return .center; case .right: return .trailing }
    }

    private func textAlignment(_ column: Int) -> TextAlignment {
        guard table.alignments.indices.contains(column) else { return .leading }
        switch table.alignments[column] { case .left: return .leading; case .center: return .center; case .right: return .trailing }
    }

    private func row(_ cells: [[ChatInline]], header: Bool) -> some View {
        GridRow(alignment: .top) {
            ForEach(Array(cells.enumerated()), id: \.offset) { column, content in
                ChatMarkdownInline(content: content, fontSize: fontSize, strong: header)
                    .multilineTextAlignment(textAlignment(column))
                    .frame(minWidth: 64, maxWidth: 320, alignment: alignment(column))
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(header ? Theme.secondary : Theme.card)
                    .overlay(Rectangle().strokeBorder(Theme.border, lineWidth: 0.5))
                    .gridColumnAlignment(textAlignment(column) == .center ? .center : (textAlignment(column) == .trailing ? .trailing : .leading))
            }
        }
    }
}

private struct ChatMarkdownInline: View {
    let content: [ChatInline]
    let fontSize: CGFloat
    var strong = false
    @Environment(\.chatInk) private var ink
    @Environment(\.chatOnAccent) private var onAccent

    var body: some View {
        Text(Self.attributed(content, size: fontSize, bold: strong, onAccent: onAccent))
            .font(.system(size: fontSize)).foregroundStyle(ink)
            .lineSpacing(fontSize * 0.35).fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }

    private static func plainText(_ nodes: [ChatInline]) -> String {
        nodes.map { node in
            switch node {
            case .text(let s), .code(let s): return s
            case .emphasis(let c), .strong(let c), .strikethrough(let c), .link(_, let c): return plainText(c)
            case .image(_, let alt): return alt
            }
        }.joined()
    }

    /// Render the parser's inline tree directly: no second parser can lose GFM
    /// strikethrough, reference links, escaping or formatting inside table cells.
    private static func attributed(_ nodes: [ChatInline], size: CGFloat, bold: Bool = false, italic: Bool = false, onAccent: Bool = false) -> AttributedString {
        var result = AttributedString()
        for node in nodes {
            var part: AttributedString
            switch node {
            case .text(let text): part = AttributedString(text)
            case .image(_, let alt): part = AttributedString(alt.isEmpty ? "图片" : alt)
            case .code(let text):
                part = AttributedString(text)
                part.font = .system(size: size - 1, weight: bold ? .bold : .regular, design: .monospaced)
                part.backgroundColor = onAccent ? Color.white.opacity(0.2) : Theme.secondary
                if FilePathMatcher.isFilePath(text), let url = ChatLinks.url(forPath: text) {
                    part.link = url; part.foregroundColor = onAccent ? .white : Theme.brand
                }
            case .emphasis(let children): part = attributed(children, size: size, bold: bold, italic: true, onAccent: onAccent)
            case .strong(let children): part = attributed(children, size: size, bold: true, italic: italic, onAccent: onAccent)
            case .strikethrough(let children):
                part = attributed(children, size: size, bold: bold, italic: italic, onAccent: onAccent)
                part.strikethroughStyle = .single
            case .link(let destination, let children):
                part = attributed(children, size: size, bold: bold, italic: italic, onAccent: onAccent)
                // Preserve the URL policy; generated links from model text cannot acquire
                // the app's private file-preview scheme, except validated Core attachments.
                part.link = nil
                if let destination, let attachmentID = AttachmentLink.inlineID(from: destination),
                   let url = ChatLinks.url(forAttachment: attachmentID, name: plainText(children)) {
                    part.link = url
                    part.foregroundColor = onAccent ? .white : Theme.brand
                    part.underlineStyle = .single
                } else if let destination, let url = URL(string: destination), Markdown.isOpenable(url) {
                    part.link = url; part.foregroundColor = onAccent ? .white : Theme.brand
                    if onAccent { part.underlineStyle = .single }
                }
            }
            if case .text = node {
                var font = Font.system(size: size, weight: bold ? .bold : .regular)
                if italic { font = font.italic() }
                part.font = font
            }
            result.append(part)
        }
        return result
    }
}

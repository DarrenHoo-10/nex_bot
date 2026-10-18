import SwiftUI
import NexClientKit

/// Chat Markdown: the shared block renderer plus file-path chips. An inline `code` span that names a previewable file
/// becomes a link with the `nexbot-file` scheme; `ChatLinks.handle` opens it as a preview in the inspector.
struct ChatMarkdown: View {
    let source: String
    var fontSize: CGFloat = 14
    /// Shrink to the content width (user bubbles) instead of filling the column.
    var hug = false

    var body: some View {
        VStack(alignment: .leading, spacing: fontSize * 0.6) {
            ForEach(Array(Markdown.blocks(source).enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: hug ? nil : .infinity, alignment: .leading)
    }

    @ViewBuilder private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let text): inline(text)
        case .heading(let level, let text):
            inline(text).font(.system(size: fontSize + CGFloat(max(0, 4 - level)) * 2, weight: .semibold))
        case .bullet(let level, let text): item(marker: level == 0 ? "•" : "◦", level: level, text: text)
        case .ordered(let level, let number, let text): item(marker: "\(number).", level: level, text: text)
        case .quote(let text):
            inline(text).foregroundStyle(Theme.muted)
                .padding(.leading, 10)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.border).frame(width: 3) }
        case .code(_, let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text).font(.system(size: fontSize - 1, design: .monospaced)).foregroundStyle(Theme.foreground).padding(10)
            }
            .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        case .rule:
            Rectangle().fill(Theme.border).frame(height: 1)
        }
    }

    private func inline(_ text: String) -> some View {
        Text(Self.attributed(text, size: fontSize)).font(.system(size: fontSize)).lineSpacing(fontSize * 0.35).foregroundStyle(Theme.foreground)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func item(marker: String, level: Int, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(marker).font(.system(size: fontSize)).foregroundStyle(Theme.foreground).frame(minWidth: 12, alignment: .trailing)
            inline(text)
        }
        .padding(.leading, CGFloat(level) * 18 + 4)
    }

    /// Inline Markdown with monospaced code spans; file-path spans become `nexbot-file` links.
    static func attributed(_ source: String, size: CGFloat) -> AttributedString {
        var text = Markdown.attributed(source)
        var spans: [(Range<AttributedString.Index>, String)] = []
        for run in text.runs where run.inlinePresentationIntent?.contains(.code) == true {
            spans.append((run.range, String(text[run.range].characters)))
        }
        for (range, content) in spans {
            text[range].font = .system(size: size - 1, design: .monospaced)
            text[range].backgroundColor = Theme.secondary
            if FilePathMatcher.isFilePath(content), let url = ChatLinks.url(forPath: content) {
                text[range].link = url
                text[range].foregroundColor = Theme.brand
            }
        }
        return text
    }
}

enum ChatLinks {
    static let scheme = "nexbot-file"

    static func url(forPath path: String) -> URL? {
        var c = URLComponents(); c.scheme = scheme; c.host = "preview"; c.queryItems = [URLQueryItem(name: "path", value: path)]
        return c.url
    }

    /// The file path of a chip link, nil for ordinary links.
    static func path(from url: URL) -> String? {
        guard url.scheme == scheme else { return nil }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "path" }?.value
    }
}

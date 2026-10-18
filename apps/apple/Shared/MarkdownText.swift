import SwiftUI
import NexClientKit

/// Block Markdown for agent replies, styled like the web UI's `.markdown`: paragraphs, bullet and numbered
/// lists, headings, quotes and code blocks. Inline formatting and safe links come from `Markdown.attributed`.
struct MarkdownText: View {
    let source: String
    var baseSize: CGFloat = 14
    /// Follows Dynamic Type on iOS and the text size setting on macOS.
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1
    private var fontSize: CGFloat { baseSize * scale }

    init(source: String, fontSize: CGFloat = 14) { self.source = source; self.baseSize = fontSize }

    var body: some View {
        VStack(alignment: .leading, spacing: fontSize * 0.6) {
            ForEach(Array(Markdown.blocks(source).enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let text):
            inline(text)
        case .heading(let level, let text):
            inline(text).font(.system(size: fontSize + CGFloat(max(0, 4 - level)) * 2, weight: .semibold))
        case .bullet(let level, let text):
            item(marker: level == 0 ? "•" : "◦", level: level, text: text)
        case .ordered(let level, let number, let text):
            item(marker: "\(number).", level: level, text: text)
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
        Text(Markdown.attributed(text)).font(.system(size: fontSize)).lineSpacing(fontSize * 0.35).foregroundStyle(Theme.foreground)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func item(marker: String, level: Int, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(marker).font(.system(size: fontSize)).foregroundStyle(Theme.foreground).frame(minWidth: 12, alignment: .trailing)
            inline(text)
        }
        .padding(.leading, CGFloat(level) * 18 + 4)
    }
}

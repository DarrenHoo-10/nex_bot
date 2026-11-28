import SwiftUI
import NexClientKit
import NexMarkdown

/// Full GFM block Markdown renderer shared across Mac and iOS: tables, task checkboxes, nested lists/quotes,
/// fenced code blocks, interactive HTML previews, charts, and inline attachment links.
struct MarkdownText: View {
    let source: String
    var baseSize: CGFloat = 14
    var pending = false
    var hug = false
    /// Follows Dynamic Type on iOS and the text size setting on macOS.
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1
    private var fontSize: CGFloat { baseSize * scale }

    init(source: String, fontSize: CGFloat = 14, pending: Bool = false, hug: Bool = false) {
        self.source = source
        self.baseSize = fontSize
        self.pending = pending
        self.hug = hug
    }

    var body: some View {
        VStack(alignment: .leading, spacing: fontSize * 0.6) {
            ForEach(Array(HTMLPreview.parts(source).enumerated()), id: \.offset) { _, part in
                switch part {
                case .markdown(let text): ordinary(text)
                case .preview(let html, let complete): HTMLPreviewMessage(source: html, complete: complete, pending: pending)
                }
            }
        }
    }

    @ViewBuilder private func ordinary(_ source: String) -> some View {
        let document = ChatDocument(source)
        if let html = document.staticHTML {
            StaticHTMLMessage(fragment: html, fontSize: fontSize)
        } else {
            ChatMarkdownBlocks(blocks: document.blocks, fontSize: fontSize)
                .textSelection(.enabled)
                .frame(maxWidth: hug ? nil : .infinity, alignment: .leading)
        }
    }
}

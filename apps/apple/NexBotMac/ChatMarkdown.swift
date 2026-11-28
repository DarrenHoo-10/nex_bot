import SwiftUI
import NexClientKit
import NexMarkdown

/// Native GFM renderer plus file-path chips and inline attachment links (`Shared/ChatMarkdownBlocks.swift`).
struct ChatMarkdown: View {
    let source: String
    var fontSize: CGFloat = 14
    /// Shrink to the content width (user bubbles) instead of filling the column.
    var hug = false
    var pending = false

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

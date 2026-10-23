import SwiftUI
import NexClientKit
import NexMarkdown

/// Native GFM renderer plus file-path chips. An inline `code` span that names a previewable file
/// becomes a link with the `nexbot-file` scheme; `ChatLinks.handle` opens it as a preview in the inspector.
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

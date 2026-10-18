import SwiftUI
import QuickLook
import UIKit
import NexClientKit

/// A temporary file handed to the share sheet or Quick Look.
struct SharedFile: Identifiable {
    let id = UUID()
    let url: URL
}

enum TempFiles {
    /// Writes `data` as `<tmp>/NexBotShare/<uuid>/<name>`; the name is reduced to a safe last path component.
    static func write(_ data: Data, name: String, fallback: String = "附件") throws -> URL {
        let cleaned = name.map { "\\/:*?\"<>|".contains($0) ? "_" : $0 }.map(String.init).joined().trimmingCharacters(in: .whitespacesAndNewlines)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("NexBotShare", isDirectory: true).appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(cleaned.isEmpty || cleaned == "." || cleaned == ".." ? fallback : cleaned)
        try data.write(to: url, options: .atomic)
        return url
    }
}

/// The system share sheet for one file.
struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Quick Look preview of one file (its toolbar offers sharing).
struct QuickLookSheet: UIViewControllerRepresentable {
    let url: URL
    func makeCoordinator() -> Coordinator { Coordinator(url) }
    func makeUIViewController(context: Context) -> UINavigationController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return UINavigationController(rootViewController: controller)
    }
    func updateUIViewController(_ controller: UINavigationController, context: Context) {}

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(_ url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}

/// File icon for a name's extension.
func attachmentIcon(_ name: String) -> String {
    switch (name as NSString).pathExtension.lowercased() {
    case "png", "jpg", "jpeg", "gif", "webp", "heic": "photo"
    case "pdf": "doc.richtext"
    case "zip", "gz", "tar": "doc.zipper"
    default: "doc.text"
    }
}

/// Sent attachments of a message: cards that download the file and open Quick Look.
struct AttachmentCards: View {
    let links: [AttachmentLink]
    let workspace: WorkspaceStore
    var trailing = false
    @State private var loading: String?
    @State private var errorText: String?
    @State private var preview: SharedFile?

    var body: some View {
        VStack(alignment: trailing ? .trailing : .leading, spacing: 6) {
            ForEach(links) { link in
                Button { Task { await open(link) } } label: {
                    HStack(spacing: 8) {
                        Image(systemName: attachmentIcon(link.name)).foregroundStyle(Theme.brand)
                        Text(link.name).font(.subheadline.weight(.medium)).lineLimit(1).truncationMode(.middle).foregroundStyle(Theme.foreground)
                        if loading == link.id { ProgressView().controlSize(.small) }
                        else { Image(systemName: "arrow.down.circle").font(.footnote).foregroundStyle(Theme.muted) }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .frame(maxWidth: 260, alignment: .leading)
                    .cardStyle(radius: 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(loading != nil)
                .accessibilityLabel("附件 \(link.name)")
            }
            if let errorText { Text(errorText).font(.caption).foregroundStyle(Theme.danger) }
        }
        .sheet(item: $preview) { file in QuickLookSheet(url: file.url).ignoresSafeArea() }
        .onDebugUI { cmd, arg in
            if cmd == "openattachment", let link = links.first(where: { arg.isEmpty || $0.name.contains(arg) }) { Task { await open(link) } }
        }
    }

    private func open(_ link: AttachmentLink) async {
        loading = link.id; errorText = nil
        defer { loading = nil }
        do {
            let file = try await workspace.downloadAttachment(id: link.id)
            preview = SharedFile(url: try TempFiles.write(file.data, name: file.filename == "attachment" ? link.name : file.filename))
        } catch { errorText = coreMessage(error) }
    }
}

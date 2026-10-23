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

/// Sent attachments of a message: pictures are thumbnails, other files are cards.
struct AttachmentCards: View {
    let links: [AttachmentLink]
    let workspace: WorkspaceStore
    let conversation: ConversationStore
    let messageID: String
    var trailing = false
    @State private var loading: String?
    @State private var errorText: String?
    @State private var preview: SharedFile?
    @State private var shareFile: SharedFile?
    @State private var imagePreview: ImagePreview?

    var body: some View {
        VStack(alignment: trailing ? .trailing : .leading, spacing: 6) {
            ForEach(links) { link in
                if link.isImage {
                    ImageThumbnail(link: link, workspace: workspace, onOpen: { image in
                        imagePreview = ImagePreview(image: image) {
                            try await conversation.deleteImage(link, messageID: messageID)
                        }
                    }, onSave: { Task { await save(link) } })
                }
                else { card(link) }
            }
            if let errorText { Text(errorText).font(.caption).foregroundStyle(Theme.danger) }
        }
        .sheet(item: $preview) { file in QuickLookSheet(url: file.url).ignoresSafeArea() }
        .sheet(item: $shareFile) { file in ShareSheet(url: file.url) }
        .fullScreenCover(item: $imagePreview) { preview in NativeImageViewer(preview: preview) }
        .onDebugUI { cmd, arg in
            if cmd == "openattachment", let link = links.first(where: { arg.isEmpty || $0.name.contains(arg) }) { Task { await open(link) } }
        }
    }

    private func card(_ link: AttachmentLink) -> some View {
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

    private func open(_ link: AttachmentLink) async {
        loading = link.id; errorText = nil
        defer { loading = nil }
        do {
            let file = try await workspace.downloadAttachment(id: link.id)
            let name = file.filename == "attachment" ? (link.picture ? link.name + ".png" : link.name) : file.filename
            preview = SharedFile(url: try TempFiles.write(file.data, name: name))
        } catch { errorText = coreMessage(error) }
    }

    private func save(_ link: AttachmentLink) async {
        loading = link.id; errorText = nil
        defer { loading = nil }
        do {
            let file = try await workspace.downloadAttachment(id: link.id)
            let name = file.filename == "attachment" ? (link.picture ? link.name + ".png" : link.name) : file.filename
            shareFile = SharedFile(url: try TempFiles.write(file.data, name: name))
        } catch { errorText = coreMessage(error) }
    }
}

/// A sent or generated picture, loaded through Core.
struct ImageThumbnail: View {
    let link: AttachmentLink
    let workspace: WorkspaceStore
    let onOpen: (UIImage) -> Void
    let onSave: () -> Void
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Button { if let image { onOpen(image) } } label: {
            Group {
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                        .frame(width: 240, height: 160)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                } else {
                    RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.card)
                        .frame(width: 240, height: 160)
                        .overlay {
                            if failed { Image(systemName: "photo").font(.title3).foregroundStyle(Theme.muted) }
                            else { ProgressView() }
                        }
                }
            }
        }
        .buttonStyle(.plain)
        .contextMenu { Button { onSave() } label: { Label("存储图片", systemImage: "square.and.arrow.down") } }
        .accessibilityLabel("图片 \(link.name)")
        .task(id: link.id) {
            do { image = UIImage(data: try await workspace.downloadAttachment(id: link.id).data); failed = image == nil }
            catch { failed = true }
        }
    }
}

/// What the picture viewer is showing. The X deletes the picture; the backdrop closes.
struct ImagePreview: Identifiable {
    let id = UUID()
    let image: UIImage
    let onDelete: @MainActor () async throws -> Void
}

struct NativeImageViewer: View {
    let preview: ImagePreview
    @Environment(\.dismiss) private var dismiss
    @State private var deleting = false
    @State private var errorText = ""

    var body: some View {
        ZStack {
            Theme.background.opacity(0.82).background(.ultraThinMaterial).ignoresSafeArea()
                .onTapGesture { dismiss() }
            Image(uiImage: preview.image).resizable().scaledToFit()
                .padding(16)
                .overlay(alignment: .topTrailing) {
                    Button { remove() } label: {
                        Group {
                            if deleting { ProgressView() }
                            else { Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)) }
                        }
                        .frame(width: 34, height: 34)
                        .foregroundStyle(.white)
                        .background(.black.opacity(0.55), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(deleting)
                    .accessibilityLabel("删除图片")
                    .offset(x: 6, y: -6)
                }
            if !errorText.isEmpty {
                Text(errorText).font(.caption).foregroundStyle(Theme.danger)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(Theme.card, in: Capsule())
                    .frame(maxHeight: .infinity, alignment: .bottom).padding(.bottom, 28)
            }
        }
        .statusBarHidden()
    }

    private func remove() {
        guard !deleting else { return }
        deleting = true; errorText = ""
        Task { @MainActor in
            do {
                try await preview.onDelete()
                dismiss()
            } catch {
                errorText = coreMessage(error)
                deleting = false
            }
        }
    }
}

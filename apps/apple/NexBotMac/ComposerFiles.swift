import SwiftUI
import AppKit
import UniformTypeIdentifiers
import NexClientKit

/// Native file handling of the composer: picking, dropping, saving and the attachment views.
enum FilePanels {
    /// 添加文件: the system multi-select picker. Calls `done` with the chosen URLs (empty when cancelled).
    @MainActor static func pickFiles(done: @escaping ([URL]) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.message = "最多添加 5 个附件，单个不超过 5 MB"
        let finish: (NSApplication.ModalResponse) -> Void = { done($0 == .OK ? panel.urls : []) }
        if let window = NSApp.keyWindow { panel.beginSheetModal(for: window, completionHandler: finish) } else { panel.begin(completionHandler: finish) }
    }

    /// Asks where to save `data` under the suggested `filename`. Returns the written URL, nil when cancelled.
    @MainActor static func save(_ data: Data, suggested filename: String) throws -> URL? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = filename
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        try data.write(to: url, options: .atomic)
        return url
    }
}

extension ConversationStore {
    /// Uploads files from disk one after another. Folders are skipped; at most 5 MiB + 1 byte of a file is read, so an
    /// oversized file is rejected by the kit ("文件不能超过 5 MB") without loading it.
    func addFiles(_ urls: [URL]) async {
        for url in urls {
            let name = url.lastPathComponent
            let data: Data? = await Task.detached {
                if (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true { return nil }
                guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
                defer { try? handle.close() }
                return (try? handle.read(upToCount: ChatAttachment.maxBytes + 1)) ?? Data()
            }.value
            guard let data else { continue }
            await addAttachment(name: name, data: data)
        }
    }
}

/// Lays children out left to right, wrapping to new rows.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        return CGSize(width: rows.map(\.width).max() ?? 0, height: rows.last.map { $0.y + $0.height } ?? 0)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(width: bounds.width, subviews: subviews) {
            for item in row.items { subviews[item.index].place(at: CGPoint(x: bounds.minX + item.x, y: bounds.minY + row.y), proposal: .unspecified) }
        }
    }
    private struct Row { var items: [(index: Int, x: CGFloat)] = []; var y: CGFloat = 0, width: CGFloat = 0, height: CGFloat = 0 }
    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if !rows[rows.count - 1].items.isEmpty, rows[rows.count - 1].width + spacing + size.width > width {
                let previous = rows[rows.count - 1]
                rows.append(Row(y: previous.y + previous.height + spacing))
            }
            var row = rows[rows.count - 1]
            let x = row.items.isEmpty ? 0 : row.width + spacing
            row.items.append((index, x)); row.width = x + size.width; row.height = max(row.height, size.height)
            rows[rows.count - 1] = row
        }
        return rows
    }
}

/// Files waiting in the composer: name, uploading / failed state and a remove button.
struct AttachmentChips: View {
    let conversation: ConversationStore

    var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(conversation.attachments) { file in chip(file) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel("待发送的附件")
    }

    private func chip(_ file: PendingAttachment) -> some View {
        HStack(spacing: 8) {
            if file.isUploading { ProgressView().controlSize(.small).scaleEffect(0.6).frame(width: 16, height: 16) }
            else if file.errorMessage != nil { Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 13)).foregroundStyle(Theme.danger) }
            else { Image(systemName: "doc.text").font(.system(size: 14)).foregroundStyle(Theme.foreground) }
            VStack(alignment: .leading, spacing: 1) {
                Text(file.name).font(.system(size: 12)).lineLimit(1).truncationMode(.middle)
                if file.isUploading { Text("正在上传…").font(.system(size: 10)).foregroundStyle(Theme.muted) }
                if let message = file.errorMessage { Text(message).font(.system(size: 10)).foregroundStyle(Theme.danger).lineLimit(2) }
            }
            Button { conversation.removeAttachment(file) } label: {
                Image(systemName: "xmark").font(.system(size: 10, weight: .medium)).foregroundStyle(Theme.muted)
                    .frame(width: 20, height: 20).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(conversation.isSending)
            .help("移除 \(file.name)").accessibilityLabel("移除 \(file.name)")
        }
        .padding(.horizontal, 10).padding(.vertical, 7).frame(maxWidth: 260, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(file.errorMessage != nil ? Theme.danger.opacity(0.5) : Theme.border))
    }
}

/// A sent file inside a message: icon, name and download (saved through the system save panel).
struct AttachmentCard: View {
    let link: AttachmentLink
    let conversation: ConversationStore
    @State private var downloading = false
    @State private var error: String?
    @State private var hover = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(action: download) {
                HStack(spacing: 8) {
                    Image(systemName: "doc.text").font(.system(size: 13)).foregroundStyle(Theme.muted)
                    Text(link.name).font(.system(size: 13)).foregroundStyle(Theme.foreground).lineLimit(1).truncationMode(.middle).frame(maxWidth: 280, alignment: .leading)
                    if downloading { ProgressView().controlSize(.small).scaleEffect(0.6).frame(width: 14, height: 14) }
                    else { Image(systemName: "arrow.down.to.line").font(.system(size: 11)).foregroundStyle(Theme.muted) }
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(hover ? Theme.secondary : Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).onHover { hover = $0 }
            .help("下载 \(link.name)").accessibilityLabel("下载 \(link.name)")
            if let error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled) }
        }
    }

    private func download() {
        guard !downloading else { return }
        downloading = true; error = nil
        Task {
            defer { downloading = false }
            do {
                let file = try await conversation.download(link)
                _ = try FilePanels.save(file.data, suggested: file.filename)
            } catch { self.error = message(of: error) }
        }
    }

    #if DEBUG
    /// DEBUG: download without a save panel; returns the file name Core suggested.
    static func debugDownload(_ link: AttachmentLink, conversation: ConversationStore, to path: String) async throws -> String {
        let file = try await conversation.download(link)
        try file.data.write(to: URL(fileURLWithPath: path))
        return file.filename
    }
    #endif
}

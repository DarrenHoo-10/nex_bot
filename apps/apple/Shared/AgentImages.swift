import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import NexClientKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

struct AgentComposerAdd: View {
    @Binding var images: [CliImageUpload]
    @Binding var error: String
    var openModels: (() -> Void)?
    @State private var picking = false

    var body: some View {
        Menu {
            Button("选择图片", systemImage: "photo.on.rectangle") { picking = true }
            Button("粘贴图片", systemImage: "clipboard", action: paste)
            if let openModels { Button("模型", systemImage: "cpu", action: openModels) }
        } label: {
            Image(systemName: "plus").font(.system(size: 17, weight: .medium))
                .foregroundStyle(Theme.muted).frame(width: 36, height: 36)
        }
        .accessibilityLabel("添加")
        .fileImporter(isPresented: $picking, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            switch result {
            case .failure(let cause): error = cause.localizedDescription
            case .success(let urls):
                for url in urls {
                    let permitted = url.startAccessingSecurityScopedResource()
                    defer { if permitted { url.stopAccessingSecurityScopedResource() } }
                    if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > ChatAttachment.maxBytes {
                        error = "图片不能超过 5 MB"
                        continue
                    }
                    guard let bytes = try? Data(contentsOf: url, options: .mappedIfSafe) else { error = "无法读取所选图片"; continue }
                    add(url.lastPathComponent, bytes: bytes)
                }
            }
        }
    }

    private func paste() {
        #if os(iOS)
        let bytes = UIPasteboard.general.image?.pngData()
        #else
        let clipboard = NSPasteboard.general
        let bytes = clipboard.data(forType: .png) ?? clipboard.data(forType: .tiff)
        #endif
        guard let bytes else { error = "剪贴板里没有可用的图片"; return }
        add("粘贴的图片.png", bytes: bytes)
    }

    private func add(_ name: String, bytes: Data) {
        guard images.count < ChatAttachment.maxCount else { error = "最多添加 5 张图片"; return }
        guard !bytes.isEmpty, bytes.count <= ChatAttachment.maxBytes else { error = "图片不能超过 5 MB"; return }
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil) else { error = "无法读取所选图片"; return }
        let type = CGImageSourceGetType(source).map { $0 as String }
        if [UTType.png.identifier, UTType.jpeg.identifier, UTType.webP.identifier].contains(type ?? "") {
            images.append(.init(name: name, data: bytes))
        } else {
            let options = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                           kCGImageSourceThumbnailMaxPixelSize: 3072] as CFDictionary
            let buffer = NSMutableData()
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options),
                  let output = CGImageDestinationCreateWithData(buffer, UTType.jpeg.identifier as CFString, 1, nil) else {
                error = "无法读取所选图片"; return
            }
            CGImageDestinationAddImage(output, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
            guard CGImageDestinationFinalize(output), buffer.length <= ChatAttachment.maxBytes else { error = "图片不能超过 5 MB"; return }
            images.append(.init(name: (name as NSString).deletingPathExtension + ".jpg", data: buffer as Data))
        }
        error = ""
    }
}

/// Images about to be sent: only their thumbnails, which open the picture, each with a remove button on its corner.
struct AgentImageDrafts: View {
    @Binding var images: [CliImageUpload]

    var body: some View {
        if !images.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: 10) {
                    ForEach(images) { image in
                        AgentImageDraft(image: image) { images.removeAll { $0.id == image.id } }
                    }
                }
                // room for the corner buttons, which sit half outside each thumbnail
                .padding(.top, 8).padding(.trailing, 8)
            }
            .scrollIndicators(.hidden)
        }
    }
}

private struct AgentImageDraft: View {
    let image: CliImageUpload
    let remove: () -> Void
    @State private var thumbnail: CGImage?
    @State private var open = false

    var body: some View {
        Button { open = true } label: {
            Group {
                if let thumbnail {
                    Image(thumbnail, scale: 1, label: Text(image.name)).resizable().scaledToFill()
                } else {
                    Theme.card.overlay { Image(systemName: "photo").foregroundStyle(Theme.muted) }
                }
            }
            .frame(width: 48, height: 48)
            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Theme.border))
        }
        .buttonStyle(.plain)
        .disabled(thumbnail == nil)
        .accessibilityLabel("查看图片 " + image.name)
        .overlay(alignment: .topTrailing) {
            Button(action: remove) {
                Image(systemName: "xmark").font(.system(size: 8, weight: .bold)).foregroundStyle(.white)
                    .frame(width: 18, height: 18)
                    .background(.black.opacity(0.72), in: Circle())
                    .overlay(Circle().strokeBorder(.white, lineWidth: 1.5))
                    .contentShape(Circle().inset(by: -6))
            }
            .buttonStyle(.plain)
            .offset(x: 7, y: -7)
            .accessibilityLabel("移除 " + image.name)
        }
        .task(id: image.id) {
            let bytes = image.data
            let preview = await Task.detached { agentPreview(bytes, pixels: 160) }.value
            if !Task.isCancelled { thumbnail = preview }
        }
        .sheet(isPresented: $open) {
            if let thumbnail { AgentImageViewer(data: image.data, thumbnail: thumbnail, name: image.name) }
        }
    }
}

struct AgentImageMessage: View {
    let text: String
    let load: (String) async throws -> Data
    private static let pattern = /!\[([^\]\n]*)\]\((?:https?:\/\/[^\/\s()]+)?(\/api\/cli-agents\/images\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\?ticket=[^)\s]+)?\)/
    private static let standalone = /(?m)^[ \t]*(?:https?:\/\/[^\/\s()]+)?(\/api\/cli-agents\/images\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\?ticket=[^\s)]+)?[ \t]*$/

    var body: some View {
        let withoutMarkdown = text.replacing(Self.pattern, with: "")
        let matches = text.matches(of: Self.pattern).map {
            (name: String($0.output.1), path: String($0.output.2), start: $0.range.lowerBound)
        } + text.matches(of: Self.standalone).map {
            (name: "图片", path: String($0.output.1), start: $0.range.lowerBound)
        }
        var seen = Set<String>()
        let images = matches.sorted { $0.start < $1.start }.filter { seen.insert($0.path).inserted }
        let caption = withoutMarkdown.replacing(Self.standalone, with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        VStack(alignment: .trailing, spacing: 6) {
            if !images.isEmpty {
                OutlineFlow(spacing: 6, trailing: true) {
                    ForEach(images, id: \.path) { image in
                        AgentImagePreview(name: image.name, path: image.path, load: load)
                    }
                }
            }
            if !caption.isEmpty {
                Text(caption).font(.system(size: 14)).foregroundStyle(Color.white).textSelection(.enabled)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(
                        LinearGradient(colors: [Theme.nexAgentBubbleTop, Theme.nexAgentBubbleBottom], startPoint: .topLeading, endPoint: .bottomTrailing),
                        in: Bubble.user
                    )
            }
        }
    }
}

private struct AgentImagePreview: View {
    let name: String
    let path: String
    let load: (String) async throws -> Data
    @State private var thumbnail: CGImage?
    @State private var data: Data?
    @State private var failed = false
    @State private var open = false

    private var bounds: CGSize {
        #if os(iOS)
        CGSize(width: 36, height: 36)
        #else
        CGSize(width: 240, height: 160)
        #endif
    }

    private var cornerRadius: CGFloat { bounds.width <= 36 ? 5 : 12 }

    var body: some View {
        Button { open = true } label: {
            Group {
                if let thumbnail {
                    let width = CGFloat(thumbnail.width)
                    let height = CGFloat(thumbnail.height)
                    let scale = min(bounds.width / width, bounds.height / height)
                    Image(thumbnail, scale: 1, label: Text(name)).resizable()
                        .frame(width: width * scale, height: height * scale)
                } else {
                    RoundedRectangle(cornerRadius: cornerRadius).fill(Theme.card)
                        .overlay {
                            if failed { Image(systemName: "photo").foregroundStyle(Theme.muted) }
                            else { ProgressView().controlSize(.small) }
                        }
                        .frame(width: bounds.width, height: bounds.height)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
        }
        .buttonStyle(.plain)
        .disabled(thumbnail == nil)
        .accessibilityLabel(failed ? "图片无法显示：\(name)" : "查看图片 \(name)")
        .task(id: path) {
            do {
                let bytes = try await load(path)
                let preview = await Task.detached { agentPreview(bytes, pixels: 480) }.value
                guard !Task.isCancelled else { return }
                thumbnail = preview
                data = preview == nil ? nil : bytes
                failed = preview == nil
            } catch {
                if !Task.isCancelled { failed = true }
            }
        }
        .sheet(isPresented: $open) {
            if let data, let thumbnail { AgentImageViewer(data: data, thumbnail: thumbnail, name: name) }
        }
    }
}

private struct AgentImageViewer: View {
    let data: Data
    let thumbnail: CGImage
    let name: String
    @State private var large: CGImage?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            Image(large ?? thumbnail, scale: 1, label: Text(name)).resizable().scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: .infinity).padding(12)
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 15, weight: .semibold))
                    .frame(width: 38, height: 38)
                    .foregroundStyle(.white)
                    .background(.black.opacity(0.65), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("关闭图片预览")
            .keyboardShortcut(.cancelAction)
            .padding(12)
        }
        #if os(macOS)
        .frame(minWidth: 640, minHeight: 420)
        #endif
        .task {
            let bytes = data
            let preview = await Task.detached { agentPreview(bytes, pixels: 3200) }.value
            if !Task.isCancelled { large = preview }
        }
    }
}

private func agentPreview(_ data: Data, pixels: Int) -> CGImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
    return CGImageSourceCreateThumbnailAtIndex(source, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: pixels,
    ] as CFDictionary)
}

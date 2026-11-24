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

struct AgentImageDrafts: View {
    @Binding var images: [CliImageUpload]

    var body: some View {
        if !images.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: 6) {
                    ForEach(images) { image in
                        Button { images.removeAll { $0.id == image.id } } label: {
                            Label(image.name, systemImage: "xmark.circle").lineLimit(1).font(.caption)
                        }
                        .buttonStyle(.bordered)
                        .accessibilityLabel("移除 " + image.name)
                    }
                }
            }
            .scrollIndicators(.hidden)
        }
    }
}

struct AgentImageMessage: View {
    let text: String
    let load: (String) async throws -> Data
    private static let pattern = /!\[([^\]\n]*)\]\((\/api\/cli-agents\/images\/[0-9a-f-]{36})\)/

    var body: some View {
        let images = text.matches(of: Self.pattern)
        let caption = text.replacing(Self.pattern, with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        VStack(alignment: .trailing, spacing: 6) {
            if !caption.isEmpty { Text(caption).font(.system(size: 14)).textSelection(.enabled) }
            ForEach(Array(images.enumerated()), id: \.offset) { _, match in
                AgentImagePreview(name: String(match.output.1), path: String(match.output.2), load: load)
            }
        }
    }
}

private struct AgentImagePreview: View {
    let name: String
    let path: String
    let load: (String) async throws -> Data
    @State private var image: Image?

    var body: some View {
        Group {
            if let image { image.resizable().scaledToFit().frame(maxWidth: 240, maxHeight: 180).accessibilityLabel(name) }
            else { Label(name, systemImage: "photo").font(.caption).lineLimit(1) }
        }
        .task(id: path) {
            guard let bytes = try? await load(path), !Task.isCancelled else { return }
            #if os(iOS)
            if let photo = UIImage(data: bytes) { image = Image(uiImage: photo) }
            #else
            if let photo = NSImage(data: bytes) { image = Image(nsImage: photo) }
            #endif
        }
    }
}

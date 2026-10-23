import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import NexClientKit

/// A message the next send quotes.
struct QuoteDraft: Equatable {
    var author: String
    var text: String
    /// `> {author}：{text, whitespace collapsed, first 140 characters}` followed by a blank line.
    var prefix: String {
        let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return "> \(author)：\(flat.prefix(140))\n\n"
    }
}

/// Which composer popover is open: the ＋ menu (添加 / 指令) or the permission menu.
enum ComposerMenu: Equatable { case add, permissions }

struct ComposerView: View {
    let workspace: WorkspaceStore
    let botID: String
    @Bindable var conversation: ConversationStore
    let botName: String
    @Binding var quote: QuoteDraft?
    @Binding var menu: ComposerMenu?
    @Environment(Navigation.self) private var nav
    @State private var stopping = false
    @State private var showMentionsDismissed = false
    @State private var showFiles = false
    @State private var showPhotos = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var exportFile: SharedFile?
    @State private var exporting = false
    @State private var actionError: String?
    @State private var showModels = false
    @State private var draftImage: ImagePreview?

    private var hasModel: Bool { workspace.state?.config != nil }
    private var canSend: Bool { conversation.canSend && hasModel }
    private var bot: Bot? { workspace.bot(botID) }
    private var config: ModelConfig? { workspace.state?.config }
    private var defaultModel: String { config?.defaultModel ?? "" }
    /// The assistant's own model; empty while it follows the default.
    private var chatModel: String { bot?.selectedModel ?? "" }
    private var mode: ApprovalMode { bot?.approvalMode ?? .standard }
    private var tasks: [AgentTask] { workspace.state?.unfinishedTasks(botID: botID) ?? [] }
    private var showStop: Bool {
        !tasks.isEmpty && conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && conversation.attachments.isEmpty
    }
    private var allCancelling: Bool { !tasks.isEmpty && tasks.allSatisfy { $0.status == "cancelling" } }
    private var errorText: String? { conversation.sendError ?? actionError }

    /// The `@fragment` at the end of the draft (`(?:^|\s)@([^\s@]*)$`).
    private var mentionFragment: String? {
        conversation.draft.firstMatch(of: /(?:^|\s)@([^\s@]*)$/).map { String($0.output.1) }
    }
    private var mentionCandidates: [Bot] {
        guard let fragment = mentionFragment, !showMentionsDismissed else { return [] }
        return workspace.bots.filter { $0.id != botID && (fragment.isEmpty || $0.name.localizedCaseInsensitiveContains(fragment)) }
    }

    var body: some View {
        VStack(spacing: 6) {
            if !tasks.isEmpty { statusBar }
            if let error = errorText {
                Text(error).font(.footnote).foregroundStyle(Theme.danger).frame(maxWidth: .infinity, alignment: .leading)
            }
            if !mentionCandidates.isEmpty { mentionList }
            if let quote { quoteBar(quote) }
            if menu == .add { addMenu.transition(.opacity) }
            if menu == .permissions { permissionMenu.frame(maxWidth: .infinity, alignment: .leading).transition(.opacity) }
            if !conversation.attachments.isEmpty { attachmentChips }
            VStack(alignment: .leading, spacing: 4) {
                TextField("给 \(botName) 发消息…", text: $conversation.draft, axis: .vertical)
                    .lineLimit(1...5)
                    .padding(.horizontal, 6).padding(.top, 6)
                    .accessibilityLabel("发送给 Agent 的消息")
                    .onChange(of: conversation.draft) { showMentionsDismissed = false; menu = nil }
                HStack(spacing: 8) {
                    Button { toggle(.add) } label: {
                        Image(systemName: "plus").font(.system(size: 17, weight: .medium))
                            .foregroundStyle(menu == .add ? Theme.foreground : Theme.muted)
                            .frame(width: 34, height: 34)
                            .background(menu == .add ? Theme.secondary : .clear, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(conversation.isSending || conversation.isUploadingAttachments)
                    .accessibilityLabel("添加文件或指令")
                    Spacer(minLength: 0)
                    // While the agent works and nothing is typed, the send key stops it (web composer).
                    if showStop {
                        Button { Task { await stopAll() } } label: {
                            Image(systemName: "stop.fill").font(.system(size: 13, weight: .semibold))
                                .frame(width: 34, height: 34)
                                .foregroundStyle(Theme.primaryForeground)
                                .background(Theme.primary, in: Circle())
                        }
                        .disabled(stopping || allCancelling || workspace.connection == .resyncing)
                        .accessibilityLabel("停止任务")
                    } else {
                        Button { Task { await send() } } label: {
                            Group {
                                if conversation.isSending { ProgressView() }
                                else { Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold)) }
                            }
                            .frame(width: 34, height: 34)
                            .foregroundStyle(canSend ? Theme.primaryForeground : Theme.muted)
                            .background(canSend ? Theme.primary : Theme.secondary, in: Circle())
                        }
                        .disabled(!canSend)
                        .accessibilityLabel("发送消息")
                    }
                }
            }
            .padding(.horizontal, 6).padding(.bottom, 6)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Theme.border))
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.background)
        .animation(.easeOut(duration: 0.12), value: menu)
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { Task { await addFiles(urls) } }
            else if case .failure(let error) = result { actionError = coreMessage(error) }
        }
        .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: ChatAttachment.maxCount, matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { await addPhotos(items) }
        }
        .sheet(isPresented: $showModels) {
            ModelPickerSheet(title: "选择聊天模型", value: chatModel, emptyLabel: "默认 · \(defaultModel)",
                             models: workspace.state?.modelVisibility.models, source: workspace.savedModelSource(), onSelect: { setModel($0) })
                .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
        .sheet(item: $exportFile) { file in ShareSheet(url: file.url).presentationDetents([.medium, .large]) }
        .fullScreenCover(item: $draftImage) { preview in NativeImageViewer(preview: preview) }
        .debugCommand { command, arg in
            switch command {
            case "type": conversation.draft = arg
            case "composerplus": conversation.draft += " @"
            case "sendquoted", "sendnow": Task { await send() }
            case "addmenu": menu = .add
            case "permmenu": menu = .permissions
            case "modelmenu": menu = nil; showModels = true
            case "closemodels": showModels = false
            case "modelpick": setModel(arg == "-" ? "" : arg)
            case "closemenu": menu = nil
            case "exportui": Task { await export() }
            default: break
            }
        }
    }

    // MARK: Parts

    private var statusBar: some View {
        HStack(spacing: 6) {
            Circle().fill(Theme.success).frame(width: 6, height: 6)
            Text(tasks.contains { $0.status == "cancelling" } ? "正在停止…" : "Agent 正在工作 · \(tasks[0].phrase)")
                .font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, 6)
    }

    private func quoteBar(_ quote: QuoteDraft) -> some View {
        HStack(spacing: 8) {
            Rectangle().fill(Theme.brand).frame(width: 3)
            VStack(alignment: .leading, spacing: 1) {
                Text("引用 \(quote.author)").font(.caption.weight(.semibold))
                Text(quote.text.split(whereSeparator: \.isWhitespace).joined(separator: " ")).font(.caption).foregroundStyle(Theme.muted).lineLimit(2)
            }
            Spacer(minLength: 4)
            Button { self.quote = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted).frame(width: 28, height: 28) }
                .buttonStyle(.plain).accessibilityLabel("取消引用")
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .fixedSize(horizontal: false, vertical: true)
    }

    private var mentionList: some View {
        VStack(spacing: 0) {
            ForEach(mentionCandidates.prefix(5)) { bot in
                Button { insert(bot) } label: {
                    HStack(spacing: 10) {
                        workspace.avatar(of: bot, size: 26)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("@\(bot.name)").font(.subheadline.weight(.semibold)).lineLimit(1)
                            Text(bot.instructions.isEmpty ? "同伴 Agent" : bot.instructions).font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .cardStyle(radius: 12)
        .accessibilityElement(children: .contain).accessibilityLabel("提及同伴 Agent")
    }

    private func heading(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(Theme.muted).padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func menuRow(_ icon: String, _ title: String, _ hint: String? = nil, value: String? = nil, disabled: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.system(size: 16)).frame(width: 22)
                Text(title).font(.subheadline.weight(.semibold))
                if let hint { Text(hint).font(.footnote).foregroundStyle(Theme.muted) }
                Spacer(minLength: 8)
                if let value { Text(value).font(.footnote).foregroundStyle(Theme.muted) }
            }
            .foregroundStyle(Theme.foreground)
            .padding(.horizontal, 12).padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
    }

    /// 添加 / 指令 groups of the web's ＋ menu.
    private var addMenu: some View {
        VStack(spacing: 0) {
            heading("添加")
            menuRow("paperclip", "文件", "file", disabled: conversation.isUploadingAttachments) { menu = nil; showFiles = true }
            menuRow("photo", "照片", "photo", disabled: conversation.isUploadingAttachments) { menu = nil; showPhotos = true }
            pasteRow
            heading("指令")
            menuRow(mode == .full ? "exclamationmark.shield" : "checkmark.shield", "权限", "permission", value: mode.title, disabled: bot == nil) { menu = .permissions }
            menuRow("slider.horizontal.3", "模型", "model", value: chatModel.isEmpty ? (defaultModel.isEmpty ? "未连接模型" : defaultModel) : chatModel, disabled: config == nil || bot == nil) { menu = nil; showModels = true }
            menuRow("square.and.arrow.down", "导出对话", "export", value: exporting ? "导出中…" : "Markdown", disabled: conversation.messages.isEmpty || exporting) { menu = nil; Task { await export() } }
        }
        .padding(.bottom, 4)
        .cardStyle(radius: 16)
        .accessibilityElement(children: .contain).accessibilityLabel("添加与指令")
    }

    /// 粘贴图片: the system paste button reads a copied picture without the "允许粘贴" prompt.
    private var pasteRow: some View {
        HStack(spacing: 12) {
            Image(systemName: "doc.on.clipboard").font(.system(size: 16)).frame(width: 22)
            Text("粘贴图片").font(.subheadline.weight(.semibold))
            Spacer(minLength: 8)
            PasteButton(supportedContentTypes: [.png, .jpeg, .heic, .gif, .webP, .image]) { providers in
                Task { @MainActor in menu = nil; await addPasted(providers) }
            }
            .labelStyle(.titleOnly).buttonBorderShape(.capsule).controlSize(.small)
            .disabled(conversation.isUploadingAttachments)
        }
        .foregroundStyle(Theme.foreground)
        .padding(.horizontal, 12).padding(.vertical, 7)
        .accessibilityElement(children: .contain).accessibilityLabel("粘贴图片")
    }

    private func addPasted(_ providers: [NSItemProvider]) async {
        actionError = nil
        for (index, provider) in providers.enumerated() {
            guard let picture = await Self.pastedPicture(provider) else { actionError = "剪贴板里没有可用的图片"; continue }
            await conversation.addAttachment(name: "粘贴的图片-\(Int(Date().timeIntervalSince1970))-\(index + 1).\(picture.ext)", data: picture.data)
        }
    }

    /// PNG and JPEG are kept as they are; other formats (HEIC, WebP, …) are converted to PNG.
    static func pastedPicture(_ provider: NSItemProvider) async -> (data: Data, ext: String)? {
        for (type, ext) in [(UTType.png, "png"), (UTType.jpeg, "jpg")] where provider.hasItemConformingToTypeIdentifier(type.identifier) {
            if let data = await load(provider, type) { return (data, ext) }
        }
        guard let data = await load(provider, .image), let png = UIImage(data: data)?.pngData() else { return nil }
        return (png, "png")
    }

    private static func load(_ provider: NSItemProvider, _ type: UTType) async -> Data? {
        await withCheckedContinuation { done in
            _ = provider.loadDataRepresentation(for: type) { data, _ in done.resume(returning: data) }
        }
    }

    private var permissionMenu: some View {
        VStack(spacing: 0) {
            ForEach(ApprovalMode.allCases) { option in
                Button { menu = nil; Task { await setMode(option) } } label: {
                    HStack(spacing: 12) {
                        Image(systemName: option == .full ? "exclamationmark.shield" : "checkmark.shield").font(.system(size: 16)).frame(width: 22)
                        Text(option.title).font(.subheadline.weight(.semibold))
                        Spacer(minLength: 8)
                        if option == mode { Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)) }
                    }
                    .foregroundStyle(Theme.foreground)
                    .padding(.horizontal, 12).padding(.vertical, 11)
                    .background(option == mode ? Theme.secondary : .clear)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.title).accessibilityAddTraits(option == mode ? .isSelected : [])
            }
        }
        .frame(width: 216)
        .cardStyle(radius: 16)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .contain).accessibilityLabel("选择操作权限")
    }

    private var attachmentChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(conversation.attachments) { file in
                    if file.preview != nil { composerPicture(file) }
                    else { fileChip(file) }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    @ViewBuilder private func composerPicture(_ file: PendingAttachment) -> some View {
        if file.isUploading {
            ComposerImagePlaceholder(uploading: true)
                .accessibilityLabel("\(file.name) 正在上传")
        } else if file.errorMessage != nil {
            ZStack(alignment: .topTrailing) {
                ComposerImagePlaceholder(uploading: false)
                Button { conversation.removeAttachment(file) } label: {
                    Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
                        .frame(width: 20, height: 20).foregroundStyle(.white)
                        .background(.black.opacity(0.65), in: Circle())
                }
                .buttonStyle(.plain).offset(x: 5, y: -5)
                .accessibilityLabel("移除 \(file.name)")
            }
        } else if let preview = file.preview, let image = UIImage(data: preview) {
            Button {
                draftImage = ImagePreview(image: image) { conversation.removeAttachment(file) }
            } label: {
                Image(uiImage: image).resizable().scaledToFill()
                    .frame(width: 56, height: 56)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.border))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("查看图片 \(file.name)")
        } else {
            ComposerImagePlaceholder(uploading: false)
        }
    }

    private func fileChip(_ file: PendingAttachment) -> some View {
        HStack(spacing: 6) {
            if file.isUploading { ProgressView().controlSize(.small) }
            else if file.errorMessage != nil { Image(systemName: "exclamationmark.circle").foregroundStyle(Theme.danger) }
            else { Image(systemName: attachmentIcon(file.name)).foregroundStyle(Theme.muted) }
            VStack(alignment: .leading, spacing: 0) {
                Text(file.name).font(.footnote.weight(.medium)).lineLimit(1).truncationMode(.middle).frame(maxWidth: 160, alignment: .leading)
                if file.isUploading { Text("正在上传…").font(.caption2).foregroundStyle(Theme.muted) }
                else if let message = file.errorMessage { Text(message).font(.caption2).foregroundStyle(Theme.danger).lineLimit(1).frame(maxWidth: 160, alignment: .leading) }
            }
            Button { conversation.removeAttachment(file) } label: {
                Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted).frame(width: 24, height: 24)
            }
            .buttonStyle(.plain).disabled(conversation.isSending)
            .accessibilityLabel("移除 \(file.name)")
        }
        .padding(.leading, 10).padding(.trailing, 4).padding(.vertical, 4)
        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(file.errorMessage != nil ? Theme.danger.opacity(0.6) : .clear))
    }

    // MARK: Actions

    private func toggle(_ target: ComposerMenu) { menu = menu == target ? nil : target }

    private func addFiles(_ urls: [URL]) async {
        actionError = nil
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            if size > ChatAttachment.maxBytes { actionError = ChatAttachment.tooLargeMessage; continue }
            guard let data = try? Data(contentsOf: url) else { actionError = "无法读取 \(url.lastPathComponent)"; continue }
            await conversation.addAttachment(name: url.lastPathComponent, data: data)
        }
    }

    private func addPhotos(_ items: [PhotosPickerItem]) async {
        actionError = nil
        for (index, item) in items.enumerated() {
            guard let data = try? await item.loadTransferable(type: Data.self) else { actionError = "无法读取所选照片"; continue }
            let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
            await conversation.addAttachment(name: "照片-\(Int(Date().timeIntervalSince1970))-\(index + 1).\(ext)", data: data)
        }
    }

    private func setModel(_ next: String) {
        guard next != chatModel else { return }
        actionError = nil
        Task {
            do { try await workspace.setAgentModel(botID: botID, model: next) } catch { actionError = coreMessage(error) }
        }
    }

    private func setMode(_ next: ApprovalMode) async {
        guard next != mode else { return }
        actionError = nil
        do { try await workspace.setApprovalMode(botID: botID, mode: next) } catch { actionError = coreMessage(error) }
    }

    private func export() async {
        guard !exporting else { return }
        exporting = true; actionError = nil
        defer { exporting = false }
        do {
            let result = try await workspace.exportMarkdown(botID: botID)
            exportFile = SharedFile(url: try TempFiles.write(Data(result.content.utf8), name: result.filename, fallback: "NexBot-对话.md"))
        } catch { actionError = coreMessage(error) }
    }

    private func insert(_ bot: Bot) {
        guard let fragment = mentionFragment else { return }
        conversation.draft = String(conversation.draft.dropLast(fragment.count)) + bot.name + " "
    }

    private func send() async {
        guard canSend else { return }
        menu = nil; actionError = nil
        let hasText = !conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let text = hasText ? (quote?.prefix ?? "") + conversation.draft : ""
        if await conversation.send(text: text) {
            conversation.draft = ""; quote = nil
        }
    }

    private func stopAll() async {
        stopping = true
        defer { stopping = false }
        for task in tasks where task.status != "cancelling" { try? await workspace.cancelTask(task.id) }
    }
}

private struct ComposerImagePlaceholder: View {
    let uploading: Bool
    @State private var pulse = false

    var body: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(Theme.secondary)
            .frame(width: 56, height: 56)
            .overlay {
                if uploading { ProgressView().controlSize(.small) }
                else { Image(systemName: "photo").font(.system(size: 16)).foregroundStyle(Theme.muted) }
            }
            .opacity(uploading && pulse ? 0.45 : 1)
            .animation(uploading ? .easeInOut(duration: 1.05).repeatForever(autoreverses: true) : nil, value: pulse)
            .onAppear { if uploading { pulse = true } }
    }
}

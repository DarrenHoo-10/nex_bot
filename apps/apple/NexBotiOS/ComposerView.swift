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

    private var hasModel: Bool { workspace.state?.config != nil }
    private var canSend: Bool { conversation.canSend && hasModel }
    private var bot: Bot? { workspace.bot(botID) }
    private var mode: ApprovalMode { bot?.approvalMode ?? .standard }
    private var tasks: [AgentTask] { workspace.state?.unfinishedTasks(botID: botID) ?? [] }
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
                    permissionButton
                    Spacer(minLength: 0)
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
        .sheet(item: $exportFile) { file in ShareSheet(url: file.url).presentationDetents([.medium, .large]) }
        .debugCommand { command, arg in
            switch command {
            case "type": conversation.draft = arg
            case "composerplus": conversation.draft += " @"
            case "sendquoted", "sendnow": Task { await send() }
            case "addmenu": menu = .add
            case "permmenu": menu = .permissions
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
            Button { Task { await stopAll() } } label: {
                Label("停止任务", systemImage: "stop").font(.caption).foregroundStyle(Theme.foreground)
            }
            .buttonStyle(.plain)
            .disabled(stopping || allCancelling || workspace.connection == .resyncing)
            .accessibilityLabel("停止任务")
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

    private var permissionButton: some View {
        let full = mode == .full
        return Button { toggle(.permissions) } label: {
            HStack(spacing: 5) {
                Image(systemName: full ? "exclamationmark.shield" : "checkmark.shield").font(.system(size: 14, weight: .medium))
                Text(mode.title).font(.footnote.weight(.medium)).lineLimit(1)
                Image(systemName: "chevron.up").font(.system(size: 10, weight: .semibold)).rotationEffect(.degrees(menu == .permissions ? 180 : 0))
            }
            .foregroundStyle(full ? Theme.approval : Theme.muted)
            .padding(.horizontal, 10).frame(height: 34)
            .background(full ? Theme.approvalSoft : Theme.secondary, in: Capsule())
            .overlay(Capsule().stroke(full ? Theme.approval.opacity(0.5) : .clear))
        }
        .buttonStyle(.plain)
        .disabled(bot == nil)
        .accessibilityLabel("操作权限")
        .accessibilityValue(mode.title)
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
            heading("指令")
            menuRow(mode == .full ? "exclamationmark.shield" : "checkmark.shield", "权限", "permission", value: mode.title, disabled: bot == nil) { menu = .permissions }
            menuRow("slider.horizontal.3", "模型设置", "model") { menu = nil; nav.openSettings(.model) }
            menuRow("square.and.arrow.down", "导出对话", "export", value: exporting ? "导出中…" : "Markdown", disabled: conversation.messages.isEmpty || exporting) { menu = nil; Task { await export() } }
        }
        .padding(.bottom, 4)
        .cardStyle(radius: 16)
        .accessibilityElement(children: .contain).accessibilityLabel("添加与指令")
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
            }
            .padding(.horizontal, 2)
        }
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

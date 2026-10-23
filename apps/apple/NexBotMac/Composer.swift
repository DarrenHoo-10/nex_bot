import SwiftUI
import NexClientKit

/// A message the next send will quote (`引用 {author}`).
struct QuoteDraft: Equatable {
    let author: String
    let text: String
    /// `> {author}：{text, whitespace collapsed, first 140 characters}` followed by a blank line.
    var prefix: String {
        let collapsed = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return "> \(author)：\(String(collapsed.prefix(140)))\n\n"
    }
}

/// Return sends, Shift-Return inserts a newline. The "＋" button opens the 添加 / 指令 menu (文件, 权限, 模型, 导出对话); permission and model pickers anchor to it; typing `@` offers the other agents.
struct Composer: View {
    let workspace: WorkspaceStore
    @Bindable var conversation: ConversationStore
    let bot: Bot?
    let onOpenImage: (ChatImagePreview) -> Void
    @Environment(UIState.self) private var ui
    @FocusState private var focused: Bool
    @State private var menuError: String?
    @State private var mentionIndex = 0
    @State private var mentionDismissed = false

    private var agentUI: AgentUI { AgentUI.shared }
    private var botID: String { conversation.botID }
    private var botName: String { bot?.name ?? "Agent" }
    private var quote: QuoteDraft? { agentUI.quotes[botID] }
    private var hasModel: Bool { workspace.state?.config != nil }
    private var canSend: Bool { conversation.canSend && hasModel && bot != nil }
    private var tasks: [AgentTask] { workspace.state?.unfinishedTasks(botID: botID) ?? [] }
    private var showStop: Bool {
        !tasks.isEmpty && conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && conversation.attachments.isEmpty
    }
    @State private var stopping = false

    private func stopAll() {
        guard !stopping else { return }
        stopping = true; menuError = nil
        Task {
            defer { stopping = false }
            for task in tasks where task.status != "cancelling" {
                do { try await workspace.cancelTask(task.id) } catch { menuError = message(of: error) }
            }
        }
    }
    private var height: CGFloat {
        let lines = conversation.draft.split(separator: "\n", omittingEmptySubsequences: false).count
        return min(104, max(22, CGFloat(min(lines, 5)) * 19 + 3))
    }

    /// Other agents whose name contains the text typed after a trailing `@`.
    private var mentions: [Bot] {
        guard !mentionDismissed, let fragment = Self.mentionFragment(conversation.draft) else { return [] }
        return workspace.bots.filter { $0.id != botID && (fragment.isEmpty || $0.name.localizedCaseInsensitiveContains(fragment)) }
    }

    var body: some View {
        VStack(spacing: 8) {
            if let quote { quoteBar(quote) }
            if !mentions.isEmpty { mentionMenu }
            if !conversation.attachments.isEmpty { AttachmentChips(conversation: conversation, onOpenImage: onOpenImage) }
            if let menuError { errorLine(menuError) }
            field
        }
        .onChange(of: ui.composerFocusTick) { focused = true }
        .onChange(of: ui.composerMenu) { old, new in if old != nil, new == nil { focused = true } }
        .onChange(of: conversation.draft) { mentionIndex = 0; mentionDismissed = false }
        .onAppear { focused = true }
    }

    private var field: some View {
        VStack(alignment: .leading, spacing: 8) {
            textInput
            toolbar
        }
        .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 10)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.border))
        .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
    }

    private var textInput: some View {
        ComposerTextEditor(text: $conversation.draft, focused: $focused, onPasteImage: { data, name in
            Task { await conversation.addAttachment(name: name, data: data) }
        }) { key in
            switch key {
            case 125: return moveMention(1) == .handled
            case 126: return moveMention(-1) == .handled
            case 48: return applyMention() == .handled
            case 53:
                guard !mentions.isEmpty else { return false }
                mentionDismissed = true
                return true
            case 36, 76:
                if !mentions.isEmpty { return applyMention() == .handled }
                send()
                return true
            default: return false
            }
        }
            .frame(height: height)
            .overlay(alignment: .topLeading) {
                // TextEditor may not publish marked (IME) text to the binding yet.
                // Hide the overlay throughout editing so it cannot cover composition.
                if conversation.draft.isEmpty && !focused {
                    Text("给 \(botName) 发消息…")
                        .font(.system(size: 14)).foregroundStyle(Theme.muted)
                        .padding(.leading, 5).allowsHitTesting(false)
                }
            }
            .accessibilityLabel("发送给 Agent 的消息")
    }

    /// Bottom row: 添加 (＋) and the round send button. Permission and model live in the ＋ menu only.
    private var toolbar: some View {
        HStack(spacing: 8) {
            Button { toggle(.add) } label: {
                Image(systemName: "plus").font(.system(size: 15, weight: .regular)).foregroundStyle(Theme.muted)
                    .frame(width: 34, height: 34).background(menu == .add ? Theme.border : Theme.secondary, in: Circle()).contentShape(Circle())
            }
            .buttonStyle(.plain).disabled(controlsDisabled)
            .help("添加文件或指令").accessibilityLabel("添加文件或指令")
            .popover(isPresented: anyMenuOpen, arrowEdge: .top) { menuContent }

            Spacer(minLength: 0)
            // While the agent works and nothing is typed, the send key stops it (web composer).
            if showStop {
                Button(action: stopAll) {
                    Image(systemName: "stop.fill").font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Theme.primaryForeground)
                        .frame(width: 34, height: 34)
                        .background(Theme.primary, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(stopping || tasks.allSatisfy { $0.status == "cancelling" })
                .help("停止任务").accessibilityLabel("停止任务")
            } else {
                Button(action: send) {
                    Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold))
                        .foregroundStyle(canSend ? Theme.primaryForeground : .white)
                        .frame(width: 34, height: 34)
                        .background(canSend ? Theme.primary : Color(hex: 0x9A9A9E), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canSend).help("发送 (Return)").accessibilityLabel("发送消息")
            }
        }
    }

    // MARK: Menus

    private var mode: ApprovalMode { bot?.approvalMode ?? .standard }
    private var full: Bool { mode == .full }
    private var menu: ComposerMenuKind? { ui.composerMenu }
    private var controlsDisabled: Bool { conversation.isSending || workspace.connection != .connected || bot == nil }

    /// One popover anchored to ＋ shows whichever menu is open (添加与指令, 权限, 模型).
    private var anyMenuOpen: Binding<Bool> {
        Binding(get: { ui.composerMenu != nil }, set: { if !$0 { ui.composerMenu = nil } })
    }
    private func toggle(_ kind: ComposerMenuKind) { ui.composerMenu = ui.composerMenu == kind ? nil : kind }
    @ViewBuilder private var menuContent: some View {
        switch menu {
        case .add: addMenu
        case .permissions: permissionMenu
        case .models: modelMenu
        case nil: EmptyView()
        }
    }
    private var config: ModelConfig? { workspace.state?.config }
    private var defaultModel: String { config?.defaultModel ?? "" }
    /// The assistant's own model; empty while it follows the default.
    private var chatModel: String { bot?.selectedModel ?? "" }
    private func close() { ui.composerMenu = nil; focused = true }

    private var addMenu: some View {
        ComposerMenu(label: "添加与指令", entries: [
            .heading("添加"),
            .row(.init(id: "file", icon: "paperclip", title: "文件", key: "file", enabled: !conversation.isUploadingAttachments, action: { close(); chooseFiles() })),
            .heading("指令"),
            .row(.init(id: "permission", icon: full ? "exclamationmark.shield" : "checkmark.shield", title: "权限", key: "permission", value: mode.title,
                       action: { ui.composerMenu = .permissions })),
            .row(.init(id: "model", icon: "slider.horizontal.3", title: "模型", key: "model", value: chatModel.isEmpty ? defaultModel : chatModel,
                       enabled: config != nil, action: { ui.composerMenu = .models })),
            .row(.init(id: "export", icon: "arrow.down.to.line", title: "导出对话", key: "export", value: "Markdown",
                       enabled: !conversation.messages.isEmpty, action: { close(); exportConversation() })),
        ], initialID: "file", width: 340, close: close)
    }

    private var permissionMenu: some View {
        ComposerMenu(label: "选择操作权限", entries: ApprovalMode.allCases.map { option in
            .row(.init(id: option.rawValue, icon: option == .full ? "exclamationmark.shield" : "checkmark.shield", title: option.title,
                       checked: mode == option, radio: true, action: { close(); setMode(option) }))
        }, initialID: mode.rawValue, width: 216, close: close)
    }

    private var modelMenu: some View {
        ModelPickerPopover(label: "选择聊天模型", value: chatModel, emptyLabel: "默认 · \(defaultModel)",
                           models: workspace.state?.modelVisibility.models, source: workspace.savedModelSource(),
                           onSelect: { setModel($0) }, close: close)
    }

    private func setModel(_ next: String) {
        close()
        guard next != chatModel else { return }
        menuError = nil
        Task {
            do { try await workspace.setAgentModel(botID: botID, model: next) }
            catch { menuError = message(of: error) }
        }
    }

    private func setMode(_ next: ApprovalMode) {
        guard next != mode else { return }
        menuError = nil
        Task {
            do { try await workspace.setApprovalMode(botID: botID, mode: next) }
            catch { menuError = message(of: error) }
        }
    }

    private func chooseFiles() {
        FilePanels.pickFiles { urls in Task { await conversation.addFiles(urls) } }
    }

    private func exportConversation() {
        menuError = nil
        Task {
            do {
                let result = try await workspace.exportMarkdown(botID: botID)
                _ = try FilePanels.save(Data(result.content.utf8), suggested: result.filename)
            } catch { menuError = message(of: error) }
        }
    }

    // MARK: Quote and mention

    private func quoteBar(_ quote: QuoteDraft) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("引用 \(quote.author)").font(.system(size: 11, weight: .semibold))
                Text(quote.text).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(2)
            }
            Spacer(minLength: 0)
            Button { agentUI.quotes[botID] = nil } label: {
                Image(systemName: "xmark").font(.system(size: 10)).frame(width: 24, height: 24).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("取消引用").accessibilityLabel("取消引用")
        }
        .padding(.horizontal, 14).padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(alignment: .leading) { Rectangle().fill(Theme.brand).frame(width: 3).padding(.vertical, 6) }
    }

    private func errorLine(_ text: String) -> some View {
        Label(text, systemImage: "exclamationmark.triangle.fill")
            .font(.system(size: 12)).foregroundStyle(Theme.danger).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var mentionMenu: some View {
        let list = mentions
        return VStack(spacing: 2) {
            ForEach(Array(list.enumerated()), id: \.element.id) { index, peer in
                Button { insertMention(peer) } label: {
                    HStack(spacing: 10) {
                        AgentAvatar(appearance: workspace.appearance(peer), size: 28)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("@\(peer.name)").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.foreground)
                            Text(peer.instructions.isEmpty ? "同伴 Agent" : peer.instructions).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6).frame(maxWidth: .infinity, alignment: .leading)
                    .background(index == min(mentionIndex, list.count - 1) ? Theme.secondary : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(6)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.border))
        .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
        .accessibilityLabel("提及同伴 Agent")
    }

    /// The text after a trailing `@` that starts the draft or follows whitespace (`/(?:^|\s)@([^\s@]*)$/`).
    static func mentionFragment(_ draft: String) -> String? {
        guard let match = draft.firstMatch(of: /(?:^|\s)@([^\s@]*)$/) else { return nil }
        return String(match.1)
    }

    private func moveMention(_ delta: Int) -> KeyPress.Result {
        let list = mentions
        guard !list.isEmpty else { return .ignored }
        mentionIndex = (min(mentionIndex, list.count - 1) + delta + list.count) % list.count
        return .handled
    }

    private func applyMention() -> KeyPress.Result {
        let list = mentions
        guard !list.isEmpty else { return .ignored }
        insertMention(list[min(mentionIndex, list.count - 1)])
        return .handled
    }

    private func insertMention(_ peer: Bot) {
        guard let fragment = Self.mentionFragment(conversation.draft) else { return }
        conversation.draft = String(conversation.draft.dropLast(fragment.count + 1)) + "@\(peer.name) "
        focused = true
    }

    // MARK: Send

    private func send() {
        guard canSend else { return }
        let quoted = quote
        Task {
            if let quoted {
                let text = quoted.prefix + conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines)
                let sent = conversation.draft
                if await conversation.send(text: text) {
                    if conversation.draft == sent { conversation.draft = "" }
                    agentUI.quotes[botID] = nil
                }
            } else {
                await conversation.send()
            }
        }
    }
}

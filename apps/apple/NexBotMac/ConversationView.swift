import SwiftUI
import AppKit
import NexClientKit

/// Port of the web `senderLabel`: 我 / 系统 / peer name or 同伴 Agent / bot name or Agent.
@MainActor func senderLabel(_ message: AgentMessage, bot: Bot?, workspace: WorkspaceStore) -> String {
    switch message.role {
    case "user": return "我"
    case "system": return "系统"
    case "peer": return (message.a2aPeerID ?? message.senderBotID).flatMap { workspace.bot($0)?.name } ?? "同伴 Agent"
    default: return bot?.name ?? "Agent"
    }
}

struct ConversationView: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(UIState.self) private var ui
    @Environment(ContactPreferences.self) private var preferences
    @Environment(\.controlActiveState) private var activeState
    @Environment(\.scenePhase) private var scenePhase
    @State private var modelChooserOpen = false
    @State private var exported = false
    @State private var dropTargeted = false
    @State private var memoryBaseline: [String: String]?
    @State private var memoryNotice = ""
    @State private var imagePreview: ChatImagePreview?

    private var dropHighlight: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.brand, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
            .background(Theme.brand.opacity(0.05)).padding(8).allowsHitTesting(false)
            .overlay { Label("松开以添加文件", systemImage: "paperclip").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.brand) }
    }

    private var conversation: ConversationStore { workspace.conversation(for: botID) }
    private var bot: Bot? { workspace.bot(botID) }
    private var isActive: Bool { activeState == .key && scenePhase == .active }
    private var pendingApprovals: [Approval] { workspace.approvals.filter { $0.botID == botID } }
    private var tasks: [AgentTask] { workspace.state?.unfinishedTasks(botID: botID) ?? [] }

    /// `version:updated_at` of every memory this agent can see; a change makes the 已更新记忆 pill appear.
    private var memorySignatures: [String: String] {
        Dictionary((workspace.state?.memories(botID: botID) ?? []).map { ($0.id, "\($0.version):\($0.row.string("updated_at") ?? "")") }, uniquingKeysWith: { a, _ in a })
    }

    var body: some View {
        let conv = conversation
        VStack(spacing: 0) {
            header
            if workspace.state != nil && workspace.state?.config == nil { noModelBanner }
            MessageList(workspace: workspace, conversation: conv, bot: bot, onOpenImage: { imagePreview = $0 })
            VStack(spacing: 10) {
                ForEach(pendingApprovals) { ApprovalCard(workspace: workspace, approval: $0) }
                ForEach(workspace.state?.peersAwaitingApproval(for: botID) ?? [], id: \.self) { peerID in waitingLine(peerID) }
                if !tasks.isEmpty || conv.isSending { statusLine(conv) }
                Composer(workspace: workspace, conversation: conv, bot: bot, onOpenImage: { imagePreview = $0 })
            }
            .frame(maxWidth: Theme.readingWidth)
            .padding(.horizontal, 10).padding(.top, 4).padding(.bottom, 14)
            .frame(maxWidth: .infinity)
        }
        .overlay { if dropTargeted { dropHighlight } }
        .overlay { if let imagePreview { ChatImageViewer(preview: imagePreview) { self.imagePreview = nil } } }
        .dropDestination(for: URL.self) { urls, _ in
            guard bot != nil, !conv.isSending, workspace.connection == .connected else { return false }
            Task { await conv.addFiles(urls.filter(\.isFileURL)) }
            return true
        } isTargeted: { dropTargeted = $0 }
        // Read receipts: only while this chat is visible and the window is key.
        .onChange(of: isActive, initial: true) { conv.isActive = isActive }
        .onChange(of: conv.messages.last?.seq) { Task { await conv.markReadIfNeeded() } }
        .onChange(of: memorySignatures, initial: true) { _, new in trackMemory(new) }
        .onDisappear { conv.isActive = false }
    }

    private func trackMemory(_ new: [String: String]) {
        guard let baseline = memoryBaseline else {
            if workspace.state != nil { memoryBaseline = new }
            return
        }
        if let changed = (workspace.state?.memories(botID: botID) ?? []).first(where: { baseline[$0.id] != new[$0.id] }) { memoryNotice = changed.title }
        memoryBaseline = new
    }

    // MARK: Header

    /// The floating capsule (avatar, name, status) appears only while the inspector is closed and opens it; round glass buttons sit on the right.
    private var header: some View {
        let state = workspace.companionState(botID)
        let subtitle: String = {
            guard let first = tasks.first else { return state.label }
            let phrase = ToolLabels.taskPhrase(first)
            return tasks.count > 1 ? "\(phrase) · \(tasks.count) 项工作正在进行" : phrase
        }()
        let covered = ui.inspectorVisible
        return ZStack {
            Button { ui.inspectorVisible = true } label: {
                HStack(spacing: 9) {
                    if let bot { AgentAvatar(appearance: workspace.appearance(bot), state: state, size: 30, animated: preferences.motionEnabled) }
                    Text(bot?.name ?? "NexBot").font(.system(size: 13.5, weight: .semibold)).lineLimit(1)
                    Text(subtitle).font(.system(size: 11.5, weight: tasks.isEmpty ? .regular : .medium))
                        .foregroundStyle(tasks.isEmpty ? Theme.muted : Theme.identityAccent).lineLimit(1).frame(maxWidth: 220, alignment: .leading)
                }
                .padding(.leading, 6).padding(.trailing, 16).padding(.vertical, 5)
                .glass(Capsule())
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .help("打开 Agent 资料").accessibilityLabel("\(bot?.name ?? "Agent") 资料")
            .opacity(covered ? 0 : 1).offset(y: covered ? -8 : 0)
            .allowsHitTesting(!covered).accessibilityHidden(covered)
            .animation(.easeOut(duration: 0.25), value: covered)

            HStack(spacing: 8) {
                Spacer(minLength: 0)
                if !memoryNotice.isEmpty {
                    HStack(spacing: 5) {
                        Image(systemName: "sparkles").font(.system(size: 10))
                        Text("已更新记忆：\(memoryNotice)").font(.system(size: 11.5)).lineLimit(1)
                    }
                    .foregroundStyle(Theme.identityAccent).padding(.horizontal, 12).frame(height: 28)
                    .glass(Capsule(), strong: true, lift: .card).frame(maxWidth: 240)
                }
                if !conversation.messages.isEmpty {
                    RoundGlassButton(symbol: exported ? "checkmark" : "square.and.arrow.up", label: "复制对话记录", action: share)
                }
                RoundGlassButton(symbol: "sidebar.right", label: "Agent 资料", selected: ui.inspectorVisible) { ui.inspectorVisible.toggle() }
            }
        }
        .padding(.horizontal, 2).frame(height: 64)
    }

    private func share() {
        guard let text = workspace.exportTranscript(botID: botID) else { return }
        AgentUI.shared.copyToPasteboard(text)
        exported = true
        Task { try? await Task.sleep(for: .seconds(1.8)); exported = false }
    }

    private var noModelBanner: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Text(ToolLabels.noModelBanner).font(.system(size: 12)).foregroundStyle(Theme.foreground)
                Button { modelChooserOpen.toggle() } label: {
                    Text("选择模型").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.primaryForeground)
                        .padding(.horizontal, 10).frame(height: 24)
                        .background(Theme.primary, in: RoundedRectangle(cornerRadius: 7, style: .continuous)).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Spacer()
            }
            if modelChooserOpen {
                ScrollView { SettingsModelPane(workspace: workspace).padding(16) }
                    .frame(maxHeight: 360)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(Theme.approvalSoft, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding(.bottom, 8)
    }

    // MARK: Approval and task lines

    private func waitingLine(_ peerID: String) -> some View {
        HStack(spacing: 8) {
            Circle().fill(Theme.approval).frame(width: 6, height: 6)
            Text("\(workspace.bot(peerID)?.name ?? "同伴") 等待你的批准").font(.system(size: 11)).foregroundStyle(Theme.muted)
            Spacer()
            Button { workspace.select(peerID) } label: {
                Text("前往处理").font(.system(size: 11)).foregroundStyle(Theme.brand).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 4)
    }

    private func statusLine(_ conv: ConversationStore) -> some View {
        // Text only, as on the web: the composer's send key turns into the stop key.
        let stopping = tasks.contains { $0.status == "cancelling" }
        return HStack(spacing: 8) {
            Circle().fill(tasks.first?.status == "awaiting_approval" ? Theme.approval : Theme.success).frame(width: 6, height: 6)
            Text(tasks.isEmpty ? "正在发送…" : stopping ? "正在停止…" : "Agent 正在工作 · \(ToolLabels.taskPhrase(tasks.first))").font(.system(size: 12)).foregroundStyle(Theme.muted)
        }
        .padding(.horizontal, 14).padding(.vertical, 5)
        .glass(Capsule(), lift: .none)
    }
}

// MARK: - No agents

/// The welcome shown when the account has no agent yet.
struct NoAgentsWelcome: View {
    var body: some View {
        VStack(spacing: 14) {
            BrandMark(size: 64)
            Text("创建你的第一个 Agent").font(.system(size: 22, weight: .bold))
            Text("给它一个名字，身份与职责可以之后补充。消息、记忆和工作会持续保留。")
                .font(.system(size: 13)).foregroundStyle(Theme.muted).multilineTextAlignment(.center).frame(maxWidth: 380)
            Button { AgentUI.shared.createAgent() } label: {
                HStack(spacing: 6) {
                    Image(systemName: "plus").font(.system(size: 12, weight: .semibold))
                    Text("创建 Agent").font(.system(size: 13, weight: .semibold))
                }
                .foregroundStyle(Theme.primaryForeground).padding(.horizontal, 18).frame(height: 38)
                .background(Theme.primary, in: RoundedRectangle(cornerRadius: 10, style: .continuous)).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Messages

private struct MessageList: View {
    let workspace: WorkspaceStore
    let conversation: ConversationStore
    let bot: Bot?
    let onOpenImage: (ChatImagePreview) -> Void
    @Environment(UIState.self) private var ui
    @Environment(ContactPreferences.self) private var preferences
    @State private var atBottom = true
    /// False until a freshly loaded transcript has been placed at its end. Until then the
    /// top row must not page in older history: on a cold start the lazy stack first lays
    /// out from the top, and loading older messages there left the view on unmeasured rows.
    @State private var settled = false

    private var botID: String { conversation.botID }
    private var tasks: [AgentTask] { workspace.state?.unfinishedTasks(botID: botID) ?? [] }
    private var processing: Bool {
        workspace.connection == .connected && conversation.streaming.isEmpty
            && (conversation.isSending || tasks.contains { ["queued", "running", "cancelling"].contains($0.status) })
    }

    private var focusedID: String? { conversation.focusedMessageID }

    /// Changes when a search-result view finishes loading, so the target is scrolled to once per opening and not on each poll.
    private var focusKey: String { "\(focusedID ?? "")|\(conversation.isLoaded)" }
    private var loadKey: String { "\(botID)|\(conversation.isLoaded)" }

    private var tailKey: String {
        "\(conversation.messages.last?.seq ?? 0)|\(conversation.streaming.map { $0.text.count }.reduce(0, +))|\(workspace.approvals.count)|\(conversation.activeTask?.id ?? "")|\(processing)"
    }

    /// Centers the searched message. Row heights are estimated until laid out, so the jump is repeated once they are known.
    private func scrollToFocused(_ proxy: ScrollViewProxy) async {
        guard let id = focusedID, conversation.isLoaded else { return }
        for delay in [50, 300] {
            try? await Task.sleep(for: .milliseconds(delay))
            guard !Task.isCancelled, let seq = conversation.messages.first(where: { $0.id == id })?.seq else { return }
            proxy.scrollTo(seq, anchor: .center)
        }
    }

    /// Scrolls to the end once rows exist and again after they are measured, then allows older pages.
    private func settleAtBottom(_ proxy: ScrollViewProxy) async {
        settled = false
        guard conversation.isLoaded else { return }
        if focusedID == nil {
            for delay in [0, 60, 300] {
                try? await Task.sleep(for: .milliseconds(delay))
                guard !Task.isCancelled else { return }
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
        settled = true
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if focusedID != nil {
                        HStack {
                            Spacer()
                            Button("返回最新消息") { workspace.showLatest(botID: botID) }.buttonStyle(.link)
                            Spacer()
                        }
                        .padding(.bottom, 8)
                    } else if conversation.hasOlder {
                        HStack {
                            Spacer()
                            if conversation.isLoadingOlder { ProgressView().controlSize(.small) }
                            else { Button("加载更早的消息") { loadOlder(proxy) }.buttonStyle(.link) }
                            Spacer()
                        }
                        .onAppear { if settled { loadOlder(proxy) } }
                        .id("older")
                    }
                    let messages = conversation.messages
                    ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                        let previous = index > 0 ? messages[index - 1] : nil
                        let next = index + 1 < messages.count ? messages[index + 1] : nil
                        let day = Self.dayLabel(message.createdAt)
                        if let day, day != Self.dayLabel(previous?.createdAt) {
                            DayDivider(label: day)
                        }
                        let joined = MessageGrouping.joins(previous, message)
                        MessageRow(message: message, bot: bot, workspace: workspace, joined: joined,
                                   groupEnd: MessageGrouping.ends(message, next: next), onOpenImage: onOpenImage)
                            .overlay {
                                if message.id == focusedID {
                                    RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.primary, lineWidth: 2)
                                        .padding(-6).allowsHitTesting(false)
                                }
                            }
                            .padding(.top, joined ? 4 : 14)
                            .id(message.seq)
                    }
                    ForEach(conversation.streaming, id: \.taskId) { stream in
                        StreamingReply(workspace: workspace, bot: bot, stream: stream)
                    }
                    if processing {
                        AssistantFrame(workspace: workspace, bot: bot, showAvatar: true, avatarLift: 0) {
                            VStack(alignment: .leading, spacing: 4) {
                                TypingDots().accessibilityLabel("\(bot?.name ?? "Agent") 正在处理消息")
                                    .padding(.horizontal, 16).padding(.vertical, 14)
                                    .cardSurface(Bubble.assistant(tail: true))
                                Text(tasks.isEmpty ? "正在发送…" : ToolLabels.taskPhrase(tasks.first)).font(.system(size: 11)).foregroundStyle(Theme.muted).padding(.leading, 6)
                            }
                        }
                        .padding(.top, 14)
                    }
                    if let error = conversation.sendError {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.system(size: 12)).foregroundStyle(Theme.danger).textSelection(.enabled)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                        .onAppear { atBottom = true }
                        .onDisappear { atBottom = false }
                }
                .frame(maxWidth: Theme.readingWidth)
                .padding(.horizontal, 10).padding(.top, 12).padding(.bottom, 20)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            // The transcript fades out at both edges instead of ending in a hard line.
            .mask {
                VStack(spacing: 0) {
                    LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom).frame(height: 22)
                    Rectangle()
                    LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: 26)
                }
            }
            .overlay {
                if !conversation.isLoaded {
                    VStack(spacing: 10) {
                        ProgressView().controlSize(.large)
                        Text("正在载入历史会话…").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    }
                } else if conversation.messages.isEmpty && conversation.streaming.isEmpty && !processing {
                    welcome
                }
            }
            .overlay(alignment: .bottom) {
                if !atBottom && conversation.messages.count > 3 && focusedID == nil {
                    Button { atBottom = true; withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } } label: {
                        Image(systemName: "arrow.down").font(.system(size: 16, weight: .regular))
                            .foregroundStyle(Theme.foreground).frame(width: 36, height: 36)
                            .glass(Circle(), strong: true, lift: .card).contentShape(Circle())
                    }
                    .buttonStyle(.plain).accessibilityLabel("回到底部").padding(.bottom, 10)
                }
            }
            .onChange(of: tailKey) {
                guard focusedID == nil else { return }
                if atBottom { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: conversation.sendRevision) {
                atBottom = true; proxy.scrollTo("bottom", anchor: .bottom)
            }
            .task(id: loadKey) { await settleAtBottom(proxy) }
            .task(id: focusKey) { await scrollToFocused(proxy) }
        }
        .environment(\.openURL, OpenURLAction { url in
            if let path = ChatLinks.path(from: url) {
                let id = botID, ws = workspace, ui = ui
                Task { @MainActor in AgentUI.shared.previewFile(path, botID: id, workspace: ws, ui: ui) }
                return .handled
            }
            guard Markdown.isOpenable(url) else { return .discarded }
            NSWorkspace.shared.open(url)
            return .handled
        })
    }

    // MARK: Welcome

    private var welcome: some View {
        let peers = workspace.bots.filter { $0.id != botID }
        let instructions = bot?.instructions ?? ""
        return VStack(spacing: 12) {
            if let bot { AgentAvatar(appearance: workspace.appearance(bot), state: workspace.companionState(botID), size: 84, animated: preferences.motionEnabled) }
            Text("长期陪伴，随时开始").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.brand)
                .padding(.horizontal, 12).padding(.vertical, 4).background(Theme.brandSoft, in: Capsule())
            Text(bot?.name ?? "").font(.system(size: 22, weight: .bold))
            Text(instructions.isEmpty ? "我是你的专属智能同伴。你可以直接向我提问、安排定时任务，或输入 @ 让我与团队其他成员协作。" : instructions)
                .font(.system(size: 13)).foregroundStyle(Theme.foreground).multilineTextAlignment(.center).lineLimit(6).frame(maxWidth: 460)
            Text("直接发消息，或为我安排一项例行任务。").font(.system(size: 11)).foregroundStyle(Theme.muted)
            HStack(spacing: 8) {
                chip("clock", "安排例行任务") { AgentUI.shared.editRoutine(botID: botID) }
                chip("sparkles", "添加长期记忆") { AgentUI.shared.editMemory(botID: botID) }
                if let peer = peers.first {
                    chip("at", "让 \(peer.name) 协作") { conversation.draft = "@\(peer.name) "; ui.composerFocusTick += 1 }
                }
            }
            .padding(.top, 4)
        }
        .padding(.bottom, 40)
    }

    private func chip(_ symbol: String, _ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: symbol).font(.system(size: 11))
                Text(title).font(.system(size: 12))
            }
            .foregroundStyle(Theme.foreground).padding(.horizontal, 12).frame(height: 30)
            .background(Theme.card, in: Capsule()).overlay(Capsule().strokeBorder(Theme.border)).contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func loadOlder(_ proxy: ScrollViewProxy) {
        guard conversation.hasOlder, !conversation.isLoadingOlder, let anchor = conversation.messages.first?.seq else { return }
        Task {
            await conversation.loadOlder()
            proxy.scrollTo(anchor, anchor: .top)
        }
    }

    static func dayLabel(_ date: Date?) -> String? {
        date.map { TimeFormat.dayLabel($0) }
    }
}

private struct DayDivider: View {
    let label: String
    var body: some View {
        Text(label).font(.system(size: 11, weight: .medium).monospacedDigit()).foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity).padding(.top, 18).padding(.bottom, 4)
    }
}

/// Layout of an assistant reply: the avatar on the last message of a group (an empty gutter before it) and the body.
private struct AssistantFrame<Content: View>: View {
    let workspace: WorkspaceStore
    let bot: Bot?
    var showAvatar: Bool
    /// Raises the avatar above the time row so it sits beside the bubble.
    var avatarLift: CGFloat = 22
    var state: CompanionState = .idle
    @ViewBuilder let content: () -> Content

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if showAvatar, let bot {
                AgentAvatar(appearance: workspace.appearance(bot), state: state, size: 26).padding(.bottom, avatarLift)
            } else {
                Color.clear.frame(width: 26, height: 1)
            }
            content()
        }
        .padding(.trailing, 34)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MessageRow: View {
    let message: AgentMessage
    let bot: Bot?
    let workspace: WorkspaceStore
    /// Continues the previous reply's group: a small gap and no avatar above it.
    var joined = false
    /// Last message of its group: it carries the avatar and the time.
    var groupEnd = true
    let onOpenImage: (ChatImagePreview) -> Void
    @Environment(UIState.self) private var ui
    @Environment(\.colorScheme) private var scheme
    @State private var hover = false
    @State private var hideActions: Task<Void, Never>?
    @State private var copied = false

    private var peer: Bot? { workspace.bot(message.a2aPeerID ?? message.senderBotID ?? "") }
    private var botID: String { bot?.id ?? "" }
    private var accentHex: UInt32 { bot.map { workspace.appearance($0).accentHex } ?? Theme.defaultAccent }
    private var actionsVisible: Bool { hover || copied || AgentUI.shared.alwaysShowActions }

    var body: some View {
        if let direction = message.a2aDirection, ["sent", "returned", "received"].contains(direction) {
            marker(direction)
        } else if message.a2aDirection == "replied", message.role == "assistant" {
            repliedCard
        } else if message.role == "system" {
            Text(message.content).font(.system(size: 12)).foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity).textSelection(.enabled)
        } else if message.isFromUser {
            userRow
        } else if message.role == "assistant" {
            AssistantFrame(workspace: workspace, bot: bot, showAvatar: groupEnd) { assistantBody }
                .contentShape(Rectangle())
                .onHover(perform: updateHover)
                .onDisappear { hideActions?.cancel() }
        } else {
            assistantBody
                .padding(.leading, 34).padding(.trailing, 34)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .onHover(perform: updateHover)
                .onDisappear { hideActions?.cancel() }
        }
    }

    // MARK: User

    private var userRow: some View {
        let parsed = AttachmentLink.parse(message.content)
        let images = parsed.links.filter(\.isImage), files = parsed.links.filter { !$0.isImage }
        return VStack(alignment: .trailing, spacing: 6) {
            if !images.isEmpty {
                VStack(alignment: .trailing, spacing: 8) {
                    ForEach(images) { link in
                        AttachmentThumbnail(link: link, conversation: workspace.conversation(for: botID), messageID: message.id, onOpen: onOpenImage)
                    }
                }
            }
            if !parsed.body.isEmpty {
                ChatMarkdown(source: parsed.body, hug: true)
                    .environment(\.chatInk, .white).environment(\.chatOnAccent, true)
                    .padding(.horizontal, 16).padding(.vertical, 9)
                    .background(userBubbleGradient(accentHex: accentHex, dark: scheme == .dark), in: Bubble.user)
                    .shadow(color: Color(hex: accentHex).opacity(0.26), radius: 9, y: 6)
            }
            ForEach(files) { link in
                AttachmentCard(link: link, conversation: workspace.conversation(for: botID))
            }
            meta
        }
        .padding(.leading, 56)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .contentShape(Rectangle())
        .onHover(perform: updateHover)
        .onDisappear { hideActions?.cancel() }
    }

    // MARK: Assistant and peer

    private var assistantBody: some View {
        VStack(alignment: .leading, spacing: 4) {
            if message.role == "peer" {
                HStack(spacing: 6) {
                    if let peer { AgentAvatar(appearance: workspace.appearance(peer), size: 22) }
                    Text("\(peer?.name ?? "Agent") · \(message.kind == "request" ? "发来任务" : "返回结果")").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Theme.muted)
                }
                .padding(.leading, 4)
            }
            if !message.toolSteps.isEmpty {
                ToolSteps(steps: message.toolSteps) { step in
                    AgentUI.shared.previewStep(step, botID: botID, workspace: workspace, ui: ui)
                }
            }
            if !message.content.isEmpty {
                if message.kind == "error" {
                    Text(message.content).font(.system(size: 14)).foregroundStyle(Theme.danger).textSelection(.enabled)
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .cardSurface(Bubble.assistant(tail: groupEnd))
                } else {
                    let images = AttachmentLink.embeddedImages(message.content)
                    let body = AttachmentLink.stripped(message.content)
                    if !images.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(images) { link in
                                AttachmentThumbnail(link: link, conversation: workspace.conversation(for: botID), messageID: message.id, onOpen: onOpenImage)
                            }
                        }
                    }
                    if !body.isEmpty { replyCard(body) }
                }
            }
            if message.role != "assistant" || groupEnd { meta }
        }
        .overlay(alignment: .bottomTrailing) {
            if message.role == "assistant" && !groupEnd && canAct {
                actions.padding(.horizontal, 8).padding(.vertical, 2)
                    .glass(Capsule(), strong: true, lift: .card)
                    .offset(y: 8).padding(.trailing, 8)
                    .opacity(actionsVisible ? 1 : 0).allowsHitTesting(actionsVisible)
            }
        }
    }

    /// A long reply (headings, or many lines) becomes a document card; anything else a card bubble.
    @ViewBuilder private func replyCard(_ body: String) -> some View {
        if message.role == "assistant", ReplyLayout.of(body).document {
            DocumentCard(outline: ReplyLayout.outline(body), tail: groupEnd) { ChatMarkdown(source: body) }
        } else {
            ChatMarkdown(source: body, hug: true)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .cardSurface(Bubble.assistant(tail: groupEnd && message.role == "assistant"))
                .overlay { if message.role == "peer" { Bubble.assistant(tail: false).strokeBorder(Theme.border) } }
        }
    }

    private func updateHover(_ inside: Bool) {
        hideActions?.cancel()
        if inside { hover = true; return }
        hideActions = Task { @MainActor in
            do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
            hover = false
        }
    }

    private var canAct: Bool { ["user", "assistant", "peer"].contains(message.role) }

    private var actions: some View {
        HStack(spacing: 10) {
            Button(action: quote) {
                HStack(spacing: 3) { Image(systemName: "arrowshape.turn.up.left").font(.system(size: 9)); Text("引用") }.contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("引用回复")
            Button(action: copy) {
                HStack(spacing: 3) {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.system(size: 9))
                    Text(copied ? "已复制" : "复制")
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("复制内容")
        }
        .font(.system(size: 11)).foregroundStyle(Theme.muted)
    }

    /// Short time plus the hover actions 引用 and 复制.
    private var meta: some View {
        HStack(spacing: 10) {
            if let at = message.createdAt { Text(TimeFormat.formatShortTime(at)).font(.system(size: 10.5).monospacedDigit()).help(TimeFormat.formatTime(at)) }
            if canAct { actions.opacity(actionsVisible ? 1 : 0) }
        }
        .font(.system(size: 10.5)).foregroundStyle(Theme.muted)
        .padding(.horizontal, 4).frame(minHeight: 18)
    }

    private func quote() {
        AgentUI.shared.quotes[botID] = QuoteDraft(author: senderLabel(message, bot: bot, workspace: workspace), text: message.content)
        ui.composerFocusTick += 1
    }

    private func copy() {
        AgentUI.shared.copyToPasteboard(message.content)
        copied = true
        Task { try? await Task.sleep(for: .seconds(1.8)); copied = false }
    }

    // MARK: A2A

    private func marker(_ direction: String) -> some View {
        HStack(spacing: 8) {
            Text(direction == "received" ? "消息来自" : "已发消息给").font(.system(size: 12)).foregroundStyle(Theme.muted)
            Button { if let peer { workspace.select(peer.id) } } label: {
                HStack(spacing: 6) {
                    if let peer { AgentAvatar(appearance: workspace.appearance(peer), size: 20) }
                    Text(peer?.name ?? "Agent").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground)
                }
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Theme.wash, in: Capsule()).contentShape(Capsule())
            }
            .buttonStyle(.plain).disabled(peer == nil).accessibilityLabel("打开 \(peer?.name ?? "Agent") 的消息")
            if let at = message.createdAt {
                Text(TimeFormat.formatTime(at)).font(.system(size: 10)).foregroundStyle(Theme.muted)
                    .help(at.formatted(date: .numeric, time: .standard))
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var repliedCard: some View {
        AssistantFrame(workspace: workspace, bot: bot, showAvatar: true) {
            VStack(alignment: .leading, spacing: 4) {
                Text(bot?.name ?? "Agent").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Theme.muted).padding(.leading, 4)
                FoldedReply(content: message.content, recipient: peer?.name ?? "Agent", pending: false)
                if let at = message.createdAt { Text(TimeFormat.formatTime(at)).font(.system(size: 10.5)).foregroundStyle(Theme.muted).padding(.horizontal, 4) }
            }
        }
    }
}

/// "已回复给{peer} · 展开" folded block of an agent-to-agent reply.
private struct FoldedReply: View {
    let content: String
    let recipient: String
    let pending: Bool
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { open.toggle() } label: {
                HStack(spacing: 6) {
                    Text("\(pending ? "正在回复给" : "已回复给")\(recipient)").font(.system(size: 12, weight: .medium))
                    Text("·")
                    Text(open ? "收起" : "展开")
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).rotationEffect(.degrees(open ? 180 : 0))
                }
                .font(.system(size: 12)).foregroundStyle(Theme.foreground).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open { ChatMarkdown(source: content, pending: pending) }
        }
        .padding(.horizontal, 14).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct StreamingReply: View {
    let workspace: WorkspaceStore
    let bot: Bot?
    let stream: NexClientKit.StreamingText

    var body: some View {
        let link = workspace.state?.delegations.first { $0.childTaskID == stream.taskId }
        let peer = link.flatMap { workspace.bot($0.senderBotID) }
        Group {
            if link != nil {
                AssistantFrame(workspace: workspace, bot: bot, showAvatar: true, avatarLift: 0, state: bot.map { workspace.companionState($0.id) } ?? .idle) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(bot?.name ?? "Agent").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Theme.muted).padding(.leading, 4)
                        FoldedReply(content: stream.text, recipient: peer?.name ?? "Agent", pending: true)
                    }
                }
            } else {
                AssistantFrame(workspace: workspace, bot: bot, showAvatar: true, state: bot.map { workspace.companionState($0.id) } ?? .idle) {
                    VStack(alignment: .leading, spacing: 4) {
                        ChatMarkdown(source: stream.text, hug: true, pending: true)
                            .padding(.horizontal, 16).padding(.vertical, 10)
                            .cardSurface(Bubble.assistant(tail: true))
                        HStack(spacing: 8) {
                            Text("正在回复…").font(.system(size: 11)).foregroundStyle(Theme.muted)
                            TypingDots()
                        }
                        .padding(.horizontal, 6)
                    }
                }
            }
        }
        .padding(.top, 14)
        .accessibilityIdentifier("streaming-bubble")
    }
}

/// Subtle three-dot typing indicator.
private struct TypingDots: View {
    var body: some View {
        TimelineView(.animation(minimumInterval: 0.2)) { context in
            let phase = Int(context.date.timeIntervalSinceReferenceDate / 0.35) % 3
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { i in
                    Circle().fill(Theme.muted).frame(width: 5, height: 5).opacity(i == phase ? 1 : 0.35)
                }
            }
        }
    }
}

/// The tool-activity capsule (icons, `N 项操作`, red `· M 项失败`), expanding to the individual steps. A step opens its record in the inspector.
private struct ToolSteps: View {
    let steps: [ToolStep]
    let open: (ToolStep) -> Void
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.easeOut(duration: 0.18)) { expanded.toggle() } } label: {
                ToolCapsuleLabel(summary: ToolActivity.summary(steps), expanded: expanded)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isButton)
            if expanded {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(steps) { step in
                        Button { open(step) } label: {
                            HStack(spacing: 8) {
                                Circle().fill(color(step.status)).frame(width: 6, height: 6)
                                Text(step.label).font(.system(size: 12, weight: .medium))
                                if !step.summary.isEmpty {
                                    Text(step.summary).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted).lineLimit(1)
                                }
                                Spacer(minLength: 4)
                                Text(ToolLabels.statusText(step.status)).font(.system(size: 11))
                                    .foregroundStyle(["failed", "rejected", "cancelled"].contains(step.status) ? Theme.danger : Theme.muted)
                            }
                            .foregroundStyle(Theme.foreground).padding(.vertical, 5).padding(.horizontal, 4).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).help("点击在右侧面板查看详情")
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
                .frame(maxWidth: 560, alignment: .leading)
                .cardSurface(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .transition(.opacity)
            }
        }
    }

    private func color(_ status: String) -> Color {
        switch status {
        case "succeeded": Theme.success
        case "failed", "rejected", "cancelled": Theme.danger
        case "running", "pending", "awaiting_approval": Theme.approval
        default: Theme.muted
        }
    }
}

fileprivate extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

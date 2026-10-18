import SwiftUI
import NexClientKit

struct ChatView: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(\.scenePhase) private var scenePhase
    @Environment(Navigation.self) private var nav
    @State private var errorText: String?
    @State private var quote: QuoteDraft?
    @State private var showRoutine = false
    @State private var composerMenu: ComposerMenu?
    @State private var showMemory = false
    @State private var atBottom = true
    @State private var knownMemories: [String: String]?
    @State private var memoryNotice: String?
    private let bottomID = "bottom"

    /// The search hit being viewed; the window around it replaces the latest messages.
    private var focusedID: String? { conversation.focusedMessageID }
    /// Changes when a search-result view finishes loading, so the target is scrolled to once per opening and not on each poll.
    private var focusKey: String { "\(focusedID ?? "")|\(conversation.isLoaded)" }

    private var conversation: ConversationStore { workspace.conversation(for: botID) }
    private var bot: Bot? { workspace.bot(botID) }
    private var approvals: [Approval] { workspace.approvals.filter { $0.botID == botID } }
    private var tasks: [AgentTask] { workspace.state?.unfinishedTasks(botID: botID) ?? [] }
    private var hasModel: Bool { workspace.state?.config != nil }
    private var modelName: String { workspace.bot(botID)?.selectedModel ?? workspace.state?.config?.defaultModel.nonEmpty ?? "未连接模型" }
    private var firstPeer: Bot? { workspace.bots.first { $0.id != botID } }
    private var memorySignature: [String: String] {
        Dictionary(uniqueKeysWithValues: (workspace.state?.memories(botID: botID) ?? []).map { ($0.id, "\($0.version):\($0.updatedAt?.timeIntervalSince1970 ?? 0)") })
    }

    var body: some View {
        let conv = conversation
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if focusedID != nil {
                        Button { workspace.showLatest(botID: botID) } label: {
                            Text("返回最新消息").font(.footnote.weight(.medium)).foregroundStyle(Theme.brand)
                                .frame(maxWidth: .infinity).padding(.vertical, 6)
                        }
                        .buttonStyle(.plain)
                    } else if conv.hasOlder {
                        Button { Task { await loadOlder(conv, proxy) } } label: {
                            HStack(spacing: 6) {
                                if conv.isLoadingOlder { ProgressView().controlSize(.small) }
                                Text("加载更早的消息").font(.footnote.weight(.medium))
                            }
                            .foregroundStyle(Theme.muted).frame(maxWidth: .infinity).padding(.vertical, 6)
                        }
                        .buttonStyle(.plain).disabled(conv.isLoadingOlder).id("older")
                    }
                    ForEach(Array(conv.messages.enumerated()), id: \.element.id) { index, message in
                        if let date = message.createdAt,
                           index == 0 || !Calendar.current.isDate(date, inSameDayAs: conv.messages[index - 1].createdAt ?? .distantPast) {
                            DateDivider(date: date)
                        }
                        MessageRow(message: message, workspace: workspace, botName: bot?.name ?? "Agent",
                                   onQuote: { author, text in quote = QuoteDraft(author: author, text: text) },
                                   onOpenStep: { step in Task { await openStep(step) } },
                                   onOpenPeer: { nav.openChat($0) })
                            .overlay {
                                if message.id == focusedID {
                                    RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.primary, lineWidth: 2)
                                        .padding(-6).allowsHitTesting(false)
                                }
                            }
                            .id(message.id)
                    }
                    if conv.isLoaded && conv.messages.isEmpty && conv.streaming.isEmpty { welcome }
                    ForEach(conv.streaming, id: \.taskId) { part in
                        StreamingRow(text: part.text, replyingTo: replyingTo(taskID: part.taskId))
                    }
                    if !tasks.isEmpty && conv.streaming.isEmpty && approvals.isEmpty {
                        ThinkingIndicator(name: bot?.name ?? "Agent", phrase: tasks[0].phrase)
                    }
                    ForEach(approvals) { approval in
                        ApprovalCard(approval: approval, botName: bot?.name ?? "") { allow in await decide(approval, allow: allow) }
                    }
                    ForEach(delegatedPeers, id: \.self) { peerID in delegatedLine(peerID) }
                    Color.clear.frame(height: 1).id(bottomID)
                        .onAppear { atBottom = true }
                        .onDisappear { atBottom = false }
                }
                .padding(.horizontal, 16).padding(.vertical, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .overlay {
                if composerMenu != nil { Color.black.opacity(0.001).onTapGesture { composerMenu = nil } }
            }
            .overlay {
                if !conv.isLoaded {
                    VStack(spacing: 8) {
                        ProgressView()
                        Text("正在载入历史会话…").font(.footnote).foregroundStyle(Theme.muted)
                    }
                }
            }
            .overlay(alignment: .bottom) {
                if !atBottom && conv.messages.count > 3 && focusedID == nil {
                    Button { scrollToBottom(proxy) } label: {
                        Label("回到底部", systemImage: "arrow.down").font(.footnote.weight(.medium))
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(Theme.card, in: Capsule()).overlay(Capsule().stroke(Theme.border))
                            .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.foreground).padding(.bottom, 10)
                    .transition(.opacity)
                }
            }
            .onChange(of: conv.messages.last?.seq) { if focusedID == nil { scrollToBottom(proxy) } }
            .onChange(of: conv.streaming) { if focusedID == nil { scrollToBottom(proxy) } }
            .onChange(of: approvals.count) { if focusedID == nil { scrollToBottom(proxy) } }
            .task(id: focusKey) { await scrollToFocused(proxy) }
            .debugCommand { command, arg in
                switch command {
                case "scroll": if arg == "top", let first = conv.messages.first { proxy.scrollTo(conv.hasOlder ? "older" : first.id, anchor: .top) } else { scrollToBottom(proxy) }
                case "loadolder": Task { await loadOlder(conv, proxy) }
                case "latest": workspace.showLatest(botID: botID)
                default: break
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                if let notice = workspace.notice { NoticeBanner(text: notice) }
                if workspace.state != nil && !hasModel { noModelBanner }
                if let title = memoryNotice { memoryPill(title) }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ComposerView(workspace: workspace, botID: botID, conversation: conv, botName: bot?.name ?? "Agent", quote: $quote, menu: $composerMenu)
        }
        .environment(\.openURL, OpenURLAction { url in
            if url.scheme == ChatMarkdown.fileScheme {
                if let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "path" })?.value {
                    Task { await openFile(path) }
                }
                return .handled
            }
            return Markdown.isOpenable(url) ? .systemAction : .discarded
        })
        .background(Theme.background)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let transcript = workspace.exportTranscript(botID: botID) {
                    ShareLink(item: transcript) { Image(systemName: "square.and.arrow.up") }
                        .accessibilityLabel("复制对话记录")
                }
                Button { nav.openAgentDetail(botID) } label: { Image(systemName: "info.circle") }
                    .accessibilityLabel("助手详情")
            }
            ToolbarItem(placement: .principal) { titleView }
        }
        .errorAlert($errorText)
        .sheet(isPresented: $showRoutine) { RoutineEditorSheet(workspace: workspace, botID: botID) }
        .sheet(isPresented: $showMemory) { MemoryEditorSheet(workspace: workspace, botID: botID) }
        .onAppear {
            workspace.select(botID)
            conv.isActive = scenePhase == .active
            if knownMemories == nil && workspace.state != nil { knownMemories = memorySignature }
        }
        .onDisappear {
            conv.isActive = false
            if workspace.selectedBotID == botID { workspace.select(nil) }
        }
        .onChange(of: scenePhase) { conv.isActive = scenePhase == .active }
        .onChange(of: conv.messages.last?.seq) { Task { await conv.markReadIfNeeded() } }
        .onChange(of: memorySignature) { _, signature in
            guard workspace.state != nil else { return }
            if let known = knownMemories,
               let changed = workspace.state?.memories(botID: botID).first(where: { known[$0.id] != signature[$0.id] }) {
                memoryNotice = "已更新记忆：\(changed.title)"
            }
            knownMemories = signature
        }
        .debugCommand { command, arg in
            switch command {
            case "quote": if let m = conv.messages.last(where: { ["assistant", "user", "peer"].contains($0.role) && !$0.content.isEmpty }) {
                quote = QuoteDraft(author: m.role == "user" ? "我" : (bot?.name ?? "Agent"), text: m.content)
            }
            case "filechip": Task { await openFile(arg) }
            case "toolstep": if let step = conv.messages.reversed().compactMap({ $0.toolSteps.last }).first { Task { await openStep(step) } }
            case "chatroutine": showRoutine = true
            case "chatmemory": showMemory = true
            default: break
            }
        }
    }

    /// Centers the searched message. Row heights are estimated until laid out, so the jump is repeated once they are known.
    private func scrollToFocused(_ proxy: ScrollViewProxy) async {
        guard let id = focusedID, conversation.isLoaded else { return }
        for delay in [50, 300] {
            try? await Task.sleep(for: .milliseconds(delay))
            guard !Task.isCancelled, conversation.messages.contains(where: { $0.id == id }) else { return }
            proxy.scrollTo(id, anchor: .center)
        }
    }

    // MARK: Header

    private var subtitle: String {
        guard let first = tasks.first else { return workspace.companionState(of: botID).label }
        return tasks.count > 1 ? "\(first.phrase) · \(tasks.count) 项工作正在进行" : first.phrase
    }

    private var titleView: some View {
        Button { nav.openAgentDetail(botID) } label: {
            HStack(spacing: 8) {
                if let bot { workspace.avatar(of: bot, size: 28, animated: true) }
                VStack(alignment: .leading, spacing: 0) {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 6) { nameText; modelPill }
                        nameText
                    }
                    Text(subtitle).font(.caption2).foregroundStyle(Theme.muted).lineLimit(1)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(bot?.name ?? "Agent") 助手详情")
    }

    private var nameText: some View { Text(bot?.name ?? "会话").font(.subheadline.weight(.semibold)).lineLimit(1) }

    private var modelPill: some View {
        Text(modelName).font(.system(size: 10, weight: .medium)).foregroundStyle(Theme.muted).lineLimit(1).fixedSize()
            .padding(.horizontal, 6).padding(.vertical, 1).background(Theme.secondary, in: Capsule())
    }

    // MARK: Banners

    private var noModelBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.circle").foregroundStyle(Theme.approval)
            Text(ToolLabels.noModelBanner).font(.footnote).lineLimit(2)
            Spacer(minLength: 4)
            Button("配置 API Key") { nav.openSettings(.model) }.buttonStyle(PillButtonStyle(primary: true))
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .frame(maxWidth: .infinity).background(Theme.approvalSoft)
    }

    private func memoryPill(_ title: String) -> some View {
        Button { memoryNotice = nil } label: {
            Label(title, systemImage: "sparkles").font(.footnote.weight(.medium)).lineLimit(1)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(Theme.brandSoft, in: Capsule())
        }
        .buttonStyle(.plain).foregroundStyle(Theme.brand)
        .accessibilityHint("点按关闭")
        .frame(maxWidth: .infinity).padding(.vertical, 6).background(Theme.background)
    }

    // MARK: Transcript parts

    private var welcome: some View {
        VStack(spacing: 10) {
            if let bot { workspace.avatar(of: bot, size: 88, animated: true) }
            Text("长期陪伴，随时开始").font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
                .padding(.horizontal, 10).padding(.vertical, 3).background(Theme.secondary, in: Capsule())
            Text(bot?.name ?? "").font(.title3.weight(.bold))
            Text(bot?.instructions.nonEmpty ?? "我是你的专属智能同伴。你可以直接向我提问、安排定时任务，或输入 @ 让我与团队其他成员协作。")
                .font(.subheadline).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            Text("直接发消息，或为我安排一项例行任务。").font(.footnote).foregroundStyle(Theme.muted)
            FlowLayout(spacing: 8) {
                Chip(title: "安排例行任务", icon: "clock") { showRoutine = true }
                Chip(title: "添加长期记忆", icon: "sparkles") { showMemory = true }
                if let peer = firstPeer {
                    Chip(title: "让 \(peer.name) 协作", icon: "person.2") { conversation.draft = "@\(peer.name) " }
                }
            }
            .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 28).padding(.horizontal, 12)
    }

    /// Peers whose work reachable from this agent's tasks waits for approval.
    private var delegatedPeers: [String] { workspace.state?.peersAwaitingApproval(for: botID) ?? [] }

    private func delegatedLine(_ peerID: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "hourglass").foregroundStyle(Theme.approval)
            Text("\(workspace.bot(peerID)?.name ?? "同伴") 等待你的批准").font(.footnote)
            Spacer()
            Button("前往处理") { nav.openChat(peerID) }.buttonStyle(PillButtonStyle())
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading).cardStyle(radius: 12, stroke: Theme.approval.opacity(0.5))
    }

    /// The peer an agent-to-agent child task replies to (the delegation's sender), if the task is one.
    private func replyingTo(taskID: String) -> String? {
        guard let d = workspace.state?.delegations.first(where: { $0.childTaskID == taskID && $0.receiverBotID == botID }) else { return nil }
        return workspace.bot(d.senderBotID)?.name ?? "同伴 Agent"
    }

    // MARK: Actions

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomID, anchor: .bottom) }
    }

    private func loadOlder(_ conv: ConversationStore, _ proxy: ScrollViewProxy) async {
        let anchor = conv.messages.first?.id
        await conv.loadOlder()
        if let anchor { proxy.scrollTo(anchor, anchor: .top) }
    }

    private func decide(_ approval: Approval, allow: Bool) async {
        do { try await workspace.decide(approval, allow: allow) } catch { errorText = message(of: error) }
    }

    /// Opens a file chip's preview in the detail 工作 tab.
    private func openFile(_ path: String) async {
        do { show(try await workspace.previewFile(path: path)) } catch { errorText = message(of: error) }
    }

    /// A tool step: `device.read` opens its file, others the call preview (local fallback when unavailable).
    private func openStep(_ step: ToolStep) async {
        if step.toolName == "device.read", !step.summary.isEmpty { await openFile(step.summary); return }
        do { show(try await workspace.previewTool(callID: step.id)) } catch { show(.fallback(step: step)) }
    }

    private func show(_ item: PreviewItem) {
        PreviewCenter.shared.items[botID] = item
        nav.openAgentDetail(botID, tab: .work)
    }
}

private extension String {
    /// Self, or nil when blank.
    var nonEmpty: String? { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : self }
}

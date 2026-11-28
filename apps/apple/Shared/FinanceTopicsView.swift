import SwiftUI
import NexClientKit
#if os(macOS)
import AppKit
#else
import UIKit
import QuickLook
#endif

/// Both Apple apps address the same Core topic; a late feed never replaces a different open topic.
/// Mirrors `src/personal/FinanceTopics.tsx` & `AgentDesktop.tsx` topic mode: isolates the opened topic,
/// supports GFM Markdown/charts/HTML previews/images/attachments/tool steps, pending-edit banner and glass composer.
struct FinanceTopicsView: View {
    let workspace: WorkspaceStore
    let botID: String
    let conversationID: String?
    let focusedMessageID: String?
    let onOpenDetail: (() -> Void)?
    let onClose: (() -> Void)?

    init(
        workspace: WorkspaceStore,
        botID: String,
        conversationID: String? = nil,
        focusedMessageID: String? = nil,
        onOpenDetail: (() -> Void)? = nil,
        onClose: (() -> Void)? = nil
    ) {
        self.workspace = workspace
        self.botID = botID
        self.conversationID = conversationID
        self.focusedMessageID = focusedMessageID
        self.onOpenDetail = onOpenDetail
        self.onClose = onClose
        _selected = State(initialValue: conversationID)
        _pendingTopicScroll = State(initialValue: conversationID != nil)
    }

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var scheme
    @State private var topics: [FinanceTopic] = []
    @State private var selected: String?
    @State private var messages: [AgentMessage] = []
    @State private var hasOlder = false
    private var streaming: String { workspace.topicLiveReplies.map(\.text).joined(separator: "\n") }
    @State private var drafts: [String: String] = [:]
    @State private var pending: TopicInput?
    @State private var sending = false
    @State private var errorText: String?
    @State private var generation = 0
    @State private var readSeq: [String: Int] = [:]
    @State private var taskRows: [AgentTask] = []
    @State private var editingMessageID: String?
    @State private var modelOpen = false
    @State private var taskRetryIDs: [String: String] = [:]
    @State private var unreadTopicAnchor: String?
    @State private var didAutoScrollTopics = false
    @State private var pendingTopicReadSeq: Int?
    @State private var unreadMessageAnchor: String?
    @State private var pendingTopicScroll = false
    @State private var topicScrollRevision = 0
    @State private var scrolledFocusedID: String?
    @State private var atBottom = true
    #if os(iOS)
    @State private var previewFile: TopicPreviewFile?
    #endif

    private var bot: Bot? { workspace.bot(botID) }
    private var current: FinanceTopic? { topics.first { $0.id == selected } }
    private var draft: Binding<String> {
        Binding(get: { drafts[selected ?? "new"] ?? "" }, set: { drafts[selected ?? "new"] = $0 })
    }
    private var canSend: Bool {
        !sending && (pending != nil || !draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    var body: some View {
        VStack(spacing: 0) {
            topHeader
            Divider().overlay(Theme.border)
            if workspace.connection != .connected {
                VStack(spacing: 10) {
                    Spacer()
                    ProgressView("正在重新同步…")
                    Spacer()
                }
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            if let current {
                                // Isolate opened topic: only render this topic's thread (matching Web).
                                openTopicThread(current)
                            } else if conversationID != nil {
                                HStack { Spacer(); ProgressView(); Spacer() }.padding(.vertical, 32)
                            } else {
                                ForEach(topics) { topic in
                                    topicSummaryCard(topic).id(topic.id)
                                }
                                if topics.isEmpty {
                                    VStack(spacing: 8) {
                                        if let bot {
                                            AgentAvatar(appearance: AgentAppearance.of(bot, firstID: workspace.bots.first?.id), size: 64)
                                        }
                                        Text("新建一段话题").font(.headline)
                                        Text("输入消息开始一个新的私人话题。").font(.caption).foregroundStyle(Theme.muted)
                                    }
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 48)
                                }
                            }
                            Color.clear.frame(height: 1).id("topic-bottom")
                                .onAppear { atBottom = true }
                                .onDisappear { atBottom = false }
                        }
                        .frame(maxWidth: Theme.readingWidth)
                        .padding(.horizontal, 14).padding(.vertical, 14)
                        .frame(maxWidth: .infinity)
                    }
                    #if os(iOS)
                    .scrollDismissesKeyboard(.interactively)
                    #endif
                    .overlay(alignment: .bottomTrailing) {
                        if selected != nil && !atBottom && !messages.isEmpty {
                            Button {
                                atBottom = true
                                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("topic-bottom", anchor: .bottom) }
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: "arrow.down").font(.system(size: 12.5, weight: .semibold))
                                        .foregroundStyle(Theme.brand)
                                    Text("回到底部").font(.system(size: 12.5, weight: .medium))
                                        .foregroundStyle(Theme.foreground)
                                }
                                .padding(.horizontal, 12).frame(height: 34)
                                .glass(Capsule(), strong: true, lift: .card)
                            }
                            .buttonStyle(.plain).accessibilityLabel("回到底部")
                            .padding(.trailing, 14).padding(.bottom, 10)
                        }
                    }
                    .onChange(of: unreadTopicAnchor) { _, target in
                        guard selected == nil, let target else { return }
                        DispatchQueue.main.async { proxy.scrollTo(target, anchor: .top) }
                    }
                    .task(id: "\(selected ?? "")|\(topicScrollRevision)") {
                        guard selected != nil, topicScrollRevision > 0, focusedMessageID == nil else { return }
                        if let target = unreadMessageAnchor, messages.contains(where: { $0.id == target }) {
                            atBottom = false
                            for delay in [0, 80, 260] {
                                if delay > 0 { try? await Task.sleep(for: .milliseconds(delay)) }
                                guard !Task.isCancelled else { return }
                                proxy.scrollTo(target, anchor: .top)
                            }
                        } else if !messages.isEmpty {
                            atBottom = true
                            for delay in [0, 80, 260] {
                                if delay > 0 { try? await Task.sleep(for: .milliseconds(delay)) }
                                guard !Task.isCancelled else { return }
                                proxy.scrollTo("topic-bottom", anchor: .bottom)
                            }
                        }
                    }
                    .onChange(of: messages.count) { _, _ in
                        if let focus = focusedMessageID, scrolledFocusedID != focus, messages.contains(where: { $0.id == focus }) {
                            scrolledFocusedID = focus
                            atBottom = false
                            DispatchQueue.main.async { proxy.scrollTo(focus, anchor: .center) }
                        } else if atBottom && selected != nil {
                            proxy.scrollTo("topic-bottom", anchor: .bottom)
                        }
                    }
                }

                if let errorText {
                    Label(errorText, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(Theme.danger)
                        .textSelection(.enabled)
                        .frame(maxWidth: Theme.readingWidth, alignment: .leading)
                        .padding(.horizontal, 16).padding(.bottom, 4)
                }

                if onClose == nil || current != nil {
                    composerDock
                }
            }
        }
        .background(Theme.background)
        .environment(\.openURL, OpenURLAction { url in
            if let link = ChatLinks.attachment(from: url) {
                Task { await downloadAttachment(link) }
                return .handled
            }
            guard Markdown.isOpenable(url) else { return .discarded }
            #if os(macOS)
            NSWorkspace.shared.open(url)
            return .handled
            #else
            return .systemAction
            #endif
        })
        .task(id: workspace.sync) { await reload() }
        .task(id: selected) { workspace.watchTopic(botID: botID, conversationID: selected); await loadSelected() }
        .task(id: workspace.topicRecovery) { await loadSelected() }
        .task(id: scenePhase) { if scenePhase == .active { await reload() } }
        .onChange(of: workspace.connection) { _, value in
            if value != .connected {
                topics = []; messages = []; hasOlder = false; taskRows = []; readSeq = [:]; generation += 1
            }
        }
        .onDisappear { generation += 1; workspace.leaveTopics(botID: botID) }
        #if os(macOS)
        .popover(isPresented: $modelOpen) {
            ChatModelMenu(workspace: workspace, botID: botID, close: { modelOpen = false }, onError: { errorText = $0 })
        }
        #else
        .sheet(isPresented: $modelOpen) {
            ChatModelSheet(workspace: workspace, botID: botID, onError: { errorText = $0 })
        }
        .sheet(item: $previewFile) { file in
            TopicQuickLookSheet(url: file.url).ignoresSafeArea()
        }
        .toolbar(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let onOpenDetail {
                    let hasJobs = !(workspace.state?.openJobs(botID: botID).isEmpty ?? true)
                    RoundGlassButton(symbol: "sidebar.right", label: "助手详情", badgeDot: hasJobs, size: 32, action: onOpenDetail)
                }
            }
        }
        #endif
    }

    private var topHeader: some View {
        HStack(spacing: 10) {
            if let current {
                if conversationID == nil {
                    Button {
                        resetToTopicList()
                    } label: {
                        HStack(spacing: 3) {
                            Image(systemName: "chevron.left").font(.system(size: 12, weight: .semibold))
                            Text("返回").font(.system(size: 13, weight: .medium))
                        }
                        .foregroundStyle(Theme.brand)
                        .padding(.horizontal, 8).frame(height: 30)
                        .background(Theme.brandSoft, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(sending || pending != nil)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(current.title).font(.system(size: 14.5, weight: .semibold)).lineLimit(1)
                    Text(current.destinationLabel).font(.caption2).foregroundStyle(Theme.muted).lineLimit(1)
                }
            } else {
                if let bot {
                    AgentAvatar(appearance: AgentAppearance.of(bot, firstID: workspace.bots.first?.id), size: 26)
                }
                Text(bot?.name ?? "话题").font(.system(size: 15, weight: .semibold))
            }
            Spacer(minLength: 8)
            Button("模型") { modelOpen = true }
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(Theme.foreground)
                .padding(.horizontal, 10).frame(height: 28)
                .background(Theme.secondary, in: Capsule())
                .buttonStyle(.plain)
            if let onClose {
                Button("关闭", action: onClose)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(Theme.muted)
                    .buttonStyle(.plain)
            } else if selected != nil {
                Button {
                    resetToTopicList()
                } label: {
                    Label("新话题", systemImage: "plus")
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(Theme.brand)
                }
                .buttonStyle(.plain)
                .disabled(sending || pending != nil)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 11)
        .background(Theme.card)
    }

    private func topicSummaryCard(_ topic: FinanceTopic) -> some View {
        Button {
            guard !sending && pending == nil else { return }
            selectTopic(topic.id)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(topic.title)
                        .font(.system(size: 14.5, weight: .semibold))
                        .foregroundStyle(Theme.foreground)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 4)
                    if topic.unread > 0 {
                        Text("\(topic.unread) 未读")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.primaryForeground)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(Theme.primary, in: Capsule())
                    }
                    if topic.activeTask != nil { ProgressView().controlSize(.small) }
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.muted)
                }
                if let lastAssistant = topic.messages.last(where: { $0.role == "assistant" }) {
                    let snippet = AttachmentLink.preview(lastAssistant.content)
                    if !snippet.isEmpty {
                        Text(snippet).font(.system(size: 13)).foregroundStyle(Theme.muted).lineLimit(2)
                    }
                }
                Text("\(topic.destinationLabel) · \(topic.replyCount) 条消息")
                    .font(.caption).foregroundStyle(Theme.muted)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardSurface(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay {
                if topic.id == unreadTopicAnchor {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(Theme.brand.opacity(0.55), lineWidth: 1.5)
                        .allowsHitTesting(false)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private func openTopicThread(_ topic: FinanceTopic) -> some View {
        if hasOlder {
            HStack {
                Spacer()
                Button("加载更早的消息") { Task { await loadOlder(topic.id) } }
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Theme.brand)
                    .buttonStyle(.plain)
                Spacer()
            }
            .padding(.bottom, 4)
        }
        ForEach(messages) { message in
            topicMessageRow(message, topicID: topic.id)
                .id(message.id)
        }
        ForEach(workspace.approvals.filter { approval in taskRows.contains { $0.id == approval.taskID } }) { approval in
            let jobTitle = workspace.state?.jobs.first(where: { $0.taskID == approval.taskID })?.title
            #if os(macOS)
            ApprovalCard(workspace: workspace, approval: approval, jobTitle: jobTitle)
            #else
            ApprovalCard(approval: approval, botName: bot?.name ?? "", jobTitle: jobTitle) { allow, remember in
                do { try await workspace.decide(approval, allow: allow, remember: remember) }
                catch { errorText = error.localizedDescription }
            }
            #endif
        }
        ForEach(taskRows.filter { $0.status == "failed" || $0.status == "cancelled" }) { task in
            Button("重试本题任务") { Task { await retry(topic.id, taskID: task.id) } }
                .buttonStyle(ConversationActionButtonStyle(size: .compact))
        }
        if !streaming.isEmpty {
            HStack(alignment: .bottom, spacing: 8) {
                if let bot {
                    AgentAvatar(appearance: AgentAppearance.of(bot, firstID: workspace.bots.first?.id), state: .working, size: 26)
                }
                MarkdownText(source: streaming, pending: true, hug: true)
                    .padding(.horizontal, 15).padding(.vertical, 10)
                    .cardSurface(Bubble.assistant(tail: true))
            }
            .padding(.trailing, 28)
        }
    }

    @ViewBuilder private func topicMessageRow(_ message: AgentMessage, topicID: String) -> some View {
        let parsed = AttachmentLink.parse(message.content)
        let embedded = AttachmentLink.embeddedImages(message.content)
        let body = AttachmentLink.stripped(parsed.body)
        let images = embedded + parsed.links.filter(\.isImage)
        let files = parsed.links.filter { !$0.isImage }
        let isFocused = message.id == focusedMessageID

        VStack(alignment: message.isFromUser ? .trailing : .leading, spacing: 6) {
            if message.id == unreadMessageAnchor {
                HStack(spacing: 8) {
                    Rectangle().fill(Theme.brand.opacity(0.24)).frame(height: 1)
                    Text("以下为未读消息")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.brand)
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(Theme.brandSoft, in: Capsule())
                    Rectangle().fill(Theme.brand.opacity(0.24)).frame(height: 1)
                }
                .padding(.vertical, 4)
            }
            if !message.isFromUser && (!message.streamProgress.isEmpty || !message.toolSteps.isEmpty) {
                MoreContent(durationMs: workDurationMs(steps: message.toolSteps, endedAt: message.createdAt)) {
                    if !message.streamProgress.isEmpty { MarkdownText(source: message.streamProgress) }
                    if !message.toolSteps.isEmpty {
                        InlineToolStepsList(workspace: workspace, steps: message.toolSteps)
                    }
                }
                .padding(.leading, 34)
            }
            if !images.isEmpty {
                VStack(alignment: message.isFromUser ? .trailing : .leading, spacing: 8) {
                    ForEach(Array(images.enumerated()), id: \.offset) { _, link in
                        TopicImageThumbnail(workspace: workspace, link: link) {
                            Task { await downloadAttachment(link) }
                        }
                    }
                }
                .padding(.leading, message.isFromUser ? 0 : 34)
            }
            if message.isFromUser {
                if !body.isEmpty {
                    MarkdownText(source: body, hug: true)
                        .environment(\.chatInk, .white)
                        .environment(\.chatOnAccent, true)
                        .padding(.horizontal, 15).padding(.vertical, 9)
                        .background(userBubbleGradient(dark: scheme == .dark), in: Bubble.user)
                }
                if message.row.string("input_status") == "pending" && pending == nil {
                    Button("编辑待运行消息") {
                        editingMessageID = message.id
                        drafts[topicID] = message.content
                    }
                    .font(.caption)
                    .foregroundStyle(Theme.brand)
                    .buttonStyle(.plain)
                }
            } else {
                HStack(alignment: .bottom, spacing: 8) {
                    if let bot {
                        AgentAvatar(appearance: AgentAppearance.of(bot, firstID: workspace.bots.first?.id), size: 26)
                            .padding(.bottom, 16)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        if !body.isEmpty {
                            MarkdownText(source: body, hug: true)
                                .padding(.horizontal, 15).padding(.vertical, 10)
                                .cardSurface(Bubble.assistant(tail: true))
                        }
                        if let at = message.createdAt {
                            Text(TimeFormat.formatShortTime(at))
                                .font(.system(size: 10.5).monospacedDigit())
                                .foregroundStyle(Theme.muted)
                                .padding(.horizontal, 4)
                        }
                    }
                }
                .padding(.trailing, 28)
            }
            ForEach(files) { link in
                Button { Task { await downloadAttachment(link) } } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "doc.text").foregroundStyle(Theme.brand)
                        Text(link.name).font(.system(size: 13)).foregroundStyle(Theme.foreground).lineLimit(1).truncationMode(.middle)
                        Image(systemName: "arrow.down.to.line").font(.caption).foregroundStyle(Theme.muted)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border))
                }
                .buttonStyle(.plain)
                .padding(.leading, message.isFromUser ? 0 : 34)
            }
        }
        .padding(.leading, message.isFromUser ? 48 : 0)
        .frame(maxWidth: .infinity, alignment: message.isFromUser ? .trailing : .leading)
        .overlay {
            if isFocused {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Theme.primary, lineWidth: 2)
                    .padding(-6)
                    .allowsHitTesting(false)
            }
        }
    }

    private var composerDock: some View {
        VStack(alignment: .leading, spacing: 6) {
            if editingMessageID != nil {
                HStack(spacing: 8) {
                    Image(systemName: "pencil").font(.caption).foregroundStyle(Theme.brand)
                    Text("正在编辑待运行消息").font(.caption.weight(.semibold)).foregroundStyle(Theme.brand)
                    Spacer()
                    Button("取消编辑") {
                        editingMessageID = nil
                        drafts[selected ?? "new"] = ""
                    }
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Theme.muted)
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(Theme.brandSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(
                    current.map { "回复「\($0.title)」…" } ?? "开始新话题…",
                    text: draft,
                    axis: .vertical
                )
                .lineLimit(1...5)
                .textFieldStyle(.plain)
                .font(.system(size: 14))
                .disabled(sending || pending != nil)
                .padding(.horizontal, 10).padding(.vertical, 8)
                .onSubmit {
                    #if os(macOS)
                    if canSend { Task { await send() } }
                    #endif
                }
                if let current, current.activeTask != nil {
                    Button { Task { await stop(current.id) } } label: {
                        Image(systemName: "stop.fill").font(.system(size: 12, weight: .bold))
                            .foregroundStyle(Theme.primaryForeground)
                            .frame(width: 34, height: 34)
                            .background(Theme.danger, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .help("停止本题").accessibilityLabel("停止本题")
                }
                Button { Task { await send() } } label: {
                    Group {
                        if sending { ProgressView().controlSize(.small) }
                        else { Image(systemName: pending == nil ? "arrow.up" : "arrow.clockwise").font(.system(size: 14, weight: .bold)) }
                    }
                    .foregroundStyle(canSend ? Theme.primaryForeground : Theme.muted)
                    .frame(width: 34, height: 34)
                    .background(canSend ? Theme.primary : Theme.wash, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .help(pending == nil ? "发送" : "重试原消息")
                .accessibilityLabel(pending == nil ? "发送" : "重试原消息")
            }
            .padding(.leading, 8).padding(.trailing, 6).padding(.vertical, 6)
            .glass(RoundedRectangle(cornerRadius: 24, style: .continuous), strong: true)
        }
        .frame(maxWidth: Theme.readingWidth)
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity)
    }

    private func resetToTopicList() {
        selected = nil
        messages = []
        hasOlder = false
        editingMessageID = nil
        taskRows = []
        pendingTopicReadSeq = nil
        unreadMessageAnchor = nil
        pendingTopicScroll = false
        atBottom = true
        generation += 1
    }

    private func selectTopic(_ id: String) {
        guard selected != id else { return }
        let chosen = topics.first { $0.id == id }
        pendingTopicReadSeq = (chosen?.unread ?? 0) > 0 ? (chosen?.readSeq ?? 0) : nil
        unreadMessageAnchor = nil
        pendingTopicScroll = true
        selected = id; editingMessageID = nil; taskRows = []; hasOlder = false
        messages = workspace.cachedTopicMessages(botID: botID, topicID: id)
        generation += 1
    }

    private func reload() async {
        guard workspace.connection == .connected else { return }
        let epoch = generation
        do {
            let result = try await workspace.client.financeTopics(botID: botID, conversationID: conversationID)
            guard epoch == generation, workspace.connection == .connected, !Task.isCancelled else { return }
            topics = result
            if selected == nil && !didAutoScrollTopics {
                didAutoScrollTopics = true
                unreadTopicAnchor = result.last(where: { $0.unread > 0 })?.id
            }
            await loadSelected()
        } catch { if epoch == generation { errorText = error.localizedDescription } }
    }

    private func loadSelected() async {
        guard let id = selected, workspace.connection == .connected else { return }
        let epoch = generation
        do {
            let feed = try await workspace.cachedTopicFeed(botID: botID, conversationID: id)
            guard epoch == generation, id == selected, workspace.connection == .connected, !Task.isCancelled else { return }
            let history = feed.messages
            let tasks = try await workspace.client.topicTasks(botID: botID, conversationID: id)
            guard epoch == generation, id == selected, workspace.connection == .connected,
                  workspace.sync?.sameGeneration(as: feed.sync) == true, !Task.isCancelled else { return }
            if pendingTopicReadSeq == nil, unreadMessageAnchor == nil, let topic = topics.first(where: { $0.id == id }), topic.unread > 0 {
                pendingTopicReadSeq = topic.readSeq
            }
            if let baseline = pendingTopicReadSeq {
                pendingTopicReadSeq = nil
                unreadMessageAnchor = history.first {
                    $0.seq > baseline && $0.role != "user" && !($0.row.string("source_key")?.hasPrefix("stock-history:") ?? false)
                }?.id
            }
            messages = history; taskRows = tasks; hasOlder = feed.hasOlder ?? false
            if pendingTopicScroll {
                pendingTopicScroll = false
                topicScrollRevision += 1
            }
            workspace.updateTopicLiveReplies(feed.streaming, botID: botID, conversationID: id)
            workspace.rememberTopicMessages(history, botID: botID, topicID: id, generation: feed.sync)
            if scenePhase == .active, let seq = messages.last?.seq, seq > (readSeq[id] ?? 0) {
                let previous = readSeq[id]
                readSeq[id] = seq
                do { try await workspace.client.readTopic(botID: botID, conversationID: id, seq: seq) }
                catch { if readSeq[id] == seq { readSeq[id] = previous }; throw error }
            }
        } catch { if epoch == generation, id == selected { errorText = error.localizedDescription } }
    }

    private func send() async {
        guard !sending, workspace.connection == .connected else { return }
        let input = pending ?? TopicInput(botID: botID, text: draft.wrappedValue, conversationID: selected, editingMessageID: editingMessageID)
        pending = input; sending = true; errorText = nil
        defer { sending = false }
        do {
            let result = try await workspace.client.sendTopic(input)
            pending = nil; editingMessageID = nil; drafts[input.conversationId ?? "new"] = ""; selected = result.conversationId; generation += 1
            await reload()
        } catch { errorText = error.localizedDescription }
    }

    private func loadOlder(_ id: String) async {
        guard let before = messages.first?.seq else { return }
        do {
            let feed = try await workspace.cachedTopicFeed(botID: botID, conversationID: id, before: before, at: messages.first?.row.int("created_at"))
            guard selected == id, workspace.connection == .connected, workspace.sync?.sameGeneration(as: feed.sync) == true else { return }
            hasOlder = feed.hasOlder ?? false
            let existing = Set(messages.map(\.id))
            messages = feed.messages.filter { !existing.contains($0.id) } + messages
            workspace.rememberTopicMessages(messages, botID: botID, topicID: id, generation: feed.sync)
        } catch { errorText = error.localizedDescription }
    }

    private func retry(_ id: String, taskID: String) async {
        let clientID = taskRetryIDs[taskID] ?? UUID().uuidString; taskRetryIDs[taskID] = clientID
        do {
            let _: TopicInputResult = try await workspace.client.retryTopic(botID: botID, conversationID: id, taskID: taskID, clientID: clientID)
            taskRetryIDs.removeValue(forKey: taskID)
            await reload()
        } catch { errorText = error.localizedDescription }
    }

    private func stop(_ id: String) async {
        do { try await workspace.client.cancelTopic(botID: botID, conversationID: id); await reload() }
        catch { errorText = error.localizedDescription }
    }

    private func downloadAttachment(_ link: AttachmentLink) async {
        errorText = nil
        do {
            let file = try await workspace.downloadAttachment(id: link.id)
            let name = file.filename == "attachment" ? (link.picture ? link.name + ".png" : link.name) : file.filename
            #if os(macOS)
            let panel = NSSavePanel()
            panel.nameFieldStringValue = name
            panel.canCreateDirectories = true
            if panel.runModal() == .OK, let url = panel.url {
                try file.data.write(to: url, options: .atomic)
            }
            #else
            let cleaned = name.map { "\\/:*?\"<>|".contains($0) ? "_" : $0 }.map(String.init).joined().trimmingCharacters(in: .whitespacesAndNewlines)
            let dir = FileManager.default.temporaryDirectory
                .appendingPathComponent("NexBotTopicShare", isDirectory: true)
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let fileURL = dir.appendingPathComponent(cleaned.isEmpty || cleaned == "." || cleaned == ".." ? "附件" : cleaned)
            try file.data.write(to: fileURL, options: .atomic)
            previewFile = TopicPreviewFile(url: fileURL)
            #endif
        } catch {
            errorText = (error as? CoreError)?.message ?? error.localizedDescription
        }
    }
}

private struct TopicImageThumbnail: View {
    let workspace: WorkspaceStore
    let link: AttachmentLink
    let onSave: () -> Void
    @State private var bytes: Data?
    @State private var failed = false

    var body: some View {
        Group {
            if let bytes {
                #if os(macOS)
                if let ns = NSImage(data: bytes) {
                    Image(nsImage: ns).resizable().scaledToFill()
                        .frame(width: 220, height: 150)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .contextMenu { Button("存储原图…", action: onSave) }
                }
                #else
                if let ui = UIImage(data: bytes) {
                    Image(uiImage: ui).resizable().scaledToFill()
                        .frame(width: 220, height: 150)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .contextMenu { Button("存储原图", action: onSave) }
                }
                #endif
            } else if failed {
                Button(action: onSave) {
                    Label(link.name, systemImage: "photo").font(.caption).foregroundStyle(Theme.muted)
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
            } else {
                RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.card)
                    .frame(width: 220, height: 150)
                    .overlay(ProgressView().controlSize(.small))
            }
        }
        .task(id: link.id) {
            do { bytes = try await workspace.attachmentImage(id: link.id) }
            catch { failed = true }
        }
    }
}

#if os(iOS)
private struct TopicPreviewFile: Identifiable {
    let id = UUID()
    let url: URL
}

private struct TopicQuickLookSheet: UIViewControllerRepresentable {
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
#endif

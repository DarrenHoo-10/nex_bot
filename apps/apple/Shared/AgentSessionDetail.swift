import SwiftUI
import NexClientKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Drafts survive switching between sessions.
@MainActor
enum AgentDrafts {
    static var texts: [CliSessionKey: String] = [:]
    static var images: [CliSessionKey: [CliImageUpload]] = [:]
    static var models: [CliSessionKey: String] = [:]
    static var appliedModels: [CliSessionKey: String] = [:]
    static var efforts: [CliSessionKey: String] = [:]
    static var appliedEfforts: [CliSessionKey: String] = [:]
}

private enum AgentTab: Hashable { case terminal, chat }

/// A message sent from this screen that the session's records do not hold yet: it shows at once, with the dots under it.
struct AgentPendingSend: Identifiable, Equatable {
    let id = UUID()
    let text: String
    /// the items the transcript held when it was sent
    let known: Set<String>

    /// Still waiting: no new user item with its text, and nothing of the agent after it.
    func waiting(in items: [CliItem]) -> Bool {
        let plain = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !items.contains { item in
            guard !known.contains(item.id) else { return false }
            switch item.kind {
            case .user: return item.text.trimmingCharacters(in: .whitespacesAndNewlines) == plain
            case .turn: return false
            case .notice: return !item.text.isEmpty
            default: return true
            }
        }
    }
}

/// One session: terminal or transcript, the cards of what it asks for, and the composer.
struct AgentSessionDetail: View {
    let model: CliAgentsModel
    let workspace: WorkspaceStore
    let key: CliSessionKey
    let openAssistant: (String) -> Void
    /// The session continues under another key.
    let onKeyChange: (CliSessionKey) -> Void
    @State private var tab: AgentTab = .terminal
    @State private var forking = false
    @State private var forkItemId: String?
    @State private var branchedChat: CliForkResult?
    @State private var actionError = ""
    @State private var pending: [AgentPendingSend] = []
    /// A model call that failed for good while this screen was open.
    @State private var failure: String?
    @State private var failuresSeen: Set<String>?
    @State private var openedAt = Date()
    @State private var expandedActivities: Set<String> = []

    private var session: CliSession? { model.sessions.first { $0.key == key } }

    var body: some View {
        Group {
            if let session {
                content(session)
            } else {
                Text("会话不存在").foregroundStyle(Theme.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear {
            model.openSession(key)
            // a session just started here opens on its conversation, where the first message shows
            if model.echoes[key] != nil { tab = .chat }
        }
        .onDisappear { model.closeSession(key) }
        .onChange(of: key) { _, _ in pending = []; failuresSeen = nil; openedAt = Date() }
        .onChange(of: model.transcript(key).items) { _, items in noteFailures(items) }
        .alert("模型调用失败", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("知道了", role: .cancel) { failure = nil }
        } message: {
            Text((failure ?? "") + "\n任务已停在这里")
        }
        .sheet(isPresented: $forking, onDismiss: {
            forkItemId = nil
            branchedChat = nil
        }) {
            if let branchedChat {
                FinanceTopicsView(workspace: workspace, botID: branchedChat.botId, conversationID: branchedChat.conversationId,
                                  onClose: { forking = false })
                    #if os(macOS)
                    .frame(minWidth: 520, minHeight: 460)
                    #endif
            } else if let session {
                AgentForkSheet(model: model, workspace: workspace, session: session, itemId: forkItemId) { result in
                    if forkItemId != nil {
                        branchedChat = result
                    } else {
                        forking = false
                        openAssistant(result.botId)
                    }
                }
            }
        }
    }

    private func content(_ session: CliSession) -> some View {
        let attach = CliSessions.canAttach(session)
        let shown = attach ? tab : .chat
        let cards = model.cards(key)
        return VStack(spacing: 0) {
            header(session, attach: attach, shown: shown)
            if !actionError.isEmpty {
                Text(actionError).font(.caption).foregroundStyle(Theme.danger).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14).padding(.bottom, 6)
            }
            if !cards.isEmpty {
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(cards.sorted { !$0.closed && $1.closed }) { record in
                            AgentRequestCard(model: model, record: record)
                        }
                    }
                    .padding(.horizontal, 14).padding(.bottom, 8)
                }
                .frame(maxHeight: 260)
            }
            Group {
                if shown == .terminal {
                    AgentTerminalPane(model: model, key: key)
                } else {
                    AgentTranscript(model: model, key: key, expandedActivities: $expandedActivities, engine: session.engine, active: session.state == .running || session.state == .waiting, working: session.online && session.state == .running ? "执行中" : nil, pending: pending,
                                    branch: workspace.bots.isEmpty ? nil : { itemId in
                                        forkItemId = itemId
                                        forking = true
                                    })
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            AgentComposer(model: model, session: session, pending: $pending) { next in onKeyChange(next) }
        }
    }

    private func header(_ session: CliSession, attach: Bool, shown: AgentTab) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(CliSessions.title(session)).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                    Text([session.engine.label, CliSessions.folderLabel(session.cwd), session.gitBranch ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                }
                Spacer(minLength: 4)
                CliChip(text: CliSessions.statusLabel(session), tone: CliSessions.tone(session))
                actions(session)
            }
            if attach {
                PillTabs(items: [AgentTab.terminal, .chat], title: { $0 == .terminal ? "终端" : "对话" }, selection: $tab)
                    .frame(maxWidth: 180)
            }
        }
        .padding(14)
    }

    @ViewBuilder
    private func actions(_ session: CliSession) -> some View {
        let canFork = !workspace.bots.isEmpty
        #if os(macOS)
        if canFork { Button("交给助手") { forking = true }.buttonStyle(.bordered) }
        if session.online { Button("在电脑上打开") { Task { await openLocal() } }.buttonStyle(.bordered) }
        #else
        if canFork || session.online {
            Menu {
                if canFork { Button("交给助手") { forking = true } }
                if session.online { Button("在电脑上打开") { Task { await openLocal() } } }
            } label: { Image(systemName: "ellipsis.circle") }
        }
        #endif
    }

    /// What the records already held when the screen opened is history; a failure arriving later opens the alert.
    private func noteFailures(_ items: [CliItem]) {
        let failures = items.compactMap { item -> (id: String, ts: Int, reason: String)? in
            guard item.kind == .notice, item.level == .error, let reason = CliTranscript.modelFailureReason(item.text) else { return nil }
            return (item.id, item.ts, reason)
        }
        if failuresSeen == nil {
            guard !items.isEmpty else { return }
            let opened = Int(openedAt.timeIntervalSince1970 * 1000) - 5_000
            failuresSeen = Set(failures.filter { $0.ts < opened }.map(\.id))
        }
        let fresh = failures.filter { !(failuresSeen?.contains($0.id) ?? false) }
        for entry in fresh { failuresSeen?.insert(entry.id) }
        if let last = fresh.last { failure = last.reason }
    }

    private func openLocal() async {
        actionError = ""
        do { try await model.openLocal(key) } catch { actionError = CliErrorText.text(for: error) }
    }
}

// MARK: Terminal

private struct AgentTerminalPane: View {
    let model: CliAgentsModel
    let key: CliSessionKey
    @State private var controller: CliTerminalController?

    var body: some View {
        VStack(spacing: 0) {
            if let controller {
                toolbar(controller)
                GeometryReader { proxy in
                    CliTerminalView(controller: controller, width: proxy.size.width, control: controller.wantsControl)
                        .padding(4)
                }
                .background(Color.black)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .padding(.horizontal, 14).padding(.bottom, 8)
            } else {
                Text("正在连接").font(.footnote).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear { create() }
        .onChange(of: model.connected) { _, _ in create() }
        .onDisappear {
            controller?.stop()
            model.attach(nil)
            controller = nil
        }
    }

    private func create() {
        guard controller == nil, let made = model.makeTerminal(key: key) else { return }
        controller = made
        model.attach(made)
    }

    private func toolbar(_ controller: CliTerminalController) -> some View {
        let mode = Binding<CliTermMode>(get: { controller.wantsControl ? .control : .observe }, set: { controller.setMode($0) })
        let status = controller.status
        var text = status.text
        if status == .closed { let reason = CliTermState.closeReasonText(controller.state.reason); if !reason.isEmpty { text += " · " + reason } }
        return HStack(spacing: 10) {
            PillTabs(items: [CliTermMode.observe, .control], title: { $0 == .observe ? "只看" : "操作" }, selection: mode).frame(maxWidth: 140)
            Text(text).font(.caption).foregroundStyle(Theme.muted)
            if let code = controller.state.errorCode { Text(CliErrorText.byCode[code] ?? "终端出错").font(.caption).foregroundStyle(Theme.danger) }
            Spacer()
            if status == .closed { Button("重新连接") { controller.reconnect() }.font(.caption).buttonStyle(.bordered) }
        }
        .padding(.horizontal, 14).padding(.bottom, 8)
    }
}

// MARK: Transcript

private struct AgentTranscript: View {
    let model: CliAgentsModel
    let key: CliSessionKey
    @Binding var expandedActivities: Set<String>
    var engine: CliEngine = .claude
    var active = false
    /// what the agent is doing while the turn runs; shown as dots under the last message
    var working: String?
    /// messages sent from here that the records do not hold yet
    var pending: [AgentPendingSend] = []
    var branch: ((String) -> Void)?

    var body: some View {
        let t = model.transcript(key)
        let sent = pending.filter { $0.waiting(in: t.items) }
        let working = self.working ?? (sent.isEmpty ? nil : "等待回复")
        let blocks = CliTranscript.group(t.items)
        let completed = CliTranscript.completedReplies(t.items, active: active)
        let echo = t.items.contains { $0.kind == .user } ? nil : model.echoes[key]
        Group {
            if blocks.isEmpty && (echo != nil || !sent.isEmpty) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if let echo { AgentEchoBubble(text: echo) }
                        ForEach(sent) { AgentEchoBubble(text: $0.text) }
                        AgentWorkingRow(engine: engine, label: working ?? "执行中", byline: true)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 6)
                }
            } else if let error = t.error, t.items.isEmpty {
                VStack(spacing: 8) {
                    Text(error).font(.footnote).foregroundStyle(Theme.danger)
                    Button("重试") { model.reloadTranscript(key) }.buttonStyle(.bordered)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !t.loaded {
                Text("正在读取…").font(.footnote).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if blocks.isEmpty {
                Text("暂无记录").font(.footnote).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            if t.more {
                                Button(t.loadingOlder ? "正在读取…" : "加载更早的记录") { Task { await model.loadOlder(key) } }
                                    .buttonStyle(.plain).font(.caption).foregroundStyle(Theme.identityAccent).disabled(t.loadingOlder)
                                    .frame(maxWidth: .infinity)
                                    // reading upwards loads earlier records without a tap
                                    .onAppear { Task { await model.loadOlder(key) } }
                            }
                            ForEach(blocks) { block in
                                AgentBlockView(block: block, expandedActivities: $expandedActivities, loadImage: model.downloadImage, translate: t.translationEnabled && completed.contains(block.id) ? { item in
                                    try await model.translateReply(key, item: item)
                                } : nil, branch: completed.contains(block.id) ? branch : nil)
                            }
                            if let echo { AgentEchoBubble(text: echo) }
                            ForEach(sent) { AgentEchoBubble(text: $0.text) }
                            // the agent's name heads the dots only when nothing of this reply is shown yet
                            if let working { AgentWorkingRow(engine: engine, label: working, byline: echo != nil || !sent.isEmpty || { if case .user = blocks.last { return true } else { return false } }()) }
                            Color.clear.frame(height: 1).id("bottom")
                        }
                        .padding(.horizontal, 14).padding(.vertical, 6)
                    }
                    .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
                    .onChange(of: blocks.last?.id) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                    .onChange(of: working) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                    .onChange(of: sent.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                    .onChange(of: t.items.last?.text.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
        }
    }
}

private struct AgentBlockView: View {
    let block: CliBlock
    @Binding var expandedActivities: Set<String>
    let loadImage: (String) async throws -> Data
    var translate: ((CliItem) async throws -> String?)?
    var branch: ((String) -> Void)?

    var body: some View {
        switch block {
        case .user(let item):
            HStack {
                Spacer(minLength: 40)
                VStack(alignment: .trailing, spacing: 2) {
                    AgentImageMessage(text: item.text, load: loadImage)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(Theme.chatUser, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    if item.queued { Text("排队中").font(.caption2).foregroundStyle(Theme.muted) }
                }
            }
        case .assistant(let item):
            AgentReplyText(item: item, translate: translate, branch: branch)
        case .activity(let id, let items):
            AgentActivity(items: items, open: Binding(get: { expandedActivities.contains(id) }, set: { open in
                if open { expandedActivities.insert(id) }
                else { expandedActivities.remove(id) }
            }))
        case .notice(_, let level, let text):
            Text(text).font(.caption).foregroundStyle(level == .error ? Theme.danger : Theme.muted).frame(maxWidth: .infinity, alignment: .center)
        }
    }
}

private struct AgentReplyText: View {
    let item: CliItem
    var translate: ((CliItem) async throws -> String?)?
    var branch: ((String) -> Void)?
    @State private var translated: String?
    @State private var original = false
    @State private var failed = false
    @State private var retry = 0
    private var displayedText: String { original ? item.text : translated ?? item.text }

    private struct Request: Equatable {
        let source: String
        let attempt: Int
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            MarkdownText(source: displayedText, fontSize: 14)
                .frame(maxWidth: .infinity, alignment: .leading)
            if translated != nil {
                Button(original ? "查看中文" : "查看原文") { original.toggle() }
                    .buttonStyle(.plain).font(.caption).foregroundStyle(Theme.identityAccent)
            } else if failed {
                Button("重试翻译") { retry += 1 }
                    .buttonStyle(.plain).font(.caption).foregroundStyle(Theme.identityAccent)
            }
            HStack(spacing: 4) {
                Button {
                    #if os(macOS)
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(displayedText, forType: .string)
                    #else
                    UIPasteboard.general.string = displayedText
                    #endif
                } label: { Label("复制", systemImage: "doc.on.doc") }
                    .help("复制")
                if let branch {
                    Button { branch(item.id) } label: { Label("分支到新聊天", systemImage: "arrow.triangle.branch") }
                        .help("分支到新聊天")
                }
            }
            .labelStyle(.iconOnly).buttonStyle(.borderless).font(.system(size: 13)).foregroundStyle(Theme.muted)
        }
        .task(id: translate == nil ? nil : Request(source: item.text, attempt: retry)) {
            translated = nil
            failed = false
            guard let translate, item.text.range(of: "[A-Za-z]{3,}", options: .regularExpression) != nil else { return }
            do {
                let result = try await translate(item)
                if !Task.isCancelled { translated = result }
            } catch {
                if !Task.isCancelled { failed = true }
            }
        }
    }
}

private struct AgentActivity: View {
    let items: [CliItem]
    @Binding var open: Bool

    var body: some View {
        let tools = items.filter { $0.kind == .tool }
        let failed = tools.filter { $0.status == .error }.count
        DisclosureGroup(isExpanded: $open) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(items) { item in
                    if item.kind == .tool { AgentToolRow(item: item) }
                    else { Text(item.text).font(.caption).foregroundStyle(Theme.muted).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                }
            }
            .padding(.top, 6)
            .frame(maxWidth: 560, alignment: .leading)
        } label: {
            (Text(tools.isEmpty ? "思考" : "\(tools.count) 项操作") + (failed > 0 ? Text(" · \(failed) 项失败").foregroundStyle(Theme.danger) : Text("")))
                .font(.system(size: 12)).foregroundStyle(Theme.muted)
        }
    }
}

private struct AgentToolRow: View {
    let item: CliItem
    @State private var open = false

    var body: some View {
        let backgroundTitle = CliTranscript.backgroundTaskTitle(item)
        DisclosureGroup(isExpanded: $open) {
            VStack(alignment: .leading, spacing: 6) {
                if !item.input.isEmpty { code(item.input) }
                if let output = item.output, !output.isEmpty { code(output) }
            }
        } label: {
            HStack(spacing: 6) {
                Text(backgroundTitle ?? item.name).font(.system(size: 12, weight: .medium)).lineLimit(1)
                if backgroundTitle == nil {
                    Text(CliTranscript.toolSummary(item.input)).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                }
                Spacer(minLength: 0)
                Text(CliTranscript.toolStatusText(item.status)).font(.caption2).foregroundStyle(item.status == .error ? Theme.danger : Theme.muted)
            }
        }
    }

    private func code(_ text: String) -> some View {
        ToolCodeBlock(text: text)
            .background(Theme.wash, in: RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: Requests

private struct AgentRequestCard: View {
    let model: CliAgentsModel
    let record: CliRequestRecord
    @State private var selection: CliRequestStore.Selection = [:]
    @State private var busy: CliDecision?
    @State private var busyAlways = false
    @State private var error = ""

    private var request: CliRequest { record.view }

    var body: some View {
        let state = model.cardState(record)
        let open = state == .pending
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(request.kind == .question ? "提问" : request.tool).font(.system(size: 13, weight: .semibold))
                Spacer()
                CliChip(text: open ? (request.kind == .question ? "等你回答" : "等你批准") : state.text, tone: open ? .waiting : .idle)
            }
            if request.kind == .question {
                ForEach(Array((request.questions ?? []).enumerated()), id: \.offset) { index, question in questionView(index, question, enabled: open) }
            } else if !request.summary.isEmpty {
                Text(request.summary).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(8)
                    .background(Theme.wash, in: RoundedRectangle(cornerRadius: 8))
            }
            if request.kind != .question, let detail = request.detail, !detail.isEmpty {
                DisclosureGroup("参数") {
                    ScrollView { Text(detail).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                        .frame(maxHeight: 200).padding(8)
                        .background(Theme.wash, in: RoundedRectangle(cornerRadius: 8))
                }
                .font(.caption).foregroundStyle(Theme.muted)
            }
            if open {
                HStack {
                    Spacer()
                    Button(busy == .deny ? "正在拒绝…" : "拒绝") { submit(.deny) }.buttonStyle(ConversationActionButtonStyle(tone: .dark))
                    if request.offersAlways {
                        Button(busyAlways ? "正在允许…" : "本会话总是允许") { submit(.allow, always: true) }.buttonStyle(ConversationActionButtonStyle())
                    }
                    Button(busy == .allow && !busyAlways ? (request.kind == .question ? "正在提交…" : "正在允许…") : (request.kind == .question ? "提交" : "允许")) { submit(.allow) }
                        .buttonStyle(ConversationActionButtonStyle())
                        .disabled(request.kind == .question && !CliRequestStore.answersComplete(request.questions, selection))
                }
                .disabled(busy != nil)
            }
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(Theme.danger) }
        }
        .padding(12)
        .cardSurface(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .opacity(open ? 1 : 0.7)
    }

    private func questionView(_ index: Int, _ question: CliQuestion, enabled: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let header = question.header, !header.isEmpty { Text(header).font(.caption).foregroundStyle(Theme.muted) }
            Text(question.question).font(.system(size: 13))
            ForEach(question.options, id: \.label) { option in
                let on = selection[index]?.contains(option.label) ?? false
                Button {
                    selection = CliRequestStore.toggle(selection, index: index, label: option.label, multi: question.multiSelect)
                } label: {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: question.multiSelect ? (on ? "checkmark.square.fill" : "square") : (on ? "largecircle.fill.circle" : "circle"))
                            .foregroundStyle(on ? Theme.identityAccent : Theme.muted)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(option.label).font(.system(size: 13)).foregroundStyle(Theme.foreground)
                            if let description = option.description, !description.isEmpty {
                                Text(description).font(.caption).foregroundStyle(Theme.muted)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!enabled)
            }
        }
    }

    private func submit(_ decision: CliDecision, always: Bool = false) {
        busy = decision; busyAlways = always; error = ""
        Task {
            do { try await model.answer(request, decision: decision, selection: selection, always: always) }
            catch { self.error = CliAgentsModel.answerErrorText(error) }
            busy = nil; busyAlways = false
        }
    }
}

// MARK: Composer

private struct AgentComposer: View {
    let model: CliAgentsModel
    let session: CliSession
    @Binding var pending: [AgentPendingSend]
    let onKeyChange: (CliSessionKey) -> Void
    @State private var draft = ""
    @State private var sending = false
    @State private var error = ""
    @State private var deliveryNotice: String?
    @State private var images: [CliImageUpload] = []
    @State private var showingEffort = false
    @State private var effort: String?
    @State private var chosenModel = ""
    @State private var showingModels = false
    @State private var catalog = CliModelCatalog(models: [])

    private var canSetOnResume: Bool { model.device(session.deviceId)?.cliAgents?.features.contains("launchOptions") == true }
    private var claudeInbox: Bool {
        session.engine == .claude && session.sendVia == "inbox" && model.device(session.deviceId)?.cliAgents?.features.contains("inboxSteer") == true
    }
    private var pendingRequests: [CliRequestRecord] { model.cards(session.key).filter { model.cardState($0) == .pending } }
    private var steerQuestionId: String? {
        guard canSetOnSend, session.state == .running || session.state == .waiting else { return nil }
        let pending = pendingRequests
        guard pending.count == 1, let question = pending.first?.view,
              question.kind == .question, question.tool == "AskUserQuestion" else { return nil }
        return question.id
    }
    private var interruptWaiting: Bool { canSetOnSend && session.state == .waiting && pendingRequests.isEmpty }
    private var canSteer: Bool {
        guard session.online else { return false }
        if steerQuestionId != nil || interruptWaiting { return true }
        return pendingRequests.isEmpty && session.state == .running && ((session.liveIn == .nexbot && session.terminal != nil) || claudeInbox)
    }
    private var steerLabel: String {
        if steerQuestionId != nil { return "取消提问并引导" }
        return interruptWaiting ? "中断并引导" : "引导"
    }
    private var composerMode: CliComposerMode {
        if claudeInbox && session.online && session.state != .stopped {
            return .send(running: session.state == .running || session.state == .waiting)
        }
        return CliSessions.composerMode(session)
    }
    private var canSetOnSend: Bool { session.engine == .claude && session.liveIn == .nexbot && session.terminal != nil }
    private var effortLevels: [String] { CliLaunches.efforts[session.engine] == nil ? [] : CliLaunches.reasoningLevels }
    private var selectedEffort: String { CliLaunches.reasoningChoice(effort) }
    private var offered: [String] {
        let effectiveModel = chosenModel.isEmpty ? session.model ?? catalog.current ?? "" : chosenModel
        return CliLaunches.efforts(engine: session.engine, models: catalog.models, model: effectiveModel)
    }
    private var resolvedEffort: String? {
        CliLaunches.resolveEffort(engine: session.engine, offered: offered, preferred: selectedEffort)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(Theme.danger) }
            if let deliveryNotice { Text(deliveryNotice).font(.caption).foregroundStyle(Theme.muted) }
            AgentImageDrafts(images: $images)
            switch composerMode {
            case .send(let running):
                sendRow(running: running)
            case .stopped(let hint):
                HStack {
                    #if os(iOS)
                    if hint == nil && canSetOnResume { AgentComposerAdd(images: $images, error: $error) }
                    #endif
                    Text(hint ?? "会话已停止").font(.footnote).foregroundStyle(Theme.muted)
                    Spacer()
                    if hint == nil && canSetOnResume { modelChip }
                    #if os(macOS)
                    if hint == nil && canSetOnResume && !effortLevels.isEmpty { effortButton }
                    #endif
                    Button(sending ? "正在继续…" : "继续") { Task { await resume() } }
                        .buttonStyle(.borderedProminent).tint(Theme.identityAccent).disabled(hint != nil || sending)
                }
            case .blocked(let hint):
                Text(hint).font(.footnote).foregroundStyle(Theme.muted)
            }
        }
        .padding(14)
        .onAppear {
            draft = AgentDrafts.texts[session.key] ?? ""
            effort = AgentDrafts.efforts[session.key]
            chosenModel = AgentDrafts.models[session.key] ?? ""
            images = AgentDrafts.images[session.key] ?? []
        }
        .onChange(of: draft) { _, text in AgentDrafts.texts[session.key] = text }
        .onChange(of: images) { _, value in AgentDrafts.images[session.key] = value.isEmpty ? nil : value }
        .task(id: canSetOnResume || canSetOnSend) {
            guard canSetOnResume || canSetOnSend else { return }
            let options = await model.models(deviceId: session.deviceId, engine: session.engine)
            if !Task.isCancelled { catalog = options }
        }
        .onChange(of: chosenModel) { _, name in AgentDrafts.models[session.key] = name }
        #if os(iOS)
        .sheet(isPresented: $showingModels) {
            AgentComposerModelOptions(catalog: catalog, model: $chosenModel, levels: effortLevels, selection: selectedEffort, chooseEffort: setEffort)
        }
        #endif
    }

    private var tooLong: Bool { draft.utf8.count > CoreClient.cliMaxSendBytes }
    private var canSend: Bool { (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty) && !tooLong && !sending }

    private func sendRow(running: Bool) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            AgentComposerAdd(images: $images, error: $error)
            TextField("发消息", text: $draft, axis: .vertical)
                .lineLimit(1...5).textFieldStyle(.plain)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Theme.wash, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .onSubmit { if canSend { Task { await send() } } }
            if tooLong { Text("内容太长").font(.caption).foregroundStyle(Theme.danger) }
            modelChip
            AgentContextRing(usage: session.context)
            #if os(macOS)
            if canSetOnSend && !effortLevels.isEmpty { effortButton }
            #endif
            if canSteer && canSend {
                let questionId = steerQuestionId
                let shouldInterrupt = interruptWaiting
                Button(steerLabel) {
                    Task { await send(steer: true, questionId: questionId, interruptWaiting: shouldInterrupt) }
                }
                    .buttonStyle(ConversationActionButtonStyle(size: .compact))
            }
            // one button: Stop while a turn runs and the box is empty, Send once there is something to send
            if running && !sending && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty {
                Button { Task { await interrupt() } } label: { Image(systemName: "stop.circle.fill").font(.system(size: 26)) }
                    .buttonStyle(.plain).foregroundStyle(Theme.foreground).accessibilityLabel("停止")
            } else {
                Button { Task { await send() } } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: 26)) }
                    .buttonStyle(.plain).foregroundStyle(canSend ? Theme.identityAccent : Theme.offline)
                    .disabled(!canSend).accessibilityLabel("发送")
            }
        }
    }

    /// The model the next message or continue uses, by the name the catalog gives it.
    private var modelTitle: String {
        let id = chosenModel.isEmpty ? (session.model ?? catalog.current ?? "") : chosenModel
        guard !id.isEmpty else { return "默认模型" }
        return catalog.models.first { $0.id == id }?.label ?? id
    }

    /// The model on one line left of the context ring, cut at its width; it opens the model choices.
    @ViewBuilder private var modelChip: some View {
        if canSetOnResume || canSetOnSend {
            #if os(iOS)
            Button { showingModels = true } label: { modelChipLabel }
                .buttonStyle(.plain)
                .accessibilityLabel("模型设置").accessibilityValue(modelTitle)
            #else
            Menu {
                modelRow("", title: "默认模型")
                ForEach(catalog.models) { option in modelRow(option.id, title: option.label) }
            } label: { modelChipLabel }
                .menuStyle(.borderlessButton).menuIndicator(.hidden)
                .frame(maxWidth: 180)
                .accessibilityLabel("模型设置").accessibilityValue(modelTitle)
            #endif
        }
    }

    private var modelChipLabel: some View {
        Text(modelTitle).font(.footnote).foregroundStyle(Theme.muted)
            .lineLimit(1).truncationMode(.tail)
            #if os(iOS)
            .frame(maxWidth: 110, alignment: .trailing)
            #endif
            .frame(height: 34).contentShape(Rectangle())
    }

    #if os(macOS)
    private func modelRow(_ id: String, title: String) -> some View {
        Button { chosenModel = id } label: {
            if chosenModel == id { Label(title, systemImage: "checkmark") } else { Text(title) }
        }
    }
    #endif

    private func setEffort(_ level: String) {
        effort = level
        AgentDrafts.efforts[session.key] = level
    }

    private var effortButton: some View {
        Button { showingEffort.toggle() } label: {
            HStack(spacing: 4) {
                Text(CliLaunches.effortLabel(selectedEffort))
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
            }
            .font(.footnote)
            .padding(.horizontal, 8).frame(height: 34)
            .background(Theme.wash, in: RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("思考强度")
        .accessibilityValue(CliLaunches.effortLabel(selectedEffort))
        .popover(isPresented: $showingEffort, arrowEdge: .bottom) {
            ChatEffortChoices(levels: effortLevels, selection: selectedEffort, label: CliLaunches.effortLabel, tint: Theme.identityAccent, choose: setEffort)
            .padding(12).frame(width: 305)
            #if os(iOS)
            .presentationCompactAdaptation(.popover)
            #endif
        }
    }

    /// The box empties and the message shows in the conversation at once; a failure puts it back.
    private func send(steer: Bool = false, questionId: String? = nil, interruptWaiting: Bool = false) async {
        guard canSend else { return }
        if steer && (!canSteer || questionId != steerQuestionId || interruptWaiting != self.interruptWaiting) {
            error = "当前轮次已变更"
            return
        }
        deliveryNotice = nil
        let text = draft
        let submittedImages = images
        var entry: AgentPendingSend?
        sending = true; error = ""
        defer { sending = false }
        do {
            let message = try await model.imageMessage(session.key, text: text, images: submittedImages)
            if !steer && canSetOnSend {
                let applied = AgentDrafts.appliedModels[session.key]
                let wanted = chosenModel.isEmpty ? (applied == nil ? nil : catalog.current) : chosenModel
                if let wanted, wanted != applied {
                    try await model.send(session.key, text: "/model " + wanted)
                    AgentDrafts.appliedModels[session.key] = wanted
                    AgentDrafts.appliedEfforts[session.key] = nil
                }
            }
            if !steer && canSetOnSend, let level = resolvedEffort, AgentDrafts.appliedEfforts[session.key] != level {
                try await model.send(session.key, text: "/effort " + level)
                AgentDrafts.appliedEfforts[session.key] = level
            }
            let echo = AgentPendingSend(text: message, known: Set(model.transcript(session.key).items.map(\.id)))
            pending.append(echo)
            entry = echo
            if draft == text { draft = "" }
            if steer {
                deliveryNotice = try await model.steer(session.key, text: message, questionId: questionId, interruptWaiting: interruptWaiting)
            } else {
                try await model.send(session.key, text: message)
            }
            images.removeAll { submittedImages.contains($0) }
        } catch {
            if let entry {
                pending.removeAll { $0.id == entry.id }
                if draft.isEmpty { draft = text }
            }
            self.error = CliErrorText.text(for: error, fallback: "没能发送")
        }
    }

    private func interrupt() async {
        error = ""
        do { try await model.interrupt(session.key) } catch { self.error = CliErrorText.text(for: error) }
    }

    private func resume() async {
        sending = true; error = ""
        do {
            let level = canSetOnResume ? resolvedEffort : nil
            let requestedModel = canSetOnResume && !chosenModel.isEmpty ? chosenModel : nil
            let next = try await model.continueSession(session.key, effort: level, model: requestedModel)
            AgentDrafts.efforts[next] = effort
            AgentDrafts.appliedEfforts[next] = level
            AgentDrafts.models[next] = requestedModel
            AgentDrafts.appliedModels[next] = requestedModel
            AgentDrafts.images[next] = images.isEmpty ? nil : images
            onKeyChange(next)
        }
        catch { self.error = CliErrorText.text(for: error, fallback: "没能继续") }
        sending = false
    }
}

/// How full the session's context is: a ring that fills with the share of the window the last request used (amber from
/// 70%, red from 90%); dashed while nothing is known. Tapping shows the numbers.
struct AgentContextRing: View {
    let usage: CliContextUsage?
    @State private var open = false

    private var color: Color {
        switch CliContext.level(usage) {
        case .full: Color(hex: 0xC2410C)
        case .high: Theme.approval
        default: Theme.success
        }
    }

    var body: some View {
        Button { open.toggle() } label: {
            ZStack {
                if let share = CliContext.share(usage) {
                    Circle().stroke(Theme.border, lineWidth: 2.2)
                    Circle().trim(from: 0, to: max(0.04, share)).stroke(color, style: StrokeStyle(lineWidth: 2.2, lineCap: .round)).rotationEffect(.degrees(-90))
                } else {
                    Circle().stroke(Theme.muted, style: StrokeStyle(lineWidth: 1.4, dash: [2, 2]))
                }
            }
            .frame(width: 16, height: 16).padding(5).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(CliContext.summary(usage))
        .accessibilityLabel(CliContext.summary(usage))
        .popover(isPresented: $open, arrowEdge: .top) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("上下文").font(.system(size: 13, weight: .semibold))
                    Spacer()
                    if let share = CliContext.share(usage) { Text("\(Int((share * 100).rounded()))%").font(.system(size: 15, weight: .semibold)).monospacedDigit() }
                }
                if let share = CliContext.share(usage) {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Theme.wash)
                            Capsule().fill(color).frame(width: max(4, geo.size.width * share))
                        }
                    }
                    .frame(height: 6)
                }
                Text(detail).font(.caption).foregroundStyle(Theme.muted).monospacedDigit()
            }
            .padding(14).frame(width: 240)
            #if os(iOS)
            .presentationCompactAdaptation(.popover)
            #endif
        }
    }

    private var detail: String {
        guard let usage else { return "还没有记录：会话回复过一次后显示" }
        guard let window = usage.window else { return "已用 \(CliContext.tokens(usage.used)) tokens" }
        return "已用 \(CliContext.tokens(usage.used)) / \(CliContext.tokens(window)) tokens"
    }
}

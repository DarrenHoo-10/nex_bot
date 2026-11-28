import SwiftUI
import UniformTypeIdentifiers
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
    static var files: [CliSessionKey: [CliFileUpload]] = [:]
    static var goals: [CliSessionKey: String] = [:]
    static var models: [CliSessionKey: String] = [:]
    static var appliedModels: [CliSessionKey: String] = [:]
    static var efforts: [CliSessionKey: String] = [:]
    static var appliedEfforts: [CliSessionKey: String] = [:]
    /// The permission mode picked in the + menu, and whether the CLI still has to take it.
    static var permissions: [CliSessionKey: (mode: CliPermissionMode, pending: Bool)] = [:]
}

private enum AgentSidePaneMode: Hashable {
    case terminal
    case inspector
}

/// A message sent from this screen that the session's records do not hold yet: it shows at once, with the dots under it.
struct AgentPendingSend: Identifiable, Equatable {
    let id = UUID()
    var text: String
    var uploading = false
    var nativeQueued = false
    /// the items the transcript held when it was sent
    let known: Set<String>

    /// Still waiting: no new user item with its text, and nothing of the agent after it.
    func waiting(in items: [CliItem]) -> Bool {
        if uploading { return true }
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

private struct AgentRevision: Equatable {
    let messageId: String
    let text: String
}

/// One session: Conversation on the left (default open, composer strictly inside conversation),
/// plus an optional Right Side Pane holding the live Remote Terminal (kept mounted once opened)
/// or the Workspace Inspector (Git / Activity / Notes / Side Chats). Aligned to Windows/Web.
struct AgentSessionDetail: View {
    let model: CliAgentsModel
    let workspace: WorkspaceStore
    let key: CliSessionKey
    let openAssistant: (String) -> Void
    /// The session continues under another key (or user navigates to a lead/worker session).
    let onKeyChange: (CliSessionKey) -> Void

    @State private var forking = false
    @State private var forkItemId: String?
    @State private var branchedChat: CliForkResult?
    @State private var guides: [AgentGuide] = []
    @State private var pending: [AgentPendingSend] = []
    @State private var revision: AgentRevision?
    @State private var hiddenMessageIds: Set<String> = []
    @State private var failure: String?
    @State private var failuresSeen: Set<String>?
    @State private var openedAt = Date()
    @State private var expandedActivities: Set<String> = []

    // Right side pane & Team panel state
    @State private var sidePaneOpen = false
    @State private var sidePaneMode: AgentSidePaneMode = .inspector
    /// Once opened for this session, the terminal view stays mounted (hidden when closed) so PTY survives tab/panel toggles.
    @State private var terminalMounted = false
    @State private var inspectorTab: AgentWorkbenchTab = .git
    @State private var noteDraft: AgentNoteDraft?
    @State private var notes: [CliNote] = []
    @State private var teamPanelOpen = false

    private var session: CliSession? { model.sessions.first { $0.key == key } }

    var body: some View {
        Group {
            if let session {
                content(session)
            } else {
                Text("会话不存在").foregroundStyle(Theme.nexAgentMuted).frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Theme.nexAgentCanvas)
            }
        }
        .onAppear {
            model.openSession(key)
        }
        .onDisappear { model.closeSession(key) }
        .task(id: key) {
            notes = (try? await model.notes(for: key)) ?? []
        }
        .onChange(of: key) { _, _ in
            pending = []
            failuresSeen = nil
            openedAt = Date()
            revision = nil
            hiddenMessageIds = []
            terminalMounted = false
            teamPanelOpen = false
        }
        .onChange(of: model.transcript(key).items) { _, items in noteFailures(items) }
        .alert("模型调用失败", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("知道了", role: .cancel) { failure = nil }
        } message: {
            Text(failure ?? "")
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

    private func openTerminalPane() {
        terminalMounted = true
        sidePaneMode = .terminal
        sidePaneOpen = true
        teamPanelOpen = false
    }

    private func openInspector(_ tab: AgentWorkbenchTab) {
        inspectorTab = tab
        sidePaneMode = .inspector
        sidePaneOpen = true
        teamPanelOpen = false
    }

    private func content(_ session: CliSession) -> some View {
        let attach = CliSessions.canAttach(session)
        let cards = model.shownCards(key)
        let teamRuns = model.teamIndex.runsByLead[key] ?? []
        let workerBinding = model.teamIndex.workerBySession[key]
        let leadTitle: String = workerBinding.flatMap { b in
            model.sessions.first(where: { $0.key == b.run.leadKey }).map { model.displayTitle(for: $0) } ?? b.run.title
        } ?? ""
        let sideCount = model.sideSessions(of: key).count

        let conversationColumn = VStack(spacing: 0) {
            #if os(macOS)
            macHeader(session, attach: attach, teamRuns: teamRuns, sideCount: sideCount)
            #endif
            if let workerBinding {
                AgentTeamWorkerBanner(
                    binding: workerBinding,
                    leadTitle: leadTitle,
                    session: session,
                    pendingCount: model.pendingCounts[key] ?? 0,
                    onOpenLead: { onKeyChange($0) }
                )
            }
            AgentTranscript(
                model: model,
                key: key,
                expandedActivities: $expandedActivities,
                guides: guides.filter { $0.key == key },
                engine: session.engine,
                active: session.state == .running || session.state == .waiting,
                working: session.online && session.state == .running ? "执行中" : nil,
                pending: pending,
                hiddenIds: hiddenMessageIds,
                onSelectSession: { onKeyChange($0) },
                onEdit: { messageId, text in
                    if let prev = revision, prev.messageId != messageId { hiddenMessageIds.remove(prev.messageId) }
                    hiddenMessageIds.insert(messageId)
                    revision = AgentRevision(messageId: messageId, text: text)
                },
                branch: workspace.bots.isEmpty ? nil : { itemId in
                    forkItemId = itemId
                    forking = true
                },
                onNote: { item in
                    noteDraft = AgentNoteDraft(messageId: item.id, quote: item.text)
                    openInspector(.notes)
                }
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if !cards.isEmpty {
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(cards) { record in
                            AgentRequestCard(model: model, record: record)
                        }
                    }
                    .frame(maxWidth: 740)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 14).padding(.vertical, 6)
                }
                .frame(maxHeight: 300)
            }

            AgentComposer(
                model: model,
                session: session,
                pending: $pending,
                guides: $guides,
                notes: $notes,
                revision: $revision,
                onCancelRevision: {
                    if let rev = revision { hiddenMessageIds.remove(rev.messageId) }
                    revision = nil
                },
                onOpenNotes: { openInspector(.notes) },
                onKeyChange: { next in onKeyChange(next) }
            )
        }
        .background(Theme.nexAgentCanvas)

        #if os(macOS)
        return GeometryReader { geo in
            let wide = geo.size.width >= 900
            let paneWidth: CGFloat = wide
                ? (sidePaneMode == .terminal ? min(max(420, geo.size.width * 0.48), 680) : 312)
                : (sidePaneMode == .terminal ? min(geo.size.width - 40, 560) : min(geo.size.width - 40, 320))
            let showWidePane = wide && sidePaneOpen
            let showOverlay = !wide && sidePaneOpen
            ZStack(alignment: .trailing) {
                HStack(spacing: 0) {
                    conversationColumn
                        .frame(maxWidth: .infinity, maxHeight: .infinity)

                    if showWidePane {
                        Rectangle().fill(Theme.nexAgentBorder).frame(width: 1)
                        Color.clear.frame(width: paneWidth)
                    }
                }

                if showOverlay {
                    Color.black.opacity(0.22)
                        .ignoresSafeArea()
                        .onTapGesture { sidePaneOpen = false }
                }

                // Single structural slot keeps AgentTerminalPane mounted across wide/narrow resizes and open/close toggles so PTY never drops.
                sidePaneContent(session, attach: attach)
                    .frame(width: paneWidth, height: geo.size.height)
                    .shadow(color: showOverlay ? .black.opacity(0.18) : .clear, radius: showOverlay ? 16 : 0, x: showOverlay ? -4 : 0)
                    .opacity(sidePaneOpen ? 1 : 0)
                    .allowsHitTesting(sidePaneOpen)
                    .accessibilityHidden(!sidePaneOpen)
            }
        }
        #else
        return ZStack {
            conversationColumn
                .navigationTitle(model.displayTitle(for: session))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        let activeRun = teamRuns.first(where: { $0.status.isLive })
                        let visibleWorkers = activeRun?.visibleWorkers ?? []
                        let hasVisibleHistory = teamRuns.contains { $0.id != activeRun?.id && !$0.visibleWorkers.isEmpty }
                        if activeRun != nil || hasVisibleHistory {
                            Button { teamPanelOpen = true } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "network")
                                    if !visibleWorkers.isEmpty { Text("\(visibleWorkers.count)").font(.caption.weight(.semibold)) }
                                }
                                .foregroundStyle(Theme.nexAgentAccent)
                            }
                            .accessibilityLabel("协作")
                        }
                        if attach {
                            Button { openTerminalPane() } label: {
                                Image(systemName: "terminal")
                                    .foregroundStyle(sidePaneOpen && sidePaneMode == .terminal ? Theme.nexAgentAccent : Theme.nexAgentInk)
                            }
                            .accessibilityLabel("远程终端")
                        }
                        Button { openInspector(.git) } label: {
                            Image(systemName: "sidebar.right")
                                .foregroundStyle(Theme.nexAgentInk)
                        }
                        .accessibilityLabel("工作区面板")
                        if !workspace.bots.isEmpty {
                            Menu {
                                Button("交给助手", systemImage: "arrow.triangle.branch") { forking = true }
                            } label: { Image(systemName: "ellipsis.circle") }
                        }
                    }
                }

            // Full-screen overlay for Remote Terminal on iOS keeps PTY alive once opened!
            if attach && terminalMounted {
                VStack(spacing: 0) {
                    HStack {
                        Label("远程终端", systemImage: "terminal").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.nexAgentInk)
                        Spacer()
                        Button("返回对话") { sidePaneOpen = false }
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Theme.nexAgentAccent)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Theme.nexAgentSurface)
                    Divider().overlay(Theme.nexAgentBorder)
                    AgentTerminalPane(model: model, key: key, onClose: { sidePaneOpen = false })
                }
                .background(Theme.nexAgentCanvas)
                .opacity(sidePaneOpen && sidePaneMode == .terminal ? 1 : 0)
                .allowsHitTesting(sidePaneOpen && sidePaneMode == .terminal)
                .accessibilityHidden(!(sidePaneOpen && sidePaneMode == .terminal))
            }
        }
        .sheet(isPresented: Binding(get: { sidePaneOpen && sidePaneMode == .inspector }, set: { if !$0 { sidePaneOpen = false } })) {
            AgentWorkbenchInspector(
                model: model,
                session: session,
                tab: $inspectorTab,
                noteDraft: $noteDraft,
                notes: $notes,
                onOpenTerminal: attach ? { openTerminalPane() } : nil,
                onClose: { sidePaneOpen = false }
            )
        }
        .sheet(isPresented: $teamPanelOpen) {
            NavigationStack {
                AgentTeamPanel(
                    runs: teamRuns,
                    selectedKey: key,
                    onOpenSession: { next in teamPanelOpen = false; onKeyChange(next) },
                    onPause: { try await model.pauseTeam($0) },
                    onResume: { try await model.resumeTeam($0) },
                    onCancel: { try await model.cancelTeam($0) },
                    onStopWorker: { try await model.stopTeamWorker(runId: $0, workerName: $1) }
                )
                .navigationTitle("协作")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { teamPanelOpen = false } } }
            }
            .presentationDetents([.medium, .large])
        }
        #endif
    }

    #if os(macOS)
    private func sidePaneContent(_ session: CliSession, attach: Bool) -> some View {
        ZStack {
            if attach && terminalMounted {
                VStack(spacing: 0) {
                    HStack(spacing: 6) {
                        sideTabPill("终端", icon: "terminal", active: sidePaneMode == .terminal) { sidePaneMode = .terminal }
                        sideTabPill("工作区", icon: "sidebar.right", active: sidePaneMode == .inspector) { sidePaneMode = .inspector }
                        Spacer()
                        Button { sidePaneOpen = false } label: {
                            Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.nexAgentMuted)
                                .frame(width: 24, height: 24).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help("收起右侧面板")
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Theme.nexAgentSurface)
                    Divider().overlay(Theme.nexAgentBorder)
                    AgentTerminalPane(model: model, key: key, onClose: { sidePaneOpen = false })
                }
                .background(Theme.nexAgentCanvas)
                .opacity(sidePaneMode == .terminal ? 1 : 0)
                .allowsHitTesting(sidePaneMode == .terminal)
                .accessibilityHidden(sidePaneMode != .terminal)
            }

            if sidePaneOpen && sidePaneMode == .inspector {
                AgentWorkbenchInspector(
                    model: model,
                    session: session,
                    tab: $inspectorTab,
                    noteDraft: $noteDraft,
                    notes: $notes,
                    onOpenTerminal: attach ? { openTerminalPane() } : nil,
                    onClose: { sidePaneOpen = false }
                )
            }
        }
    }

    private func sideTabPill(_ title: String, icon: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 11))
                Text(title).font(.system(size: 12, weight: active ? .semibold : .regular))
            }
            .padding(.horizontal, 8).padding(.vertical, 5)
            .foregroundStyle(active ? Theme.nexAgentAccent : Theme.nexAgentMuted)
            .background(active ? Theme.nexAgentSoft : .clear, in: RoundedRectangle(cornerRadius: 7))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func macHeader(_ session: CliSession, attach: Bool, teamRuns: [CliTeamRunView], sideCount: Int) -> some View {
        let tone = CliSessions.tone(session)
        let metaText = [agentName(session.engine), CliSessions.projectLabel(session), session.gitBranch ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
        let activeTeamRun = teamRuns.first { $0.status.isLive }
        let visibleActiveWorkers = activeTeamRun?.visibleWorkers ?? []
        let hasVisibleHistoryRuns = teamRuns.contains { $0.id != activeTeamRun?.id && !$0.visibleWorkers.isEmpty }
        let showTeamControl = activeTeamRun != nil || hasVisibleHistoryRuns
        let workerCount = visibleActiveWorkers.count
        let teamDotColor: Color? = activeTeamRun.flatMap { run in
            if run.limitHit != nil || (run.heldCount ?? 0) > 0 || visibleActiveWorkers.contains(where: { $0.status == .waiting }) { return Theme.approval }
            if run.status == .paused { return Theme.approval }
            if visibleActiveWorkers.contains(where: { $0.status.isWorking }) { return Theme.nexAgentAccent }
            return nil
        }

        return VStack(spacing: 0) {
            HStack(spacing: 10) {
                AgentEngineIcon(engine: session.engine, tone: tone, size: 20)
                Text(model.displayTitle(for: session))
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.nexAgentInk)
                    .lineLimit(1)
                    .help(metaText)
                if let branch = session.gitBranch, !branch.isEmpty {
                    Text(branch)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.nexAgentMuted)
                        .lineLimit(1)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Theme.nexAgentInset, in: Capsule())
                }
                Spacer(minLength: 8)
                if tone == .running || tone == .offline || tone == .stopped {
                    CliChip(text: CliSessions.statusLabel(session), tone: tone)
                }

                if showTeamControl {
                    Button {
                        teamPanelOpen.toggle()
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "network").font(.system(size: 12))
                            Text(activeTeamRun != nil && workerCount > 0 ? "协作 \(workerCount)" : "协作")
                                .font(.system(size: 12, weight: .medium))
                            if let dot = teamDotColor {
                                Circle().fill(dot).frame(width: 6, height: 6)
                            }
                        }
                        .foregroundStyle(activeTeamRun != nil ? Theme.nexAgentAccent : Theme.nexAgentMuted)
                        .padding(.horizontal, 9).padding(.vertical, 4)
                        .background(teamPanelOpen ? Theme.nexAgentSoft : Theme.nexAgentInset, in: Capsule())
                        .overlay(Capsule().strokeBorder(activeTeamRun != nil ? Theme.nexAgentAccent.opacity(0.3) : Theme.nexAgentBorder))
                    }
                    .buttonStyle(.plain)
                    .popover(isPresented: $teamPanelOpen, arrowEdge: .bottom) {
                        AgentTeamPanel(
                            runs: teamRuns,
                            selectedKey: key,
                            onOpenSession: { next in teamPanelOpen = false; onKeyChange(next) },
                            onPause: { try await model.pauseTeam($0) },
                            onResume: { try await model.resumeTeam($0) },
                            onCancel: { try await model.cancelTeam($0) },
                            onStopWorker: { try await model.stopTeamWorker(runId: $0, workerName: $1) }
                        )
                        .frame(width: 360, height: 420)
                    }
                }

                if sideCount > 0 {
                    Button { openInspector(.sideChats) } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "bubble.left.and.bubble.right").font(.system(size: 11.5))
                            Text("\(sideCount)").font(.system(size: 11.5, weight: .medium))
                        }
                        .foregroundStyle(Theme.nexAgentMuted)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(Theme.nexAgentInset, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .help("侧边会话 \(sideCount)")
                }

                if attach {
                    Button {
                        if sidePaneOpen && sidePaneMode == .terminal { sidePaneOpen = false }
                        else { openTerminalPane() }
                    } label: {
                        Image(systemName: "terminal")
                            .font(.system(size: 13))
                            .foregroundStyle(sidePaneOpen && sidePaneMode == .terminal ? Theme.nexAgentAccent : Theme.nexAgentMuted)
                            .frame(width: 28, height: 28)
                            .background(sidePaneOpen && sidePaneMode == .terminal ? Theme.nexAgentSoft : .clear, in: RoundedRectangle(cornerRadius: 7))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(sidePaneOpen && sidePaneMode == .terminal ? "收起远程终端" : "打开远程终端")
                    .accessibilityLabel("远程终端")
                }

                if !workspace.bots.isEmpty {
                    Button { forking = true } label: {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.nexAgentMuted)
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("交给助手")
                    .accessibilityLabel("交给助手")
                }

                Button {
                    if sidePaneOpen && sidePaneMode == .inspector { sidePaneOpen = false }
                    else { openInspector(inspectorTab) }
                } label: {
                    Image(systemName: "sidebar.right")
                        .font(.system(size: 13.5))
                        .foregroundStyle(sidePaneOpen && sidePaneMode == .inspector ? Theme.nexAgentAccent : Theme.nexAgentMuted)
                        .frame(width: 28, height: 28)
                        .background(sidePaneOpen && sidePaneMode == .inspector ? Theme.nexAgentSoft : .clear, in: RoundedRectangle(cornerRadius: 7))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(sidePaneOpen && sidePaneMode == .inspector ? "收起工作区面板" : "展开 Git 工作区 / 笔记 / 侧聊")
                .accessibilityLabel("Git 工作区")
            }
            .padding(.horizontal, 18).padding(.vertical, 10)
            .background(Theme.nexAgentSurface)
            Divider().overlay(Theme.nexAgentBorder)
        }
    }
    #endif

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
}

// MARK: Terminal (with FindBar, OSC 52, Mac shortcuts & Context Menu)

private struct AgentTerminalPane: View {
    let model: CliAgentsModel
    let key: CliSessionKey
    var onClose: (() -> Void)? = nil
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage(CliTerminalPrefKeys.theme) private var themeRaw = CliTermThemeID.ink.rawValue
    @AppStorage(CliTerminalPrefKeys.fontSize) private var fontSize = CliTerminalPrefKeys.defaultFontSize
    @AppStorage(CliTerminalPrefKeys.cursorStyle) private var cursorStyleRaw = CliTermCursorStyle.block.rawValue
    @AppStorage(CliTerminalPrefKeys.cursorBlink) private var cursorBlink = true
    @AppStorage(CliTerminalPrefKeys.keyBar) private var showKeyBar = CliTerminalPrefKeys.defaultKeyBar
    @AppStorage(CliTerminalPrefKeys.optionAsMeta) private var optionAsMeta = true
    @AppStorage(CliTerminalPrefKeys.shortcuts) private var shortcutsJSON = ""

    @State private var controller: CliTerminalController?
    @State private var actions = CliTerminalActions()
    @State private var mods = CliTermModifiers()
    @State private var showSettings = false
    @State private var findOpen = false
    @State private var findQuery = ""
    @State private var findCaseSensitive = false
    @State private var findMatches: [CliTermSearchMatch] = []
    @State private var findIndex = 0
    @FocusState private var findFocused: Bool
    @State private var pickingFile = false
    @State private var uploadingText: String?
    @State private var dropping = false
    @State private var pendingPaste: String?
    @State private var toastText: String?
    @State private var toastError = false
    @State private var toastTask: Task<Void, Never>?

    private var style: CliTerminalStyle {
        CliTerminalStyle(
            theme: CliTermThemeID.named(themeRaw),
            fontSize: CGFloat(fontSize),
            cursorStyle: CliTermCursorStyle.named(cursorStyleRaw),
            cursorBlink: cursorBlink,
            optionAsMeta: optionAsMeta,
            dark: colorScheme == .dark
        )
    }

    var body: some View {
        let palette = style.palette
        VStack(spacing: 0) {
            if let controller {
                toolbar(controller)
                if findOpen { findBar }
                GeometryReader { proxy in
                    #if os(macOS)
                    CliTerminalView(
                        controller: controller,
                        actions: actions,
                        width: proxy.size.width,
                        control: controller.wantsControl,
                        style: style,
                        transformInput: transformInput,
                        onClipboardCopy: { showToast("已通过终端复制到剪贴板") },
                        onOpenFind: { openFindBar() },
                        onPasteCommand: { pasteClipboard(controller) },
                        onCopyCommand: {
                            if actions.copySelection() { showToast("已复制到剪贴板") }
                        }
                    )
                    .id(ObjectIdentifier(controller))
                    .padding(6)
                    #else
                    CliTerminalView(
                        controller: controller,
                        actions: actions,
                        width: proxy.size.width,
                        control: controller.wantsControl,
                        style: style,
                        transformInput: transformInput,
                        onPinchFontSize: { next in fontSize = Double(next) },
                        onClipboardCopy: { showToast("已通过终端复制到剪贴板") }
                    )
                    .id(ObjectIdentifier(controller))
                    .padding(6)
                    #endif
                }
                .opacity(isStale(controller.status) ? 0.52 : 1)
                .saturation(isStale(controller.status) ? 0.45 : 1)
                .animation(.easeOut(duration: 0.2), value: controller.status)
                .overlay(alignment: .top) {
                    VStack(spacing: 6) {
                        banners(controller)
                    }
                    .padding(8)
                }
                .overlay(alignment: .bottom) {
                    if let toastText {
                        Text(toastText)
                            .font(.caption)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(toastError ? Theme.danger.opacity(0.95) : SwiftUI.Color.black.opacity(0.84), in: Capsule())
                            .padding(.bottom, 12)
                            .transition(.opacity)
                            .allowsHitTesting(false)
                    }
                }
                .background(SwiftUI.Color(hex: palette.background))
                .overlay {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(dropping ? Theme.nexAgentAccent : (palette.isDark ? SwiftUI.Color.white.opacity(0.08) : Theme.nexAgentBorder), lineWidth: dropping ? 2 : 1)
                }
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .padding(.horizontal, 10)
                .padding(.bottom, showKeyBar ? 6 : 8)
                #if os(macOS)
                .onDrop(of: [.fileURL], isTargeted: $dropping) { providers in
                    handleFileDrop(providers, controller: controller)
                }
                #endif

                if showKeyBar {
                    CliTerminalKeyBar(
                        mods: $mods,
                        disabled: controller.status != .controlling,
                        isDark: palette.isDark,
                        shortcuts: CliTermShortcuts.decode(shortcutsJSON),
                        onSendKey: { keyName in controller.sendKey(keyName, appCursor: actions.isAppCursor) },
                        onSendBare: { keyName in controller.sendKey(keyName, appCursor: actions.isAppCursor) },
                        onTypeCommand: { text, run in controller.sendText(run ? text + "\r" : text) },
                        onCopy: {
                            if actions.copySelection() { showToast("已复制到剪贴板") }
                            else { showToast("请先选中终端文本", error: true) }
                        },
                        onPaste: { pasteClipboard(controller) },
                        onPickFile: { pickingFile = true },
                        onOpenSettings: { showSettings = true },
                        onToggleKeyboard: { actions.toggleKeyboard() }
                    )
                    .padding(.horizontal, 10).padding(.bottom, 8)
                }
            } else {
                Text("正在连接").font(.footnote).foregroundStyle(Theme.nexAgentMuted).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear { create() }
        .onChange(of: model.connected) { _, _ in create() }
        .onChange(of: model.streamRevision) { _, _ in recreate() }
        .onChange(of: findQuery) { _, _ in recomputeFind(jumpToLast: true) }
        .onChange(of: findCaseSensitive) { _, _ in recomputeFind(jumpToLast: false) }
        .onDisappear {
            toastTask?.cancel()
            controller?.stop()
            model.attach(nil)
            controller = nil
        }
        .sheet(isPresented: $showSettings) {
            CliTerminalSettingsView()
        }
        .fileImporter(isPresented: $pickingFile, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard let controller else { return }
            switch result {
            case .failure(let cause): showToast(cause.localizedDescription, error: true)
            case .success(let urls): Task { await uploadURLs(urls, controller: controller) }
            }
        }
        .alert("粘贴多行内容？", isPresented: Binding(get: { pendingPaste != nil }, set: { if !$0 { pendingPaste = nil } })) {
            Button("取消", role: .cancel) { pendingPaste = nil }
            Button("粘贴") {
                if let text = pendingPaste, let controller {
                    controller.sendInput(CliTermPaste.pasteData(text))
                }
                pendingPaste = nil
            }
        } message: {
            if let text = pendingPaste {
                Text("即将粘贴 \(CliTermPaste.lineCount(text)) 行内容到终端。")
            }
        }
    }

    private func openFindBar() {
        if let sel = actions.selectionText?.trimmingCharacters(in: .whitespacesAndNewlines),
           !sel.isEmpty, !sel.contains("\n"), !sel.contains("\r") {
            findQuery = String(sel.prefix(200))
        }
        findOpen = true
        recomputeFind(jumpToLast: true)
        findFocused = true
    }

    private func recomputeFind(jumpToLast: Bool) {
        findMatches = actions.findMatches(query: findQuery, caseSensitive: findCaseSensitive)
        if findMatches.isEmpty {
            findIndex = 0
        } else if jumpToLast {
            findIndex = findMatches.count - 1
        } else {
            findIndex = min(findIndex, findMatches.count - 1)
        }
    }

    private var findBar: some View {
        let label: String = findQuery.isEmpty ? "" : findMatches.isEmpty ? "无结果" : "\(findIndex + 1)/\(findMatches.count)"
        let currentLine = findMatches.indices.contains(findIndex) ? findMatches[findIndex].lineText : nil
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 11.5)).foregroundStyle(Theme.nexAgentMuted)
                TextField("在终端输出中查找…", text: $findQuery)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12.5))
                    .focused($findFocused)
                    .onSubmit {
                        if !findMatches.isEmpty { findIndex = (findIndex + 1) % findMatches.count }
                    }
                    #if os(macOS)
                    .onExitCommand { findOpen = false; actions.focus() }
                    #endif
                if !label.isEmpty {
                    Text(label).font(.system(size: 11, design: .monospaced)).foregroundStyle(findMatches.isEmpty ? Theme.danger : Theme.nexAgentMuted)
                }
                Button { findCaseSensitive.toggle() } label: {
                    Text("Aa").font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(findCaseSensitive ? Theme.nexAgentAccent : Theme.nexAgentMuted)
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(findCaseSensitive ? Theme.nexAgentSoft : .clear, in: RoundedRectangle(cornerRadius: 4))
                }
                .buttonStyle(.plain)
                .help("区分大小写")
                Button {
                    guard !findMatches.isEmpty else { return }
                    findIndex = (findIndex - 1 + findMatches.count) % findMatches.count
                } label: { Image(systemName: "chevron.up").font(.system(size: 11)) }
                .buttonStyle(.plain).foregroundStyle(Theme.nexAgentMuted).disabled(findMatches.isEmpty)
                Button {
                    guard !findMatches.isEmpty else { return }
                    findIndex = (findIndex + 1) % findMatches.count
                } label: { Image(systemName: "chevron.down").font(.system(size: 11)) }
                .buttonStyle(.plain).foregroundStyle(Theme.nexAgentMuted).disabled(findMatches.isEmpty)
                Button { findOpen = false; actions.focus() } label: {
                    Image(systemName: "xmark").font(.system(size: 11))
                }
                .buttonStyle(.plain).foregroundStyle(Theme.nexAgentMuted)
            }
            if let currentLine {
                HStack(spacing: 6) {
                    Text(currentLine).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.nexAgentInk).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 4)
                    Button("复制行") {
                        #if os(macOS)
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(currentLine, forType: .string)
                        #else
                        UIPasteboard.general.string = currentLine
                        #endif
                        showToast("已复制匹配行")
                    }
                    .buttonStyle(.plain).font(.system(size: 10.5, weight: .medium)).foregroundStyle(Theme.nexAgentAccent)
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Theme.nexAgentBorder))
        .padding(.horizontal, 10).padding(.bottom, 6)
    }

    private func create() {
        guard controller == nil, let made = model.makeTerminal(key: key, mode: .control) else { return }
        controller = made
        model.attach(made)
    }

    private func recreate() {
        let previousMode: CliTermMode = controller?.wantsControl == false ? .observe : .control
        controller?.stop()
        model.attach(nil)
        controller = nil
        guard let made = model.makeTerminal(key: key, mode: previousMode) else { return }
        controller = made
        model.attach(made)
    }

    private func isStale(_ status: CliTermStatus) -> Bool {
        status == .reconnecting || status == .closed
    }

    private func statusColor(_ status: CliTermStatus) -> SwiftUI.Color {
        switch status {
        case .controlling: Theme.success
        case .observing: Theme.brand
        case .connecting, .reconnecting: Theme.approval
        case .closed: Theme.danger
        }
    }

    private func toolbar(_ controller: CliTerminalController) -> some View {
        let mode = Binding<CliTermMode>(get: { controller.wantsControl ? .control : .observe }, set: { controller.setMode($0) })
        let status = controller.status
        let dims = controller.state.cols > 0 && controller.state.rows > 0 ? "\(controller.state.cols)×\(controller.state.rows)" : ""
        return HStack(spacing: 8) {
            PillTabs(items: [CliTermMode.control, .observe], title: { $0 == .control ? "控制" : "只看" }, selection: mode)
                .frame(maxWidth: 112)

            HStack(spacing: 5) {
                Circle().fill(statusColor(status)).frame(width: 7, height: 7)
                Text(status.text).font(.caption).foregroundStyle(Theme.nexAgentMuted).lineLimit(1)
                if !dims.isEmpty {
                    Text(dims).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.nexAgentMuted.opacity(0.85)).lineLimit(1)
                }
            }

            Spacer(minLength: 4)

            HStack(spacing: 3) {
                toolbarIcon("magnifyingglass", label: "查找 (⌘F)", active: findOpen) {
                    if findOpen { findOpen = false; actions.focus() } else { openFindBar() }
                }
                toolbarIcon("keyboard", label: showKeyBar ? "隐藏快捷键栏" : "显示快捷键栏", active: showKeyBar) {
                    showKeyBar.toggle()
                }
                toolbarIcon("slider.horizontal.3", label: "终端设置", active: showSettings) {
                    showSettings = true
                }
                toolbarIcon("arrow.clockwise", label: "重新连接", active: false) {
                    controller.reconnect()
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
    }

    private func toolbarIcon(_ symbol: String, label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(active ? Theme.nexAgentAccent : Theme.nexAgentMuted)
                .frame(width: 28, height: 28)
                .background(active ? Theme.nexAgentSoft : SwiftUI.Color.clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private func banners(_ controller: CliTerminalController) -> some View {
        let status = controller.status
        if status == .reconnecting {
            bannerRow("正在重新连接…", tone: .warn, button: "立即重试") { controller.reconnect() }
        }
        if status == .closed {
            let reason = controller.state.errorCode.flatMap { CliErrorText.byCode[$0] } ?? CliTermState.closeReasonText(controller.state.reason)
            bannerRow(reason.isEmpty ? "终端已断开" : reason, tone: .danger, button: "重新连接") { controller.reconnect() }
        }
        if status == .observing && controller.controlDeclined {
            bannerRow("暂未取得终端控制权", tone: .warn, button: "重新接管") { controller.reconnect(mode: .control) }
        }
        if let uploadingText {
            bannerRow(uploadingText, tone: .info, button: nil, action: nil)
        }
    }

    private enum BannerTone { case info, warn, danger }

    private func bannerRow(_ text: String, tone: BannerTone, button: String?, action: (() -> Void)?) -> some View {
        HStack(spacing: 8) {
            Text(text)
                .font(.caption)
                .foregroundStyle(tone == .danger ? Theme.danger : Theme.nexAgentInk)
                .lineLimit(1)
            Spacer(minLength: 4)
            if let button, let action {
                Button(button, action: action)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .background(Theme.nexAgentSolid, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(tone == .danger ? Theme.danger.opacity(0.45) : tone == .warn ? Theme.approval.opacity(0.45) : Theme.nexAgentBorder)
        )
        .shadow(color: .black.opacity(0.18), radius: 8, y: 3)
    }

    private func transformInput(_ raw: Data, _ appCursor: Bool) -> Data {
        guard mods.active else { return raw }
        if let keyName = CliTermKeyEncoder.keyName(for: raw),
           let encoded = CliTermKeyEncoder.encode(mods.apply(keyName), appCursor: appCursor) {
            mods.pressed()
            return encoded
        }
        if let str = String(data: raw, encoding: .utf8), str.count == 1, let ch = str.first {
            let mapped = mods.typed(ch)
            mods.pressed()
            if let key = mapped.key, let encoded = CliTermKeyEncoder.encode(key, appCursor: appCursor) { return encoded }
            if let text = mapped.text { return Data(text.utf8) }
        }
        return raw
    }

    private func pasteClipboard(_ controller: CliTerminalController) {
        guard controller.status == .controlling else {
            showToast("请先切换到控制模式", error: true)
            return
        }
        #if os(macOS)
        let pb = NSPasteboard.general
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            Task { await uploadURLs(urls, controller: controller) }
            return
        }
        if let text = pb.string(forType: .string), !text.isEmpty {
            submitPaste(text, controller: controller)
            return
        }
        if let png = pb.data(forType: .png) {
            Task { await uploadData([(name: "image.png", data: png)], controller: controller) }
            return
        }
        if let tiff = pb.data(forType: .tiff),
           let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            Task { await uploadData([(name: "image.png", data: png)], controller: controller) }
            return
        }
        #else
        if let text = UIPasteboard.general.string, !text.isEmpty {
            submitPaste(text, controller: controller)
            return
        }
        if let img = UIPasteboard.general.image?.pngData() {
            Task { await uploadData([(name: "image.png", data: img)], controller: controller) }
            return
        }
        #endif
        showToast("剪贴板为空", error: true)
    }

    private func submitPaste(_ text: String, controller: CliTerminalController) {
        if CliTermPaste.lineCount(text) > 1 {
            pendingPaste = text
        } else {
            controller.sendInput(CliTermPaste.pasteData(text))
        }
    }

    #if os(macOS)
    private func handleFileDrop(_ providers: [NSItemProvider], controller: CliTerminalController) -> Bool {
        let matching = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }
        guard !matching.isEmpty else { return false }
        let expected = matching.count
        let (stream, continuation) = AsyncStream<URL?>.makeStream()
        for provider in matching {
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                if let data = item as? Data, let url = URL(dataRepresentation: data, relativeTo: nil) {
                    continuation.yield(url)
                } else if let url = item as? URL {
                    continuation.yield(url)
                } else {
                    continuation.yield(nil)
                }
            }
        }
        Task { @MainActor in
            var urls: [URL] = []
            var seen = 0
            for await url in stream {
                if let url { urls.append(url) }
                seen += 1
                if seen >= expected { break }
            }
            continuation.finish()
            if !urls.isEmpty { await uploadURLs(urls, controller: controller) }
        }
        return true
    }
    #endif

    private func uploadURLs(_ urls: [URL], controller: CliTerminalController) async {
        var files: [(name: String, data: Data)] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey]) {
                if values.isDirectory == true { showToast("不支持直接上传文件夹", error: true); continue }
                if let size = values.fileSize, size > CoreClient.cliMaxAttachBytes { showToast("附件不能超过 8 MB", error: true); continue }
            }
            guard let data = try? Data(contentsOf: url, options: .mappedIfSafe), !data.isEmpty else {
                showToast("无法读取文件 \(url.lastPathComponent)", error: true)
                continue
            }
            files.append((name: url.lastPathComponent, data: data))
        }
        if !files.isEmpty { await uploadData(files, controller: controller) }
    }

    private func uploadData(_ files: [(name: String, data: Data)], controller: CliTerminalController) async {
        guard controller.status == .controlling else { showToast("请先切换到控制模式再上传文件", error: true); return }
        uploadingText = files.count == 1 ? "正在上传 \(files[0].name)…" : "正在上传 \(files[0].name) 等 \(files.count) 个文件…"
        defer { uploadingText = nil }
        var paths: [String] = []
        for file in files {
            do {
                let remotePath = try await model.attachTerminalFile(key, name: file.name, data: file.data)
                paths.append(remotePath)
            } catch {
                showToast("\(file.name) 上传失败：\(CliErrorText.text(for: error))", error: true)
            }
        }
        guard !paths.isEmpty else { return }
        guard controller.status == .controlling else { showToast("终端控制已结束，文件未填入", error: true); return }
        controller.sendInput(CliTermPaste.pasteData(CliTermPaste.pastedPaths(paths)))
    }

    private func showToast(_ text: String, error: Bool = false) {
        toastTask?.cancel()
        toastText = text
        toastError = error
        toastTask = Task {
            try? await Task.sleep(for: .seconds(2.4))
            guard !Task.isCancelled else { return }
            toastText = nil
        }
    }
}

// MARK: Transcript

private struct AgentGuide {
    let key: CliSessionKey
    let id: String
    let text: String
    let at: Int
    let known: Set<String>
    let after: String?
    let tail: CliItem?
    var uncertain = false

    static func timeline(_ items: [CliItem], _ guides: [Self]) -> [CliItem] {
        guard let first = guides.first else { return items }
        var echoes = Set<String>()
        var rows: [(item: CliItem, rank: Int)] = []
        for (index, guide) in guides.enumerated() {
            let boundary = guide.after.flatMap { id in items.firstIndex { $0.id == id } } ?? -1
            let echo = items.dropFirst(boundary + 1).first { $0.kind == .user && $0.text == guide.text && !guide.known.contains($0.id) && !echoes.contains($0.id) }
            if let echo { echoes.insert(echo.id) }
            var row = echo ?? CliItem(id: "guide:" + guide.id, ts: guide.at, kind: .user, text: guide.text)
            row.ts = guide.at
            row.queued = false
            rows.append((row, 2 * index + 1))
        }
        for item in items where !echoes.contains(item.id) {
            var rank = 2 * (guides.firstIndex { $0.known.contains(item.id) } ?? guides.count)
            guard item.kind == .assistant else { rows.append((item, rank)); continue }
            var part = item
            var offset = item.text.startIndex
            var startAt = Int.min
            for (index, guide) in guides.enumerated() {
                guard let tail = guide.tail, tail.id == item.id, item.text.hasPrefix(tail.text) else { continue }
                let cut = item.text.index(item.text.startIndex, offsetBy: tail.text.count)
                guard cut >= offset else { continue }
                if cut > offset {
                    part.ts = min(guide.at, max(startAt, tail.ts))
                    part.text = String(item.text[offset..<cut])
                    rows.append((part, rank))
                }
                offset = cut
                part.id = "after-guide:" + guide.id
                startAt = guide.at
                part.ts = max(item.ts, guide.at)
                rank = 2 * index + 2
            }
            if offset < item.text.endIndex {
                part.text = String(item.text[offset...])
                rows.append((part, rank))
            }
        }
        var before: [CliItem] = []
        var after: [(item: CliItem, rank: Int)] = []
        for row in rows {
            if row.item.ts < first.at || first.known.contains(row.item.id) { before.append(row.item) }
            else { after.append(row) }
        }
        return before + after.sorted { ($0.item.ts, $0.rank) < ($1.item.ts, $1.rank) }.map(\.item)
    }
}

private struct AgentTranscript: View {
    let model: CliAgentsModel
    let key: CliSessionKey
    @Binding var expandedActivities: Set<String>
    var guides: [AgentGuide] = []
    var engine: CliEngine = .claude
    var active = false
    var working: String?
    var pending: [AgentPendingSend] = []
    var hiddenIds: Set<String> = []
    var onSelectSession: ((CliSessionKey) -> Void)?
    var onEdit: ((String, String) -> Void)?
    var branch: ((String) -> Void)?
    var onNote: ((CliItem) -> Void)?
    @State private var lateReceipt: String?
    @State private var following = true

    var body: some View {
        let t = model.transcript(key)
        let sent = pending.filter { $0.waiting(in: t.items) }
        let echo = t.items.contains { $0.kind == .user } ? nil : model.echoes[key]
        let receipt = model.sessions.first { $0.key == key }
        let codexPending = engine == .codex && receipt?.online == true && (receipt?.state == .idle || receipt?.state == .stopped) && (echo != nil || !sent.isEmpty)
        let nativeQueued = sent.last?.nativeQueued ?? echo?.nativeQueued ?? false
        let receiptID = codexPending && !nativeQueued ? (sent.last?.id.uuidString ?? key) : nil
        let delivery = sent.contains(where: \.uploading) ? "正在上传附件" : codexPending ? (nativeQueued ? "Codex 已接收，等待开始" : lateReceipt == receiptID ? "Codex 尚未确认收件，请查看终端" : "等待 Codex 确认收件") : nil
        let working = delivery == nil ? (self.working ?? (sent.isEmpty && echo == nil ? nil : "等待回复")) : nil
        let timeline = AgentGuide.timeline(t.items, guides).filter { !hiddenIds.contains($0.id) }
        let blocks = CliTranscript.group(timeline)
        let rows = CliTranscript.rows(timeline, active: active)
        let completed = CliTranscript.completedReplies(t.items, active: active)
        let conclusions = CliTranscript.replyTails(blocks).intersection(completed)
        let lastUserId = timeline.last(where: { $0.kind == .user && !$0.queued })?.id

        Group {
            if blocks.isEmpty && (echo != nil || !sent.isEmpty) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if let echo { AgentEchoBubble(text: echo.text, loadImage: model.downloadImage, loadOriginalImage: model.downloadOriginalImage) }
                        ForEach(sent) { AgentEchoBubble(text: $0.text, loadImage: model.downloadImage, loadOriginalImage: model.downloadOriginalImage) }
                        if let delivery { Text(delivery).font(.caption).foregroundStyle(Theme.nexAgentMuted) }
                        if let working { AgentWorkingRow(engine: engine, label: working, byline: true) }
                    }
                    .frame(maxWidth: 820)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                }
            } else if let error = t.error, t.items.isEmpty {
                VStack(spacing: 8) {
                    Text(error).font(.footnote).foregroundStyle(Theme.danger)
                    Button("重试") { model.reloadTranscript(key) }.buttonStyle(.bordered)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !t.loaded {
                Text("正在读取…").font(.footnote).foregroundStyle(Theme.nexAgentMuted).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if blocks.isEmpty {
                Text("暂无记录").font(.footnote).foregroundStyle(Theme.nexAgentMuted).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    ZStack(alignment: .bottomTrailing) {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 12) {
                                if t.more {
                                    Button(t.loadingOlder ? "正在读取…" : t.olderError == nil ? "加载更早的记录" : "重试加载更早的记录") { Task { await model.loadOlder(key) } }
                                        .buttonStyle(.plain).font(.caption).foregroundStyle(Theme.nexAgentAccent).disabled(t.loadingOlder)
                                        .frame(maxWidth: .infinity)
                                        .onAppear { if t.olderError == nil { Task { await model.loadOlder(key) } } }
                                    if let error = t.olderError {
                                        Text(error).font(.caption).foregroundStyle(Theme.danger)
                                            .frame(maxWidth: .infinity)
                                    }
                                }
                                ForEach(displayRows(from: rows)) { entry in
                                    if entry.byline || entry.progress != nil {
                                        VStack(alignment: .leading, spacing: 6) {
                                            if entry.byline { AgentByline(engine: engine, ts: entry.ts) }
                                            if let progress = entry.progress {
                                                MoreContent(durationMs: progress.durationMs) {
                                                    ForEach(progress.blocks) { block in rendered(block, conclusions: [], completed: [], translate: false, lastUserId: nil) }
                                                }
                                            }
                                            if let block = entry.block {
                                                rendered(block, conclusions: conclusions, completed: completed, translate: t.translationEnabled, lastUserId: lastUserId)
                                            }
                                        }
                                    } else if let block = entry.block {
                                        rendered(block, conclusions: conclusions, completed: completed, translate: t.translationEnabled, lastUserId: lastUserId)
                                    }
                                }
                                if let echo { AgentEchoBubble(text: echo.text, loadImage: model.downloadImage, loadOriginalImage: model.downloadOriginalImage) }
                                ForEach(sent) { AgentEchoBubble(text: $0.text, loadImage: model.downloadImage, loadOriginalImage: model.downloadOriginalImage) }
                                if let delivery { Text(delivery).font(.caption).foregroundStyle(Theme.nexAgentMuted) }
                                if let working { AgentWorkingRow(engine: engine, label: working, byline: echo != nil || !sent.isEmpty || { if case .user = blocks.last { return true } else { return false } }()) }
                                Color.clear.frame(height: 1).id("bottom")
                                    .onAppear { following = true }
                                    .onDisappear { following = false }
                            }
                            .frame(maxWidth: 820)
                            .frame(maxWidth: .infinity)
                            .padding(.horizontal, 16).padding(.vertical, 10)
                        }
                        #if os(iOS)
                        .scrollDismissesKeyboard(.interactively)
                        #endif
                        .onAppear { following = true; proxy.scrollTo("bottom", anchor: .bottom) }
                        .onChange(of: blocks.last?.id) { _, _ in if following { proxy.scrollTo("bottom", anchor: .bottom) } }
                        .onChange(of: working) { _, _ in if following { proxy.scrollTo("bottom", anchor: .bottom) } }
                        .onChange(of: sent.count) { _, _ in following = true; proxy.scrollTo("bottom", anchor: .bottom) }
                        .onChange(of: t.items.last?.text.count) { _, _ in if following { proxy.scrollTo("bottom", anchor: .bottom) } }

                        if !following {
                            Button {
                                following = true
                                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                            } label: {
                                Image(systemName: "arrow.down")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(Theme.nexAgentInk)
                                    .frame(width: 34, height: 34)
                                    .background(Theme.nexAgentSurface, in: Circle())
                                    .overlay(Circle().strokeBorder(Theme.nexAgentBorderStrong))
                                    .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
                            }
                            .buttonStyle(.plain)
                            .padding(.trailing, 18).padding(.bottom, 12)
                            .accessibilityLabel("滚动到底部")
                        }
                    }
                }
            }
        }
        .task(id: receiptID) {
            lateReceipt = nil
            guard let receiptID else { return }
            do { try await Task.sleep(for: .seconds(15)) } catch { return }
            lateReceipt = receiptID
        }
    }

    private struct DisplayRow: Identifiable {
        let id: String
        let byline: Bool
        let ts: Int?
        let progress: (id: String, blocks: [CliBlock], durationMs: Int?)?
        let block: CliBlock?
    }

    private func firstTs(_ block: CliBlock?) -> Int? {
        guard let block else { return nil }
        switch block {
        case .user(let i), .assistant(let i): return i.ts > 0 ? i.ts : nil
        case .activity(_, let items): return items.first(where: { $0.ts > 0 })?.ts
        case .notice: return nil
        }
    }

    private func displayRows(from rows: [CliTranscriptRow]) -> [DisplayRow] {
        var heads: Set<String> = []
        var replying = false
        for row in rows {
            guard case .block(let block) = row else { continue }
            switch block {
            case .user: replying = false
            case .assistant where !replying:
                heads.insert(block.id)
                replying = true
            default: break
            }
        }
        var out: [DisplayRow] = []
        var seenAssistant = false
        for (index, row) in rows.enumerated() {
            switch row {
            case .progress(let id, let parts, let durationMs):
                guard !parts.isEmpty else { continue }
                if index + 1 < rows.count, case .block(let next) = rows[index + 1], case .assistant = next, heads.contains(next.id) {
                    continue
                }
                let showByline = !seenAssistant
                seenAssistant = true
                out.append(DisplayRow(id: id, byline: showByline, ts: firstTs(parts.first), progress: (id, parts, durationMs), block: nil))
            case .block(let block):
                if case .user = block { seenAssistant = false }
                var attached: (id: String, blocks: [CliBlock], durationMs: Int?)?
                let showByline: Bool
                if case .assistant = block, heads.contains(block.id) {
                    showByline = true
                    if index > 0, case .progress(let pid, let parts, let durationMs) = rows[index - 1], !parts.isEmpty {
                        attached = (pid, parts, durationMs)
                    }
                    seenAssistant = true
                } else {
                    showByline = false
                }
                out.append(DisplayRow(id: block.id, byline: showByline, ts: firstTs(block), progress: attached, block: block))
            }
        }
        return out
    }

    private func rendered(_ block: CliBlock, conclusions: Set<String>, completed: Set<String>, translate: Bool, lastUserId: String?) -> some View {
        let guide = guides.first { "guide:" + $0.id == block.id }
        let state = guide.flatMap { guide in model.queues[key]?.entries.first { $0.id == guide.id }?.status }
        let canEditUser: Bool = {
            guard case .user(let item) = block, let onEdit, item.id == lastUserId, !item.queued, !item.id.hasPrefix("guide:") else { return false }
            _ = onEdit
            let ageMs = model.now - item.ts
            return active || (item.ts > 0 && ageMs >= 0 && ageMs <= 30_000)
        }()
        return AgentBlockView(
            block: block,
            guideStatus: state == "failed" ? "发送失败" : (state == "uncertain" || guide?.uncertain == true ? "待确认" : nil),
            expandedActivities: $expandedActivities,
            loadImage: model.downloadImage,
            loadOriginalImage: model.downloadOriginalImage,
            translate: translate && completed.contains(block.id) && !guides.contains(where: { $0.tail?.id == block.id }) ? { item in
                try await model.translateReply(key, item: item)
            } : nil,
            actions: conclusions.contains(block.id),
            canEditUser: canEditUser,
            onEditUser: onEdit,
            onSelectSession: onSelectSession,
            branch: conclusions.contains(block.id) ? branch : nil,
            onNote: conclusions.contains(block.id) ? onNote : nil
        )
    }
}

private struct AgentBlockView: View {
    let block: CliBlock
    var guideStatus: String? = nil
    @Binding var expandedActivities: Set<String>
    let loadImage: (String) async throws -> Data
    var loadOriginalImage: ((String) async throws -> (data: Data, contentType: String?))? = nil
    var translate: ((CliItem) async throws -> String?)?
    var actions = true
    var canEditUser = false
    var onEditUser: ((String, String) -> Void)?
    var onSelectSession: ((CliSessionKey) -> Void)?
    var branch: ((String) -> Void)?
    var onNote: ((CliItem) -> Void)?

    var body: some View {
        switch block {
        case .user(let item):
            if let teamCard = CliTeamCard.parse(item.text) {
                AgentTeamMessageCard(card: teamCard, onSelectSession: onSelectSession)
            } else {
                HStack {
                    Spacer(minLength: 40)
                    VStack(alignment: .trailing, spacing: 3) {
                        AgentImageMessage(text: ([item.text] + item.images.filter { $0.hasPrefix("/api/cli-agents/images/") && !item.text.contains($0) }).joined(separator: "\n"), load: loadImage, loadOriginal: loadOriginalImage)
                        HStack(spacing: 8) {
                            if canEditUser, let onEditUser {
                                Button { onEditUser(item.id, item.text) } label: {
                                    Label("编辑重发", systemImage: "pencil").font(.caption2)
                                }
                                .buttonStyle(.plain)
                                .foregroundStyle(Theme.nexAgentMuted)
                            }
                            if let guideStatus { Text(guideStatus).font(.caption2).foregroundStyle(Theme.nexAgentMuted) }
                            if item.queued { Text("排队中").font(.caption2).foregroundStyle(Theme.nexAgentMuted) }
                        }
                    }
                }
            }
        case .assistant(let item):
            if let teamCard = CliTeamCard.parse(item.text) {
                AgentTeamMessageCard(card: teamCard, onSelectSession: onSelectSession)
            } else {
                AgentReplyText(item: item, load: loadImage, loadOriginal: loadOriginalImage, translate: translate, actions: actions, branch: branch, onNote: onNote)
            }
        case .activity(let id, let items):
            AgentActivity(items: items, open: Binding(get: { expandedActivities.contains(id) }, set: { open in
                if open { expandedActivities.insert(id) }
                else { expandedActivities.remove(id) }
            }))
        case .notice(_, let level, let text):
            Text(text).font(.caption).foregroundStyle(level == .error ? Theme.danger : Theme.nexAgentMuted).frame(maxWidth: .infinity, alignment: .center)
        }
    }
}

private struct AgentReplyText: View {
    let item: CliItem
    let load: (String) async throws -> Data
    var loadOriginal: ((String) async throws -> (data: Data, contentType: String?))? = nil
    var translate: ((CliItem) async throws -> String?)?
    var actions = true
    var branch: ((String) -> Void)?
    var onNote: ((CliItem) -> Void)?
    @State private var translated: String?
    @State private var original = false
    @State private var failed = false
    @State private var retry = 0
    @State private var copied = false
    private var displayedText: String { original ? item.text : translated ?? item.text }

    private struct Request: Equatable {
        let source: String
        let attempt: Int
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            AgentImageMessage(text: displayedText, markdown: true, load: load, loadOriginal: loadOriginal)
                .frame(maxWidth: .infinity, alignment: .leading)
            if translated != nil {
                Button(original ? "查看中文" : "查看原文") { original.toggle() }
                    .buttonStyle(.plain).font(.caption).foregroundStyle(Theme.nexAgentAccent)
            } else if failed {
                Button("重试翻译") { retry += 1 }
                    .buttonStyle(.plain).font(.caption).foregroundStyle(Theme.nexAgentAccent)
            }
            if actions {
                HStack(spacing: 8) {
                    Button {
                        #if os(macOS)
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(displayedText, forType: .string)
                        #else
                        UIPasteboard.general.string = displayedText
                        #endif
                        copied = true
                        Task {
                            try? await Task.sleep(for: .milliseconds(1500))
                            copied = false
                        }
                    } label: {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .foregroundStyle(copied ? Theme.nexAgentAccent : Theme.nexAgentMuted)
                    }
                    .help(copied ? "已复制" : "复制")
                    .accessibilityLabel("复制")
                    if let branch {
                        Button { branch(item.id) } label: { Image(systemName: "arrow.triangle.branch") }
                            .help("分支到新聊天").accessibilityLabel("分支到新聊天")
                    }
                    if let onNote {
                        Button { onNote(item) } label: { Image(systemName: "note.text.badge.plus") }
                            .help("添加到会话笔记").accessibilityLabel("记笔记")
                    }
                }
                .buttonStyle(.borderless).font(.system(size: 13)).foregroundStyle(Theme.nexAgentMuted)
                .padding(.top, 2)
            }
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

private enum AgentToolKind {
    case shell, read, edit, search, mcp, message, think, other

    static func classify(_ name: String) -> Self {
        let lower = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if lower == "agentmessage" || lower == "agent_message" { return .message }
        if lower.hasPrefix("mcp__") || lower.hasPrefix("mcp.") || lower.contains("mcp_") { return .mcp }
        if lower.contains("bash") || lower.contains("shell") || lower.contains("exec") || lower.contains("terminal") || lower.contains("command") { return .shell }
        if lower.contains("edit") || lower.contains("write") || lower.contains("patch") || lower.contains("replace") || lower.contains("create") { return .edit }
        if lower.contains("read") || lower.contains("view") || lower.contains("cat") || lower == "ls" || lower.contains("list") { return .read }
        if lower.contains("grep") || lower.contains("glob") || lower.contains("search") || lower.contains("find") || lower.contains("web") || lower.contains("fetch") { return .search }
        return .other
    }

    var symbol: String {
        switch self {
        case .shell: "terminal"
        case .read: "doc.text"
        case .edit: "pencil.line"
        case .search: "magnifyingglass"
        case .mcp: "powerplug"
        case .message: "bubble.left"
        case .think: "brain"
        case .other: "wrench"
        }
    }

    var liveLabel: String {
        switch self {
        case .shell: "正在运行命令"
        case .read: "正在读取文件"
        case .edit: "正在修改文件"
        case .search: "正在搜索内容"
        case .mcp: "正在调用外部工具"
        case .message: "正在处理协作者消息"
        case .think: "正在思考"
        case .other: "正在执行工具"
        }
    }

    var pastLabel: String {
        switch self {
        case .shell: "运行了命令"
        case .read: "读取了文件"
        case .edit: "修改了文件"
        case .search: "搜索了内容"
        case .mcp: "调用了外部工具"
        case .message: "收到协作者消息"
        case .think: "思考了片刻"
        case .other: "执行了工具"
        }
    }

    var requestVerb: String {
        switch self {
        case .shell: "请求执行"
        case .edit: "修改文件"
        case .read: "读取文件"
        case .mcp: "调用外部工具"
        default: "请求操作"
        }
    }

    var cardHeader: String {
        switch self {
        case .shell: "Shell"
        case .read: "Read"
        case .edit: "Edit"
        case .search: "Search"
        case .mcp: "MCP"
        case .message: "协作者消息"
        case .think: "Thinking"
        case .other: "Tool"
        }
    }
}

private struct AgentActivity: View {
    let items: [CliItem]
    @Binding var open: Bool

    private var summary: (symbol: String, text: String, failed: Int, running: Bool) {
        let tools = items.filter { $0.kind == .tool }
        let failed = tools.filter { $0.status == .error }.count
        let activeTool = tools.last { $0.status == .running }
        if let activeTool {
            let k = AgentToolKind.classify(activeTool.name)
            return (k.symbol, k.liveLabel, failed, true)
        }
        if tools.isEmpty { return (AgentToolKind.think.symbol, "思考了片刻", 0, false) }
        let kinds = tools.map { AgentToolKind.classify($0.name) }
        let unique = Set(kinds)
        if tools.count == 1, let only = kinds.first { return (only.symbol, only.pastLabel, failed, false) }
        if unique.count == 1, let only = unique.first { return (only.symbol, "\(only.pastLabel) · \(tools.count) 项", failed, false) }
        return (kinds.first?.symbol ?? "wrench", "执行了 \(tools.count) 项操作", failed, false)
    }

    var body: some View {
        let info = summary
        VStack(alignment: .leading, spacing: 4) {
            Button { withAnimation(.easeOut(duration: 0.16)) { open.toggle() } } label: {
                HStack(spacing: 6) {
                    if info.running {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: info.symbol).font(.system(size: 11.5)).foregroundStyle(Theme.nexAgentMuted)
                    }
                    Text(info.text).font(.system(size: 12.5)).foregroundStyle(info.running ? Theme.nexAgentAccent : Theme.nexAgentMuted)
                    if info.failed > 0 {
                        Text("· \(info.failed) 项失败").font(.system(size: 11.5)).foregroundStyle(Theme.danger)
                    }
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.nexAgentMuted.opacity(0.7))
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .padding(.vertical, 2)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if open {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(items) { item in
                        if item.kind == .tool {
                            AgentToolRow(item: item)
                        } else {
                            AgentThinkingRow(text: item.text)
                        }
                    }
                }
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    Rectangle().fill(Theme.nexAgentBorder).frame(width: 1).padding(.vertical, 2)
                }
                .padding(.leading, 5)
                .frame(maxWidth: 660, alignment: .leading)
            }
        }
    }
}

private struct AgentThinkingRow: View {
    let text: String
    @State private var expanded = false
    var body: some View {
        let preview = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        VStack(alignment: .leading, spacing: 4) {
            Button { withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "brain").font(.system(size: 11)).foregroundStyle(Theme.nexAgentMuted)
                    Text(expanded ? "思考过程" : (preview.isEmpty ? "思考过程" : preview))
                        .font(.system(size: 12)).foregroundStyle(Theme.nexAgentMuted).lineLimit(1)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Theme.nexAgentMuted.opacity(0.65))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .padding(.vertical, 2).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                Text(text).font(.caption).foregroundStyle(Theme.nexAgentMuted).textSelection(.enabled)
                    .padding(9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.nexAgentInset, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.nexAgentBorder))
            }
        }
    }
}

private struct AgentToolRow: View {
    let item: CliItem
    @State private var open = false

    private var kind: AgentToolKind { AgentToolKind.classify(item.name) }

    var body: some View {
        let isMessage = kind == .message
        let sender = item.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "协作者" : item.input
        let backgroundTitle = isMessage ? nil : CliTranscript.backgroundTaskTitle(item)
        let lineText: String = {
            if isMessage {
                let preview = CliTranscript.toolSummary(item.output ?? "")
                return preview.isEmpty ? sender : "\(sender) · \(preview)"
            }
            if let backgroundTitle { return backgroundTitle }
            let s = CliTranscript.toolSummary(item.input)
            return s.isEmpty ? item.name : s
        }()
        VStack(alignment: .leading, spacing: 4) {
            Button { withAnimation(.easeOut(duration: 0.15)) { open.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: kind.symbol).font(.system(size: 11))
                        .foregroundStyle(item.status == .error ? Theme.danger : Theme.nexAgentMuted)
                    Text(lineText).font(isMessage ? .system(size: 12) : .system(size: 12, design: .monospaced))
                        .foregroundStyle(open ? Theme.nexAgentInk : Theme.nexAgentMuted)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Theme.nexAgentMuted.opacity(0.65))
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .padding(.vertical, 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if open {
                VStack(alignment: .leading, spacing: 0) {
                    Text(isMessage ? "来自 \(sender)" : kind.cardHeader).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.nexAgentMuted)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                    Divider().overlay(Theme.nexAgentBorder)
                    if isMessage {
                        if let output = item.output, !output.isEmpty {
                            Text(output).font(.system(size: 12.5)).foregroundStyle(Theme.nexAgentInk)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 10).padding(.vertical, 8)
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 6) {
                            if !item.input.isEmpty {
                                ToolCodeBlock(text: kind == .shell ? "$ " + item.input : item.input)
                                    .foregroundStyle(Theme.nexAgentInk)
                            }
                            if let output = item.output, !output.isEmpty {
                                ToolCodeBlock(text: output)
                                    .foregroundStyle(Theme.nexAgentMuted)
                            }
                        }
                        Divider().overlay(Theme.nexAgentBorder)
                        HStack(spacing: 4) {
                            Spacer()
                            Image(systemName: item.status == .error ? "xmark" : item.status == .running ? "clock" : "checkmark")
                                .font(.system(size: 10, weight: .semibold))
                            Text(item.status == .error ? "失败" : item.status == .running ? "运行中" : "成功")
                                .font(.system(size: 11))
                        }
                        .foregroundStyle(item.status == .error ? Theme.danger : item.status == .running ? Theme.nexAgentAccent : Theme.nexAgentMuted)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                    }
                }
                .background(Theme.nexAgentInset, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.nexAgentBorder))
            }
        }
    }
}

// MARK: Requests — Floating Island

struct AgentRequestCard: View {
    let model: CliAgentsModel
    let record: CliRequestRecord
    @State private var selection: CliRequestStore.Selection = [:]
    @State private var other: CliRequestStore.OtherAnswers = [:]
    @State private var busy: CliDecision?
    @State private var busyAlways = false
    @State private var error = ""

    private static let optionLetters = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    private var request: CliRequest { record.view }

    var body: some View {
        let state = model.cardState(record)
        let open = state == .pending
        if !open {
            resolvedPill(state)
        } else if request.kind == .question {
            questionIsland
        } else {
            permissionIsland
        }
    }

    private func resolvedPill(_ state: CliCardState) -> some View {
        let dotColor: Color = switch state {
        case .denied: Theme.danger
        case .allowed, .always, .answered: Theme.nexAgentAccent
        default: Theme.nexAgentMuted
        }
        let label = request.kind == .question
            ? (request.questions?.map(\.question).joined(separator: " / ") ?? (request.summary.isEmpty ? "提问" : request.summary))
            : request.tool
        return HStack(spacing: 7) {
            Circle().fill(dotColor).frame(width: 7, height: 7)
            Text(label).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.nexAgentInk).lineLimit(1)
            Text("· \(state.text)").font(.system(size: 12)).foregroundStyle(Theme.nexAgentMuted)
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .background(Theme.nexAgentSurface, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.nexAgentBorder))
    }

    private var permissionIsland: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(request.tool).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Theme.nexAgentAccent)
                        Text("· \(AgentToolKind.classify(request.tool).requestVerb)").font(.system(size: 11.5)).foregroundStyle(Theme.nexAgentMuted)
                    }
                    if !request.summary.isEmpty {
                        Text(request.summary)
                            .font(.system(size: 12.5, design: .monospaced))
                            .foregroundStyle(Theme.nexAgentInk)
                            .lineLimit(2)
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 3) {
                    islandButton(busy == .deny ? "拒绝中…" : "拒绝", role: .deny) { submit(.deny) }
                    if request.offersAlways {
                        islandButton(busyAlways ? "处理中…" : "总是", role: .secondary) { submit(.allow, always: true) }
                            .help("本会话总是允许")
                            .accessibilityLabel("本会话总是允许")
                    }
                    islandButton(busy == .allow && !busyAlways ? "允许中…" : "允许", role: .primary) { submit(.allow) }
                }
                .padding(4)
                .background(Theme.nexAgentInset, in: Capsule())
                .disabled(busy != nil)
            }
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(Theme.danger) }
        }
        .padding(.leading, 16).padding(.trailing, 10).padding(.vertical, 10)
        .background(Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Theme.nexAgentBorderStrong))
        .shadow(color: Theme.shadowInk.opacity(0.08), radius: 10, y: 3)
    }

    private var questionIsland: some View {
        let questions = request.questions ?? []
        let multiQ = questions.count > 1
        let complete = CliRequestStore.answersComplete(questions, selection, other: other)
        return VStack(alignment: .leading, spacing: 12) {
            if !questions.isEmpty {
                ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                    if index > 0 { Divider().overlay(Theme.nexAgentBorder) }
                    questionSection(index, question, multiQ: multiQ, total: questions.count)
                }
            } else if !request.summary.isEmpty {
                Text(request.summary).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(Theme.nexAgentInk)
            }
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(Theme.danger) }
            HStack {
                Spacer()
                HStack(spacing: 3) {
                    islandButton(busy == .deny ? "拒绝中…" : "拒绝", role: .deny) { submit(.deny) }
                    islandButton(busy == .allow ? "提交中…" : "提交", role: .primary, disabled: !complete) { submit(.allow) }
                        .disabled(!complete)
                }
                .padding(4)
                .background(Theme.nexAgentInset, in: Capsule())
                .disabled(busy != nil)
            }
        }
        .padding(16)
        .background(Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Theme.nexAgentBorderStrong))
        .shadow(color: Theme.shadowInk.opacity(0.08), radius: 10, y: 3)
    }

    private func questionSection(_ index: Int, _ question: CliQuestion, multiQ: Bool, total: Int) -> some View {
        let chosen = selection[index] ?? []
        let otherOn = chosen.contains(CliRequestStore.otherChoice)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                if multiQ {
                    Text("\(index + 1) / \(total)")
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Theme.nexAgentAccent)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Theme.nexAgentSoft, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                } else if let header = question.header, !header.isEmpty {
                    Text(header)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.nexAgentAccent)
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(Theme.nexAgentSoft, in: Capsule())
                }
                Text(question.question).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Theme.nexAgentInk)
                Spacer(minLength: 4)
                if question.multiSelect { Text("可多选").font(.caption2).foregroundStyle(Theme.nexAgentMuted) }
            }

            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(question.options.enumerated()), id: \.element.label) { optIndex, option in
                    let on = chosen.contains(option.label)
                    let letter = optIndex < Self.optionLetters.count ? String(Self.optionLetters[optIndex]) : "\(optIndex + 1)"
                    Button {
                        selection = CliRequestStore.toggle(selection, index: index, label: option.label, multi: question.multiSelect)
                    } label: {
                        HStack(alignment: .center, spacing: 10) {
                            optionBadge(selected: on, multi: question.multiSelect, marker: letter)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(option.label).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.nexAgentInk)
                                if let description = option.description, !description.isEmpty {
                                    Text(description).font(.caption).foregroundStyle(Theme.nexAgentMuted)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 12).padding(.vertical, 9)
                        .background(on ? Theme.nexAgentSoft : Color.clear, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(on ? Theme.nexAgentAccent : Theme.nexAgentBorder))
                        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(busy != nil)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Button {
                        selection = CliRequestStore.toggle(selection, index: index, label: CliRequestStore.otherChoice, multi: question.multiSelect)
                    } label: {
                        HStack(spacing: 10) {
                            optionBadge(selected: otherOn, multi: question.multiSelect, marker: "…")
                            Text(question.multiSelect ? "其他补充" : "其他（自定义输入）")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Theme.nexAgentInk)
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(busy != nil)

                    if otherOn {
                        TextField(question.multiSelect ? "输入补充内容…" : "输入自定义回复…", text: otherBinding(index))
                            .textFieldStyle(.plain)
                            .font(.system(size: 13))
                            .padding(.horizontal, 10).padding(.vertical, 7)
                            .background(Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.nexAgentBorder))
                            .padding(.leading, question.multiSelect ? 27 : 34)
                            .disabled(busy != nil)
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(otherOn ? Theme.nexAgentSoft : Color.clear, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(otherOn ? Theme.nexAgentAccent : Theme.nexAgentBorder))
            }
        }
    }

    private func otherBinding(_ index: Int) -> Binding<String> {
        Binding(get: { other[index] ?? "" }, set: { other[index] = $0 })
    }

    @ViewBuilder
    private func optionBadge(selected: Bool, multi: Bool, marker: String) -> some View {
        if multi {
            ZStack {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(selected ? Theme.nexAgentSolid : Color.clear)
                    .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(selected ? Theme.nexAgentSolid : Theme.nexAgentBorderStrong, lineWidth: 1.5))
                if selected {
                    Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Color.white)
                }
            }
            .frame(width: 17, height: 17)
        } else {
            ZStack {
                Circle().fill(selected ? Theme.nexAgentSolid : Theme.nexAgentInset)
                Text(selected ? "✓" : marker)
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(selected ? Color.white : Theme.nexAgentMuted)
            }
            .frame(width: 24, height: 24)
        }
    }

    private enum IslandRole { case deny, secondary, primary }

    private func islandButton(_ title: String, role: IslandRole, disabled: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12, weight: role == .primary ? .semibold : .medium))
                .foregroundStyle(role == .primary ? Color.white : role == .deny ? Theme.nexAgentMuted : Theme.nexAgentInk)
                .padding(.horizontal, role == .primary ? 15 : 11)
                .padding(.vertical, 6)
                .background(role == .primary ? Theme.nexAgentSolid : Color.clear, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .opacity(disabled ? 0.42 : 1)
    }

    private func submit(_ decision: CliDecision, always: Bool = false) {
        busy = decision; busyAlways = always; error = ""
        Task {
            do { try await model.answer(request, decision: decision, selection: selection, other: other, always: always) }
            catch { self.error = CliAgentsModel.answerErrorText(error) }
            busy = nil; busyAlways = false
        }
    }
}

// MARK: Composer (Direct stopped typing, Inset Queue + Withdraw, Goal Mode, Files, Notes, Edit-Resend, Slash Skills)

private struct AgentComposer: View {
    let model: CliAgentsModel
    let session: CliSession
    @Binding var pending: [AgentPendingSend]
    @Binding var guides: [AgentGuide]
    @Binding var notes: [CliNote]
    @Binding var revision: AgentRevision?
    let onCancelRevision: () -> Void
    let onOpenNotes: () -> Void
    let onKeyChange: (CliSessionKey) -> Void

    @State private var editing: CliQueuedEntry?
    @State private var editedText = ""
    @State private var draft = ""
    @State private var sending = false
    @State private var error = ""
    @State private var deliveryNotice: String?
    @State private var images: [CliImageUpload] = []
    @State private var files: [CliFileUpload] = []
    @State private var goal: String? = nil
    @State private var showingEffort = false
    @State private var effort: String?
    @State private var chosenModel = ""
    @State private var showingSkills = false
    @State private var skillQuery = ""
    @State private var showingModels = false
    @State private var catalog = CliModelCatalog(models: [])
    @State private var permission: (mode: CliPermissionMode, pending: Bool)?
    @FocusState private var composerFocused: Bool

    private var features: [String] { model.device(session.deviceId)?.cliAgents?.features ?? [] }
    private var canSetOnResume: Bool { features.contains("launchOptions") }
    private var canListSkills: Bool { features.contains("skills") && (session.engine == .claude || session.engine == .codex || session.engine == .zcode) }
    private var claudeInbox: Bool { session.engine == .claude && session.sendVia == "inbox" && features.contains("inboxSteer") }
    private var managedProtocol: Bool { (session.engine == .agy && session.sendVia == "acp") || (session.engine == .zcode && session.sendVia == "host" && session.liveIn == .background) }
    private var canConfigureProtocol: Bool { managedProtocol && session.state == .idle && canSetOnResume }
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
        guard session.state == .running else { return false }
        return (session.liveIn == .nexbot && session.terminal != nil) || managedProtocol || claudeInbox
    }
    private var steerLabel: String { steerQuestionId != nil ? "取消提问并引导" : interruptWaiting ? "中断并引导" : "引导" }
    private var composerMode: CliComposerMode { CliSessions.composerMode(session) }
    private var canSetOnSend: Bool { session.engine == .claude && session.liveIn == .nexbot && session.terminal != nil }
    private var offered: [String] {
        let effectiveModel = chosenModel.isEmpty ? session.model ?? catalog.current ?? "" : chosenModel
        let explicit = catalog.models.first { $0.id == effectiveModel }?.efforts
        if let explicit, !explicit.isEmpty { return explicit }
        return CliLaunches.efforts[session.engine] ?? []
    }
    private var effortLevels: [String] { session.engine == .agy || session.engine == .zcode ? offered : CliLaunches.reasoningLevels }
    private var selectedEffort: String { CliLaunches.reasoningChoice(effort ?? catalog.currentEffort) }
    private var resolvedEffort: String? { CliLaunches.resolveEffort(engine: session.engine, offered: offered, preferred: selectedEffort) }

    private var permissionChoice: AgentPermissionChoice? {
        let modes = CliPermissions.modes(engine: session.engine, features: features)
        guard !modes.isEmpty else { return nil }
        let takesNow = session.state == .stopped || managedProtocol
        return AgentPermissionChoice(engine: session.engine, modes: modes, value: permission?.mode,
                                     pending: permission?.pending == true ? (takesNow ? "发送下一条消息时生效" : "会话下次启动时生效") : nil) { mode in
            permission = (mode, true)
            AgentDrafts.permissions[session.key] = (mode, true)
        }
    }
    private var pendingPermission: CliPermissionMode? { permission?.pending == true ? permission?.mode : nil }
    private func tookPermission(_ key: CliSessionKey, _ mode: CliPermissionMode) {
        permission = (mode, false)
        AgentDrafts.permissions[key] = (mode, false)
    }

    private var composedText: String {
        let trimmedGoal = goal?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var parts: [String] = []
        if !trimmedGoal.isEmpty { parts.append("当前目标：" + trimmedGoal) }
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { parts.append(trimmed) }
        for n in notes {
            parts.append("引用「\(n.quote)」\n注释：\(n.body)")
        }
        return parts.joined(separator: "\n\n")
    }

    private var tooLong: Bool { composedText.utf8.count > CoreClient.cliMaxSendBytes }
    private var goalBlocked: Bool { goal != nil && (goal?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) }
    private var hasPayload: Bool { !composedText.isEmpty || !images.isEmpty || !files.isEmpty }
    private var canSend: Bool { hasPayload && !goalBlocked && !tooLong && !sending }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch composerMode {
            case .blocked(let hint):
                Text(hint).font(.footnote).foregroundStyle(Theme.nexAgentMuted)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.nexAgentInset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.nexAgentBorder))
            case .stopped(let hint) where hint != nil:
                Text(hint ?? "会话已停止").font(.footnote).foregroundStyle(Theme.nexAgentMuted)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.nexAgentInset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.nexAgentBorder))
            case .send(let running):
                composerCard(running: running, stopped: false)
            case .stopped:
                // Stopped without blocker: allow typing directly — sending auto-continues!
                composerCard(running: false, stopped: true)
            }
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(Theme.danger).padding(.horizontal, 4) }
            if let deliveryNotice { Text(deliveryNotice).font(.caption).foregroundStyle(Theme.nexAgentMuted).padding(.horizontal, 4) }
        }
        #if os(macOS)
        .frame(maxWidth: 820)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 18).padding(.top, 4).padding(.bottom, 14)
        #else
        .padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 10)
        #endif
        .onAppear {
            draft = AgentDrafts.texts[session.key] ?? ""
            effort = AgentDrafts.efforts[session.key]
            chosenModel = AgentDrafts.models[session.key] ?? ""
            images = AgentDrafts.images[session.key] ?? []
            files = AgentDrafts.files[session.key] ?? []
            goal = AgentDrafts.goals[session.key]
            permission = AgentDrafts.permissions[session.key]
        }
        .onChange(of: revision) { _, next in
            guard let next else { return }
            draft = next.text
            composerFocused = true
        }
        .onChange(of: draft) { _, text in
            AgentDrafts.texts[session.key] = text
            if text.isEmpty && revision != nil && images.isEmpty && files.isEmpty {
                onCancelRevision()
            }
            // Inline "/" slash trigger for skills (aligned with Web Composer.tsx:379)
            if canListSkills && text.hasPrefix("/") && !text.contains(" ") && !text.contains("\n") && text.count <= 24 {
                skillQuery = String(text.dropFirst())
                if !showingSkills && text.count == 1 { showingSkills = true }
            }
        }
        .onChange(of: images) { _, value in AgentDrafts.images[session.key] = value.isEmpty ? nil : value }
        .onChange(of: files) { _, value in AgentDrafts.files[session.key] = value.isEmpty ? nil : value }
        .onChange(of: goal) { _, value in AgentDrafts.goals[session.key] = value }
        .onChange(of: chosenModel) { _, name in AgentDrafts.models[session.key] = name }
        .sheet(isPresented: $showingSkills) {
            ChatSkillPicker(
                load: { try await model.skills(deviceId: session.deviceId, engine: session.engine, cwd: session.cwd, key: session.key) },
                initialQuery: skillQuery
            ) { skill in
                let baseDraft = draft.hasPrefix("/") && !draft.contains(" ") ? "" : draft
                draft = session.engine == .claude && session.sendVia == "inbox"
                    ? "请调用 Skill 工具使用「\(skill.name)」技能。\n" + baseDraft
                    : skill.adding(to: baseDraft, engine: session.engine)
                skillQuery = ""
                composerFocused = true
            }
        }
        .task(id: canSetOnResume || canSetOnSend) {
            guard canSetOnResume || canSetOnSend else { return }
            let options = await model.models(deviceId: session.deviceId, engine: session.engine)
            if !Task.isCancelled { catalog = options }
        }
        #if os(iOS)
        .sheet(isPresented: $showingModels) {
            AgentComposerModelOptions(catalog: catalog, model: $chosenModel, levels: effortLevels, selection: selectedEffort, chooseEffort: setEffort)
        }
        #endif
    }

    private func composerCard(running: Bool, stopped: Bool) -> some View {
        let queue = model.queues[session.key]
        return VStack(alignment: .leading, spacing: 6) {
            // 1. Inset queue cards (aligned with Web Composer.tsx)
            if let queue {
                insetQueueSection(queue)
            }

            // 2. Edit-and-resend banner
            if revision != nil {
                HStack(spacing: 6) {
                    Image(systemName: "pencil").font(.system(size: 11)).foregroundStyle(Theme.nexAgentAccent)
                    Text("正在编辑并重发消息").font(.caption.weight(.medium)).foregroundStyle(Theme.nexAgentAccent)
                    Spacer()
                    Button("取消") { draft = ""; onCancelRevision() }
                        .buttonStyle(.plain).font(.caption).foregroundStyle(Theme.nexAgentMuted)
                }
                .padding(.horizontal, 12).padding(.top, 8)
            }

            // 3. Goal Mode inset bar
            if let currentGoal = goal {
                HStack(spacing: 8) {
                    Image(systemName: "target").font(.system(size: 13)).foregroundStyle(Theme.nexAgentAccent)
                    Text("目标").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.nexAgentAccent)
                    TextField("想持续完成什么？", text: Binding(get: { currentGoal }, set: { goal = $0 }))
                        .textFieldStyle(.plain)
                        .font(.system(size: 12.5))
                    Button { goal = nil } label: {
                        Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.nexAgentMuted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("退出目标模式")
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Theme.nexAgentSoft, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                .padding(.horizontal, 10).padding(.top, 8)
            }

            // 4. Draft images & files + notes chip
            if !images.isEmpty || !files.isEmpty || !notes.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    AgentImageDrafts(images: $images)
                    if !files.isEmpty || !notes.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(files) { file in
                                    HStack(spacing: 5) {
                                        Image(systemName: "paperclip").font(.system(size: 11)).foregroundStyle(Theme.nexAgentMuted)
                                        Text(file.name).font(.system(size: 11.5)).foregroundStyle(Theme.nexAgentInk).lineLimit(1)
                                        Button { files.removeAll { $0.id == file.id } } label: {
                                            Image(systemName: "xmark").font(.system(size: 9.5, weight: .semibold)).foregroundStyle(Theme.nexAgentMuted)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                    .padding(.horizontal, 8).padding(.vertical, 4)
                                    .background(Theme.nexAgentInset, in: Capsule())
                                    .overlay(Capsule().strokeBorder(Theme.nexAgentBorder))
                                }
                                if !notes.isEmpty {
                                    Button(action: onOpenNotes) {
                                        HStack(spacing: 4) {
                                            Image(systemName: "note.text").font(.system(size: 11))
                                            Text("\(notes.count) 条注释").font(.system(size: 11.5, weight: .medium))
                                        }
                                        .foregroundStyle(Theme.nexAgentAccent)
                                        .padding(.horizontal, 8).padding(.vertical, 4)
                                        .background(Theme.nexAgentSoft, in: Capsule())
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 12).padding(.top, 8)
            }

            // 5. Text input
            TextField(stopped ? "输入消息以继续会话…" : "发消息，或输入 / 使用技能", text: $draft, axis: .vertical)
                .lineLimit(2...6)
                .textFieldStyle(.plain)
                .font(.system(size: 14))
                .focused($composerFocused)
                .frame(minHeight: 34, alignment: .topLeading)
                .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 2)
                .onSubmit { if canSend { Task { await send() } } }
                #if os(macOS)
                .agentImagePaste(active: composerFocused, images: $images, error: $error)
                #endif

            // 6. Action bar
            HStack(spacing: 8) {
                AgentComposerAdd(
                    images: $images,
                    files: $files,
                    error: $error,
                    openSkills: canListSkills ? { skillQuery = ""; showingSkills = true } : nil,
                    goalActive: goal != nil,
                    onToggleGoal: { goal = (goal == nil ? "" : nil) },
                    permissions: permissionChoice
                )
                if tooLong { Text("内容太长").font(.caption).foregroundStyle(Theme.danger) }
                Spacer(minLength: 8)
                modelChip
                #if os(macOS)
                if (canSetOnSend || canConfigureProtocol || (stopped && canSetOnResume)) && !effortLevels.isEmpty && catalog.models.count <= 8 {
                    effortButton
                }
                #endif
                AgentContextRing(usage: session.context)
                if running && !sending && !hasPayload {
                    Button { Task { await interrupt() } } label: {
                        Image(systemName: "stop.circle.fill").font(.system(size: 26))
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.nexAgentInk).accessibilityLabel("停止")
                } else {
                    Button { Task { await send() } } label: {
                        Image(systemName: "arrow.up.circle.fill").font(.system(size: 26))
                    }
                    .buttonStyle(.plain).foregroundStyle(canSend ? Theme.nexAgentSolid : Theme.offline)
                    .disabled(!canSend).accessibilityLabel("发送")
                }
            }
            .padding(.horizontal, 10).padding(.bottom, 8)
        }
        .background(Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(composerFocused ? Theme.nexAgentAccent : Theme.nexAgentBorderStrong, lineWidth: composerFocused ? 1.5 : 1)
        )
        .shadow(color: composerFocused ? Theme.nexAgentRing : Theme.shadowInk.opacity(0.05), radius: composerFocused ? 6 : 8, y: 2)
    }

    @ViewBuilder
    private func insetQueueSection(_ queue: CliSessionQueue) -> some View {
        let hidden = Set(guides.filter { $0.key == session.key }.map(\.id))
        let visible = queue.entries.filter { !hidden.contains($0.id) && ["pending", "claimed", "uncertain", "failed"].contains($0.status) }
        if !visible.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                if queue.paused && visible.contains(where: { $0.status == "pending" }) {
                    let reason: String = switch queue.pauseReason {
                    case "stopped": "（已停止）"
                    case "uncertain": "（结果待确认）"
                    case "failed": "（有失败条目）"
                    case "device_offline": "（电脑离线）"
                    default: ""
                    }
                    HStack(spacing: 8) {
                        Text("队列已暂停\(reason)").font(.caption.weight(.medium)).foregroundStyle(Theme.approval)
                        Spacer()
                        Button("继续队列") { queueAction { try await model.resumeQueue(session.key) } }
                            .font(.caption.weight(.semibold)).foregroundStyle(Theme.nexAgentAccent).buttonStyle(.plain)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(Theme.approvalSoft, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }

                ForEach(Array(visible.enumerated()), id: \.element.id) { index, entry in
                    VStack(alignment: .leading, spacing: 6) {
                        if let original = editing, original.id == entry.id, (entry.status == "pending" || entry.status == "failed") {
                            HStack(spacing: 6) {
                                Text("排队 \(index + 1)").font(.caption2.weight(.semibold)).foregroundStyle(Theme.nexAgentAccent)
                                TextField("编辑排队消息", text: $editedText)
                                    .textFieldStyle(.plain)
                                    .font(.caption)
                                    .padding(.horizontal, 7).padding(.vertical, 4)
                                    .background(Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 6))
                                Button("取消") { editing = nil }.buttonStyle(.plain).font(.caption).foregroundStyle(Theme.nexAgentMuted)
                                Button("保存") {
                                    queueAction { try await model.editQueued(original, text: editedText); editing = nil }
                                }
                                .buttonStyle(.plain).font(.caption.weight(.semibold)).foregroundStyle(Theme.nexAgentAccent)
                                .disabled(editedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }
                        } else {
                            HStack(spacing: 8) {
                                Label("排队 \(index + 1)", systemImage: "list.number")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(Theme.nexAgentAccent)
                                    .fixedSize()
                                Text(entry.text).font(.caption).foregroundStyle(Theme.nexAgentInk).lineLimit(2)
                                Spacer(minLength: 4)
                                if entry.status == "uncertain" {
                                    Text("待确认").font(.caption2).foregroundStyle(Theme.approval)
                                } else if entry.status == "claimed" {
                                    Text("投递中").font(.caption2).foregroundStyle(Theme.nexAgentMuted)
                                } else if entry.status == "failed" {
                                    Text(session.engine == .codex && entry.errorCode == "read_only" ? "请检查 Codex 终端" : "发送失败")
                                        .font(.caption2).foregroundStyle(Theme.danger)
                                }
                                if entry.status == "pending" || entry.status == "failed" {
                                    HStack(spacing: 8) {
                                        if entry.status == "pending" && canSteer && queue.pauseReason != "stopped" {
                                            Button(steerLabel) { steerQueuedEntry(entry) }
                                                .buttonStyle(.plain).font(.caption.weight(.medium)).foregroundStyle(Theme.nexAgentAccent)
                                        }
                                        Button {
                                            editing = entry; editedText = entry.text
                                        } label: { Image(systemName: "pencil").font(.system(size: 11.5)).foregroundStyle(Theme.nexAgentMuted) }
                                        .buttonStyle(.plain).help("编辑")
                                        Button {
                                            queueAction { try await model.withdrawQueued(entry) }
                                        } label: { Image(systemName: "arrow.uturn.backward").font(.system(size: 11.5)).foregroundStyle(Theme.nexAgentMuted) }
                                        .buttonStyle(.plain).help("撤销")
                                    }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(Theme.nexAgentInset, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Theme.nexAgentBorder))
                }
            }
            .padding(.horizontal, 10).padding(.top, 10)
            .disabled(sending)
        }
    }

    private func steerQueuedEntry(_ entry: CliQueuedEntry) {
        let items = model.transcript(session.key).items
        let guide = AgentGuide(key: session.key, id: entry.id, text: entry.text,
                               at: Int(Date().timeIntervalSince1970 * 1000), known: Set(items.map(\.id)),
                               after: items.last?.id, tail: items.last { $0.kind == .assistant })
        guides.append(guide)
        queueAction {
            do {
                let sent = try await model.steerQueued(entry, questionId: steerQuestionId, interruptWaiting: interruptWaiting)
                if sent.status == "pending", steerQuestionId != nil || interruptWaiting { guides.removeAll { $0.id == entry.id } }
                if sent.status == "uncertain", let at = guides.firstIndex(where: { $0.id == entry.id }) { guides[at].uncertain = true }
            } catch {
                let failure = CoreError.wrap(error)
                if failure.kind == .network || failure.code == "unknown" || (failure.status ?? 0) >= 500 {
                    if let at = guides.firstIndex(where: { $0.id == entry.id }) { guides[at].uncertain = true }
                } else { guides.removeAll { $0.id == entry.id } }
                throw error
            }
        }
    }

    private func queueAction(_ action: @escaping @MainActor () async throws -> Void) {
        sending = true
        Task {
            defer { sending = false }
            do { try await action() } catch { self.error = CliErrorText.text(for: error, fallback: "操作失败") }
        }
    }

    private var modelTitle: String {
        let id = chosenModel.isEmpty ? (session.model ?? catalog.current ?? "") : chosenModel
        guard !id.isEmpty else { return "默认模型" }
        return CliLaunches.modelDisplayLabel(catalog.models, id: id)
    }

    @ViewBuilder private var modelChip: some View {
        if (session.engine == .agy || session.engine == .zcode) && session.state != .stopped && !canConfigureProtocol {
            modelChipLabel
        } else if canSetOnResume || canSetOnSend {
            #if os(iOS)
            Button { showingModels = true } label: { modelChipLabel }
                .buttonStyle(.plain)
                .accessibilityLabel("模型设置").accessibilityValue(modelTitle)
            #else
            if catalog.models.count > 8 {
                Button { showingModels.toggle() } label: { modelChipLabel }
                    .buttonStyle(.plain)
                    .popover(isPresented: $showingModels, arrowEdge: .top) {
                        AgentMacModelPopover(
                            catalog: catalog,
                            selection: $chosenModel,
                            fallback: session.model ?? catalog.current ?? "",
                            levels: (canSetOnSend || canConfigureProtocol || (session.state == .stopped && canSetOnResume)) ? effortLevels : [],
                            selectedEffort: selectedEffort,
                            chooseEffort: setEffort,
                            onDismiss: { showingModels = false }
                        )
                    }
                    .frame(maxWidth: 190)
                    .accessibilityLabel("模型设置").accessibilityValue(modelTitle)
            } else {
                Menu {
                    AgentMacModelMenuContent(catalog: catalog, selection: $chosenModel, fallback: session.model ?? catalog.current ?? "")
                } label: { modelChipLabel }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden)
                    .frame(maxWidth: 180)
                    .accessibilityLabel("模型设置").accessibilityValue(modelTitle)
            }
            #endif
        }
    }

    private var modelChipLabel: some View {
        HStack(spacing: 3) {
            Text(modelTitle).font(.system(size: 12)).foregroundStyle(Theme.nexAgentMuted)
                .lineLimit(1).truncationMode(.tail)
            #if os(macOS)
            if canSetOnResume || canSetOnSend {
                Image(systemName: "chevron.down").font(.system(size: 8.5, weight: .semibold)).foregroundStyle(Theme.nexAgentMuted.opacity(0.8))
            }
            #endif
        }
        #if os(iOS)
        .frame(maxWidth: 110, alignment: .trailing)
        .frame(height: 34)
        #else
        .padding(.horizontal, 6).frame(height: 28)
        #endif
        .contentShape(Rectangle())
    }

    private func setEffort(_ level: String) {
        effort = level
        AgentDrafts.efforts[session.key] = level
    }

    #if os(macOS)
    private var effortButton: some View {
        Button { showingEffort.toggle() } label: {
            HStack(spacing: 3) {
                Text(CliLaunches.effortLabel(selectedEffort))
                Image(systemName: "chevron.down").font(.system(size: 8.5, weight: .semibold))
            }
            .font(.system(size: 12))
            .foregroundStyle(Theme.nexAgentMuted)
            .padding(.horizontal, 7).frame(height: 28)
            .background(Theme.nexAgentInset, in: RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("思考强度")
        .accessibilityValue(CliLaunches.effortLabel(selectedEffort))
        .popover(isPresented: $showingEffort, arrowEdge: .bottom) {
            ChatEffortChoices(levels: effortLevels, selection: selectedEffort, label: CliLaunches.effortLabel, tint: Theme.nexAgentAccent, choose: setEffort)
                .padding(12).frame(width: 305)
        }
    }
    #endif

    private func uploadFiles(_ list: [CliFileUpload], to targetKey: CliSessionKey) async throws -> [String] {
        guard !list.isEmpty else { return [] }
        let supportsAttach = features.contains("attach")
        var refs: [String] = []
        for file in list {
            if supportsAttach {
                let path = try await model.attachTerminalFile(targetKey, name: file.name, data: file.data)
                refs.append("附件：\(file.name)\n\(path)")
            } else {
                if file.data.count <= CoreClient.cliMaxSendBytes,
                   let text = String(data: file.data, encoding: .utf8),
                   !text.unicodeScalars.contains(where: { ($0.value <= 0x08) || ($0.value >= 0x0E && $0.value <= 0x1F) }) {
                    refs.append("文件：\(file.name)\n\(text)")
                } else {
                    throw CoreError(kind: .http, message: "目前只能附加小型文本文件")
                }
            }
        }
        return refs
    }

    private func send() async {
        guard canSend else { return }
        deliveryNotice = nil
        let rawDraft = draft
        let submittedBody = composedText
        let submittedImages = images
        let submittedFiles = files
        let submittedNotes = notes
        let currentRevision = revision
        let wasStopped = session.state == .stopped

        let preview = ([submittedBody] + submittedImages.map { "图片：" + $0.name } + submittedFiles.map { "附件：" + $0.name })
            .filter { !$0.isEmpty }.joined(separator: "\n")
        let entry = AgentPendingSend(
            text: preview,
            uploading: !submittedImages.isEmpty || !submittedFiles.isEmpty,
            known: Set(model.transcript(session.key).items.map(\.id))
        )
        pending.append(entry)
        draft = ""; images = []; files = []; notes = []
        sending = true; error = ""
        defer { sending = false }

        do {
            // Auto-continue stopped session on send!
            var targetKey = session.key
            if wasStopped {
                let level = canSetOnResume ? resolvedEffort : nil
                let requestedModel = canSetOnResume && !chosenModel.isEmpty ? chosenModel : nil
                let mode = pendingPermission
                targetKey = try await model.continueSession(session.key, effort: level, model: requestedModel, permissions: mode)
                if let mode { tookPermission(targetKey, mode) }
                AgentDrafts.efforts[targetKey] = effort
                AgentDrafts.appliedEfforts[targetKey] = level
                AgentDrafts.models[targetKey] = requestedModel
                AgentDrafts.appliedModels[targetKey] = requestedModel
                if let g = goal { AgentDrafts.goals[targetKey] = g }
            }

            let withImages = try await model.imageMessage(targetKey, text: submittedBody, images: submittedImages)
            let fileRefs = try await uploadFiles(submittedFiles, to: targetKey)
            let message = ([withImages] + fileRefs).filter { !$0.isEmpty }.joined(separator: "\n\n")
            guard message.utf8.count <= CoreClient.cliMaxSendBytes else {
                throw CoreError(kind: .http, message: "消息和附件内容超过可发送长度", status: 400, code: "too_large")
            }

            if !wasStopped && canConfigureProtocol {
                let previousModel = AgentDrafts.appliedModels[targetKey]
                let requestedModel = chosenModel.isEmpty ? (previousModel == nil ? nil : catalog.current) : chosenModel
                let level = effort == nil ? nil : resolvedEffort
                let mode = pendingPermission
                if (requestedModel != nil && requestedModel != previousModel) || (level != nil && level != AgentDrafts.appliedEfforts[targetKey]) || mode != nil {
                    _ = try await model.continueSession(targetKey, effort: level, model: requestedModel, permissions: mode)
                    AgentDrafts.appliedModels[targetKey] = requestedModel
                    AgentDrafts.appliedEfforts[targetKey] = level
                    if let mode { tookPermission(targetKey, mode) }
                }
            }
            if !wasStopped && canSetOnSend {
                let applied = AgentDrafts.appliedModels[targetKey]
                let wanted = chosenModel.isEmpty ? (applied == nil ? nil : catalog.current) : chosenModel
                if let wanted, wanted != applied {
                    try await model.send(targetKey, text: "/model " + wanted)
                    AgentDrafts.appliedModels[targetKey] = wanted
                    AgentDrafts.appliedEfforts[targetKey] = nil
                }
                if effort != nil, let level = resolvedEffort, AgentDrafts.appliedEfforts[targetKey] != level {
                    try await model.send(targetKey, text: "/effort " + level)
                    AgentDrafts.appliedEfforts[targetKey] = level
                }
            }
            if let index = pending.firstIndex(where: { $0.id == entry.id }) {
                pending[index].text = message
                pending[index].uploading = false
            }

            // Edit-and-resend interrupts a running turn without pausing the existing queue (requestId: nil).
            if currentRevision != nil && session.state == .running {
                try? await model.interrupt(targetKey, requestId: nil)
            }
            let queued = currentRevision == nil && !wasStopped
                && (session.state == .running || session.state == .waiting)
                && ((session.liveIn == .nexbot && session.terminal != nil) || (session.engine == .claude && session.sendVia == "inbox") || managedProtocol)

            if queued {
                try await model.enqueue(targetKey, text: message)
                pending.removeAll { $0.id == entry.id }
            } else if try await model.send(targetKey, text: message, revisesMessageId: currentRevision?.messageId)?.nativeQueued == true,
                      let index = pending.firstIndex(where: { $0.id == entry.id }) {
                pending[index].nativeQueued = true
            }
            if currentRevision != nil { revision = nil }
            // Delete notes that were consumed in this send (best-effort)
            for note in submittedNotes {
                try? await model.deleteNote(id: note.id, expectedVersion: note.version)
            }
            if targetKey != session.key { onKeyChange(targetKey) }
        } catch {
            pending.removeAll { $0.id == entry.id }
            if draft.isEmpty && images.isEmpty && files.isEmpty {
                draft = rawDraft; images = submittedImages; files = submittedFiles; notes = submittedNotes
            }
            self.error = CliErrorText.text(for: error, fallback: "没能发送")
        }
    }

    private func interrupt() async {
        error = ""
        do { try await model.interrupt(session.key) } catch { self.error = CliErrorText.text(for: error) }
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
                    Circle().stroke(Theme.nexAgentBorder, lineWidth: 2.2)
                    Circle().trim(from: 0, to: max(0.04, share)).stroke(color, style: StrokeStyle(lineWidth: 2.2, lineCap: .round)).rotationEffect(.degrees(-90))
                } else {
                    Circle().stroke(Theme.nexAgentMuted, style: StrokeStyle(lineWidth: 1.4, dash: [2, 2]))
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
                    Text("上下文").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.nexAgentInk)
                    Spacer()
                    if let share = CliContext.share(usage) { Text("\(Int((share * 100).rounded()))%").font(.system(size: 15, weight: .semibold)).monospacedDigit() }
                }
                if let share = CliContext.share(usage) {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Theme.nexAgentInset)
                            Capsule().fill(color).frame(width: max(4, geo.size.width * share))
                        }
                    }
                    .frame(height: 6)
                }
                Text(detail).font(.caption).foregroundStyle(Theme.nexAgentMuted).monospacedDigit()
            }
            .padding(14).frame(width: 240)
            .background(Theme.nexAgentSurface)
            #if os(iOS)
            .presentationCompactAdaptation(.popover)
            #endif
        }
    }

    private var detail: String {
        guard let usage else { return "暂无记录" }
        guard let window = usage.window else { return "已用 \(CliContext.tokens(usage.used)) tokens" }
        return "已用 \(CliContext.tokens(usage.used)) / \(CliContext.tokens(window)) tokens"
    }
}

import SwiftUI
import NexClientKit

extension CliTone {
    var color: Color {
        switch self {
        case .running: Theme.nexAgentAccent
        case .waiting: Theme.approval
        case .idle: Theme.nexAgentAccent
        case .stopped, .offline: Theme.offline
        }
    }
}

/// A short status label in the colour of its tone.
struct CliChip: View {
    let text: String
    let tone: CliTone

    var body: some View {
        Text(text).font(.system(size: 11, weight: .medium)).foregroundStyle(tone.color)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(tone.color.opacity(0.14), in: Capsule())
    }
}

private enum AgentSheet: Identifiable {
    case supervision
    var id: String { "supervision" }
}

/// "Agent 会话": the coding-agent sessions of the person's computers. A list by computer and project; on the Mac the
/// open session (or the new-session page) sits beside it, on the iPhone it is pushed.
struct AgentSessionsView: View {
    let model: CliAgentsModel
    let workspace: WorkspaceStore
    /// After 交给助手: show the assistant's conversation.
    let openAssistant: (String) -> Void
    @Environment(\.scenePhase) private var scenePhase
    @State private var sheet: AgentSheet?
    @State private var errorText = ""
    @State private var deleting: CliSession?
    /// the new-session page, while it is open
    @State private var composing: AgentNewTarget?
    #if os(iOS)
    @State private var pushed: CliSessionKey?
    #endif

    var body: some View {
        layout
            .task { model.start() }
            #if os(macOS)
            // Leaving the section ends the live link unless notifications keep it open.
            .onDisappear { if !model.notificationsOn { model.stop() } }
            #endif
            .onChange(of: scenePhase) { _, phase in sceneChanged(phase) }
            .sheet(item: $sheet) { _ in AgentSupervisionSheet(model: model) }
            .alert("删除会话？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { session in
                Button("取消", role: .cancel) { deleting = nil }
                Button("删除会话", role: .destructive) {
                    let target = session
                    deleting = nil
                    Task {
                        do { try await model.deleteSession(target.key) } catch { errorText = CliErrorText.text(for: error) }
                    }
                }
            } message: { session in
                Text("将永久删除「\(CliSessions.title(session))」在电脑上的原生会话记录，无法恢复。")
            }
    }

    private func sceneChanged(_ phase: ScenePhase) {
        if phase == .active { model.reconnect(); return }
        // Pushing a session also hides this view on the iPhone, so the link closes when the app leaves the screen instead.
        #if os(iOS)
        if phase == .background, !model.notificationsOn { model.stop() }
        #endif
    }

    private var linkText: String {
        switch model.link {
        case .connecting: "正在连接"
        case .reconnecting: "正在重新连接"
        case .closed: "连接已断开"
        case .idle, .open: ""
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("Agent 会话").font(.title2.bold())
            if !linkText.isEmpty { Text(linkText).font(.caption).foregroundStyle(Theme.muted) }
            Spacer()
            headerActions
        }
    }

    @ViewBuilder private var headerActions: some View {
        Button { Task { await toggleBell() } } label: {
            Image(systemName: model.notificationsOn ? "bell.fill" : "bell.slash")
        }
        .buttonStyle(.plain).foregroundStyle(model.notificationsOn ? Theme.nexAgentAccent : Theme.muted)
        .help(model.notificationsOn ? "关闭通知" : "开启通知").accessibilityLabel(model.notificationsOn ? "关闭通知" : "开启通知")
        Button { sheet = .supervision } label: { Image(systemName: "gearshape") }
            .buttonStyle(.plain).foregroundStyle(Theme.muted)
            .help("自动处理设置").accessibilityLabel("自动处理设置")
    }

    private var banner: some View {
        let text = !errorText.isEmpty ? errorText : (model.loadError ?? "")
        return Group {
            if !text.isEmpty {
                HStack {
                    Text(text).font(.caption).foregroundStyle(Theme.danger)
                    Button("重新加载") { errorText = ""; Task { await model.refresh() } }.font(.caption).buttonStyle(.plain).foregroundStyle(Theme.nexAgentAccent)
                }
            }
        }
    }

    private func list(onSelect: @escaping (CliSessionKey) -> Void) -> some View {
        AgentSessionList(
            model: model,
            selected: composing == nil ? model.selectedKey : nil,
            onSelect: { key in composing = nil; onSelect(key) },
            onCreate: { composing = AgentNewTarget(deviceId: model.selected?.deviceId, cwd: model.selected?.cwd) },
            onNew: { composing = AgentNewTarget(deviceId: $0, cwd: $1) },
            onArchive: { session, archived in
                Task {
                    do { try await model.archiveSession(session.key, archived: archived) } catch { errorText = CliErrorText.text(for: error) }
                }
            },
            onDelete: { session in deleting = session })
    }

    private func toggleBell() async {
        if model.notificationsOn { model.setNotifications(false); return }
        model.setNotifications(await AgentNotifier.requestAuthorization())
    }

    #if os(macOS)
    private var layout: some View {
        VStack(spacing: 14) {
            header
            banner
            HStack(spacing: 14) {
                list { model.select($0) }
                    .frame(width: 300)
                    .glass(RoundedRectangle(cornerRadius: 18, style: .continuous), strong: true, lift: .card)
                Group {
                    if let target = composing {
                        AgentNewSessionPage(model: model, target: target) { _ in composing = nil }.id(target.id)
                    } else if let launch = model.selectedLaunch {
                        AgentLaunchDetail(model: model, launch: launch).id(launch.id)
                    } else if let key = model.selectedKey, model.selected != nil {
                        AgentSessionDetail(model: model, workspace: workspace, key: key, openAssistant: openAssistant) { model.select($0) }
                            .id(key)
                    } else {
                        Text("选择一个会话").foregroundStyle(Theme.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                .glass(RoundedRectangle(cornerRadius: 18, style: .continuous), strong: true, lift: .card)
            }
        }
        .padding(20).background { WorkspaceSurface(kind: .stage) }
    }
    #else
    private var layout: some View {
        VStack(spacing: 10) {
            if !linkText.isEmpty { Text(linkText).font(.caption).foregroundStyle(Theme.muted) }
            banner
            list { key in model.select(key); pushed = key }
        }
        .padding(.horizontal, 16).padding(.top, 8)
        .background { WorkspaceSurface(kind: .stage) }
        .navigationTitle("NexAgent")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) { headerActions }
        }
        .navigationDestination(item: $pushed) { key in
            Group {
                if let launch = model.launches.first(where: { $0.key == key }) {
                    AgentLaunchDetail(model: model, launch: launch).id(launch.id)
                } else {
                    AgentSessionDetail(model: model, workspace: workspace, key: key, openAssistant: openAssistant) { next in
                        guard pushed == key else { return }
                        model.select(next); pushed = next
                    }
                    .id(key)
                }
            }
            .background { WorkspaceSurface(kind: .stage) }
            .toolbar(.visible, for: .navigationBar)
        }
        .navigationDestination(item: $composing) { target in
            AgentNewSessionPage(model: model, target: target) { key in
                composing = nil
                // the page leaves first, then the new session is pushed in its place
                DispatchQueue.main.async { pushed = key }
            }
            .background { WorkspaceSurface(kind: .stage) }
            .toolbar(.visible, for: .navigationBar)
        }
        .onChange(of: model.selectedKey) { previous, next in
            if CliLaunches.isLaunchKey(previous), pushed == previous { pushed = next }
        }
    }
    #endif
}

/// A new-session button, what is running pinned on top, then computers (only when there are several), projects and sessions.
struct AgentSessionList: View {
    let model: CliAgentsModel
    let selected: CliSessionKey?
    let onSelect: (CliSessionKey) -> Void
    let onCreate: () -> Void
    let onNew: (String, String?) -> Void
    let onArchive: (CliSession, Bool) -> Void
    let onDelete: (CliSession) -> Void
    @AppStorage("nexagent.activeFolded") private var activeFolded = false

    var body: some View {
        let groups = model.groups
        let pending = model.pendingCounts
        let active = model.activeSessions
        // one computer that is online needs no computer row: its projects are the list
        let single = groups.count == 1 && groups.first?.device.online == true
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                Button(action: onCreate) {
                    Label("新建会话", systemImage: "plus").font(.system(size: 13, weight: .semibold))
                        .frame(maxWidth: .infinity).frame(height: 34)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border))
                }
                .buttonStyle(.plain).foregroundStyle(Theme.foreground)
                .disabled(model.devices.isEmpty)
                if !model.loaded {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 24)
                } else if groups.isEmpty {
                    Text("还没有电脑接入").font(.footnote).foregroundStyle(Theme.muted).frame(maxWidth: .infinity).padding(.top, 24)
                }
                if !active.isEmpty { pinned(active, pending: pending) }
                ForEach(groups) { group in device(group, pending: pending, single: single) }
                if model.hiddenCount > 0 {
                    Button(model.showHidden ? "收起已归档" : "已归档 \(model.hiddenCount)") { model.showHidden.toggle() }
                        .buttonStyle(.plain).font(.caption).foregroundStyle(Theme.muted)
                }
            }
            .padding(12)
        }
    }

    /// Running or waiting sessions on every computer; folds to its heading, which still counts them and says when one waits.
    private func pinned(_ active: [CliSession], pending: [CliSessionKey: Int]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Button { activeFolded.toggle() } label: {
                HStack(spacing: 5) {
                    Image(systemName: activeFolded ? "chevron.right" : "chevron.down").font(.system(size: 9, weight: .semibold))
                    Text("进行中").font(.system(size: 11, weight: .semibold))
                    if activeFolded, active.contains(where: { $0.state == .waiting }) {
                        Circle().fill(Theme.approval).frame(width: 6, height: 6).accessibilityLabel("有会话等你处理")
                    }
                    Spacer()
                    Text("\(active.count)").font(.system(size: 11))
                }
                .foregroundStyle(Theme.muted).padding(.horizontal, 6).padding(.vertical, 3).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(activeFolded ? "展开进行中" : "收起进行中")
            if !activeFolded {
                ForEach(active) { session in row(session, asked: pending[session.key] ?? 0, context: CliSessions.projectLabel(session)) }
            }
            Divider().padding(.top, 4)
        }
    }

    private func device(_ group: CliDeviceGroup, pending: [CliSessionKey: Int], single: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if !single {
                HStack(spacing: 6) {
                    Circle().fill(group.device.online ? Theme.success : Theme.offline).frame(width: 7, height: 7)
                    Text(group.device.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Text(group.device.online ? "\(group.count)" : "离线").font(.caption).foregroundStyle(Theme.muted)
                    Spacer()
                    Button { onNew(group.device.id, nil) } label: { Image(systemName: "plus") }
                        .buttonStyle(.plain).foregroundStyle(Theme.muted)
                        .accessibilityLabel("在 \(group.device.name) 上新建会话")
                }
            }
            ForEach(group.folders) { folder in
                HStack(spacing: 6) {
                    Text(folder.label).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.foreground).lineLimit(1)
                    Spacer()
                    if !folder.scratch && !folder.cwd.isEmpty {
                        Button { onNew(group.device.id, folder.cwd) } label: {
                            Image(systemName: "plus").font(.system(size: 12)).frame(width: 28, height: 28)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(Theme.muted)
                        .help("新建会话")
                        .accessibilityLabel("在 \(folder.label) 中新建会话")
                    }
                    Text("\(folder.sessions.count)").font(.system(size: 11)).foregroundStyle(Theme.muted)
                }
                .padding(.horizontal, 6).padding(.top, 8).padding(.bottom, 2)
                .help(folder.roots.count > 1 ? folder.roots.joined(separator: "\n") : (folder.cwd.isEmpty ? folder.label : folder.cwd))
                ForEach(folder.sessions) { session in row(session, asked: pending[session.key] ?? 0, context: nil) }
            }
            if group.count == 0 { Text("暂无会话").font(.caption).foregroundStyle(Theme.muted) }
        }
    }

    private func row(_ session: CliSession, asked: Int, context: String?) -> some View {
        let tone = CliSessions.tone(session)
        let waiting = asked > 0 || tone == .waiting
        let waitingLabel = asked > 1 ? "等你处理 \(asked)" : "等你处理"
        let archived = CliSessions.isArchived(session)
        let dev = model.device(session.deviceId)
        let manageBlocked = dev.map { !$0.online || !($0.cliAgents?.features.contains("sessionManage") ?? false) } ?? !session.online
        return HStack(spacing: 8) {
            Button { onSelect(session.key) } label: {
                HStack(spacing: 8) {
                    // the dot is the state: green breathing while it runs, amber while it waits for you
                    AgentStateDot(tone: tone)
                    Text(CliSessions.title(session)).font(.system(size: 13, weight: selected == session.key ? .semibold : .regular))
                        .foregroundStyle(Theme.foreground).lineLimit(1)
                    Spacer(minLength: 4)
                    if let context { Text(context).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1) }
                    if waiting { CliChip(text: waitingLabel, tone: .waiting).fixedSize() }
                }
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(CliSessions.title(session))，\(agentName(session.engine))，\(waiting ? waitingLabel : CliSessions.statusLabel(session))")
            Menu {
                Button { onArchive(session, !archived) } label: {
                    Label(archived ? "恢复会话" : "归档会话", systemImage: archived ? "arrow.uturn.backward" : "archivebox")
                }
                .disabled(manageBlocked && !(archived && session.hidden && !session.archived))
                Button(role: .destructive) { onDelete(session) } label: {
                    Label("删除会话", systemImage: "trash")
                }
                .disabled(manageBlocked)
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 11)).frame(width: 24, height: 22).contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            #if os(macOS)
            .menuIndicator(.hidden)
            #endif
            .fixedSize()
            .foregroundStyle(Theme.muted.opacity(0.75))
            .accessibilityLabel("\(CliSessions.title(session))的操作")
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(selected == session.key ? Theme.nexAgentSoft : .clear, in: RoundedRectangle(cornerRadius: 8))
        .overlay(alignment: .leading) { if selected == session.key { Rectangle().fill(Theme.nexAgentAccent).frame(width: 2.5).padding(.vertical, 4) } }
        .opacity(archived ? 0.55 : 1)
        .help("\(agentName(session.engine)) · \(CliSessions.statusLabel(session))")
    }
}

/// A session's state as a dot; idle and stopped show none (a clear dot keeps titles aligned).
struct AgentStateDot: View {
    let tone: CliTone
    @State private var breathing = false
    var body: some View {
        Circle()
            .fill(tone == .running ? Theme.nexAgentAccent : tone == .waiting ? Theme.approval : .clear)
            .frame(width: 8, height: 8)
            .overlay(Circle().stroke(tone == .running ? Theme.nexAgentAccent.opacity(breathing ? 0 : 0.35) : .clear, lineWidth: breathing ? 6 : 1))
            .onAppear { if tone == .running { withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: false)) { breathing = true } } }
            .accessibilityHidden(true)
    }
}

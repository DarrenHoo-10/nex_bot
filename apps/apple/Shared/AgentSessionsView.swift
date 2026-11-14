import SwiftUI
import NexClientKit

extension CliTone {
    var color: Color {
        switch self {
        case .running: Theme.success
        case .waiting: Theme.approval
        case .idle: Theme.identityAccent
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
    case create(deviceId: String?)
    case supervision

    var id: String {
        switch self {
        case .create(let deviceId): "create-\(deviceId ?? "")"
        case .supervision: "supervision"
        }
    }
}

/// "Agent 会话": the coding-agent sessions of the person's computers. A list by computer and folder; on the Mac the
/// open session sits beside it, on the iPhone it is pushed.
struct AgentSessionsView: View {
    let model: CliAgentsModel
    let workspace: WorkspaceStore
    /// After 交给助手: show the assistant's conversation.
    let openAssistant: (String) -> Void
    @Environment(\.scenePhase) private var scenePhase
    @State private var sheet: AgentSheet?
    @State private var errorText = ""
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
            .sheet(item: $sheet) { sheet in
                switch sheet {
                case .create(let deviceId):
                    AgentNewSessionSheet(model: model, initialDeviceId: deviceId) { started in
                        #if os(iOS)
                        pushed = started
                        #endif
                    }
                case .supervision:
                    AgentSupervisionSheet(model: model)
                }
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
            if model.waitingCount > 0 { CliChip(text: "等你处理 \(model.waitingCount)", tone: .waiting) }
            Spacer()
            Button { Task { await toggleBell() } } label: {
                Image(systemName: model.notificationsOn ? "bell.fill" : "bell.slash")
            }
            .buttonStyle(.plain).foregroundStyle(model.notificationsOn ? Theme.identityAccent : Theme.muted)
            .help(model.notificationsOn ? "关闭通知" : "开启通知").accessibilityLabel(model.notificationsOn ? "关闭通知" : "开启通知")
            Button { sheet = .supervision } label: { Image(systemName: "gearshape") }
                .buttonStyle(.plain).foregroundStyle(Theme.muted)
                .help("自动处理设置").accessibilityLabel("自动处理设置")
            Button { sheet = .create(deviceId: model.selected?.deviceId) } label: { Label("新建会话", systemImage: "plus") }
                .buttonStyle(.borderedProminent).tint(Theme.identityAccent)
                .disabled(model.devices.isEmpty)
        }
    }

    private var banner: some View {
        let text = !errorText.isEmpty ? errorText : (model.loadError ?? "")
        return Group {
            if !text.isEmpty {
                HStack {
                    Text(text).font(.caption).foregroundStyle(Theme.danger)
                    Button("重新加载") { errorText = ""; Task { await model.refresh() } }.font(.caption).buttonStyle(.plain).foregroundStyle(Theme.identityAccent)
                }
            }
        }
    }

    private func list(onSelect: @escaping (CliSessionKey) -> Void) -> some View {
        AgentSessionList(
            model: model,
            selected: model.selectedKey,
            onSelect: onSelect,
            onNew: { sheet = .create(deviceId: $0) },
            onHide: { session, hidden in
                Task {
                    do { try await model.setHidden(session.key, hidden) } catch { errorText = CliErrorText.text(for: error) }
                }
            })
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
                    if let key = model.selectedKey, model.selected != nil {
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
            header
            banner
            list { key in model.select(key); pushed = key }
        }
        .padding(.horizontal, 16).padding(.top, 8)
        .background { WorkspaceSurface(kind: .stage) }
        .navigationDestination(item: $pushed) { key in
            AgentSessionDetail(model: model, workspace: workspace, key: key, openAssistant: openAssistant) { next in
                model.select(next); pushed = next
            }
            .id(key)
            .background { WorkspaceSurface(kind: .stage) }
            .toolbar(.visible, for: .navigationBar)
        }
    }
    #endif
}

/// Computers, then folders, then sessions.
struct AgentSessionList: View {
    let model: CliAgentsModel
    let selected: CliSessionKey?
    let onSelect: (CliSessionKey) -> Void
    let onNew: (String) -> Void
    let onHide: (CliSession, Bool) -> Void

    var body: some View {
        let groups = model.groups
        let pending = model.pendingCounts
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if !model.loaded {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 24)
                } else if groups.isEmpty {
                    Text("还没有电脑接入").font(.footnote).foregroundStyle(Theme.muted).frame(maxWidth: .infinity).padding(.top, 24)
                }
                ForEach(groups) { group in device(group, pending: pending) }
                if model.hiddenCount > 0 {
                    Button(model.showHidden ? "收起已隐藏" : "已隐藏 \(model.hiddenCount)") { model.showHidden.toggle() }
                        .buttonStyle(.plain).font(.caption).foregroundStyle(Theme.muted)
                }
            }
            .padding(12)
        }
    }

    private func device(_ group: CliDeviceGroup, pending: [CliSessionKey: Int]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Circle().fill(group.device.online ? Theme.success : Theme.offline).frame(width: 7, height: 7)
                Text(group.device.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Text(group.device.online ? "\(group.count)" : "离线").font(.caption).foregroundStyle(Theme.muted)
                Spacer()
                Button { onNew(group.device.id) } label: { Image(systemName: "plus") }
                    .buttonStyle(.plain).foregroundStyle(Theme.muted)
                    .accessibilityLabel("在 \(group.device.name) 上新建会话")
            }
            ForEach(group.folders) { folder in
                Text(folder.label).font(.system(size: 11)).foregroundStyle(Theme.muted).padding(.top, 2)
                ForEach(folder.sessions) { session in row(session, asked: pending[session.key] ?? 0) }
            }
            if group.count == 0 { Text("暂无会话").font(.caption).foregroundStyle(Theme.muted) }
        }
    }

    private func row(_ session: CliSession, asked: Int) -> some View {
        HStack(spacing: 6) {
            Button { onSelect(session.key) } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(CliSessions.title(session)).font(.system(size: 13)).foregroundStyle(Theme.foreground).lineLimit(1)
                    HStack(spacing: 6) {
                        CliChip(text: CliSessions.statusLabel(session), tone: CliSessions.tone(session))
                        if asked > 0 {
                            Text("\(asked)").font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
                                .padding(.horizontal, 6).padding(.vertical, 1).background(Theme.approval, in: Capsule())
                                .accessibilityLabel("\(asked) 个请求")
                        }
                        Text(session.engine.label).font(.caption2).foregroundStyle(Theme.muted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Button { onHide(session, !session.hidden) } label: { Image(systemName: session.hidden ? "eye" : "eye.slash") }
                .buttonStyle(.plain).foregroundStyle(Theme.muted)
                .accessibilityLabel(session.hidden ? "取消隐藏" : "隐藏")
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(selected == session.key ? Theme.wash : .clear, in: RoundedRectangle(cornerRadius: 10))
        .opacity(session.hidden ? 0.55 : 1)
    }
}

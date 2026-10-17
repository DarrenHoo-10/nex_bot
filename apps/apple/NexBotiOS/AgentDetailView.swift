import SwiftUI
import NexClientKit

/// The agent's 助手详情 screen: header plus 工作 / 资料 / 设置 tabs (`Navigation.detailTab`).
struct AgentDetailView: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(Navigation.self) private var nav
    @Environment(ContactPreferences.self) private var preferences
    @State private var sheet: Sheet?
    @State private var errorText: String?
    @State private var busyTask: String?
    @State private var ranRoutine: String?

    enum Sheet: Identifiable {
        case identity, avatar, routine(Routine?)
        var id: String {
            switch self {
            case .identity: "identity"
            case .avatar: "avatar"
            case .routine(let r): "routine-\(r?.id ?? "new")"
            }
        }
    }

    private var bot: Bot? { workspace.bot(botID) }
    private var tasks: [AgentTask] { workspace.state?.unfinishedTasks(botID: botID) ?? [] }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                Picker("详情", selection: Bindable(nav).detailTab) {
                    ForEach(AgentDetailTab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                switch nav.detailTab {
                case .work: work
                case .memory: AgentMemoryTab(workspace: workspace, botID: botID)
                case .settings: AgentSettingsTab(workspace: workspace, botID: botID)
                }
            }
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.background)
        .navigationTitle("助手详情")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .refreshable { await workspace.refresh() }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .identity: AgentEditorSheet(workspace: workspace, botID: botID)
            case .avatar: AvatarPickerSheet(workspace: workspace, botID: botID)
            case .routine(let routine): RoutineEditorSheet(workspace: workspace, botID: botID, existing: routine)
            }
        }
        .errorAlert($errorText)
        .debugCommand { command, _ in
            switch command {
            case "identity": sheet = .identity
            case "avatarpicker": sheet = .avatar
            case "routine": sheet = .routine(nil)
            case "routineedit": if let r = workspace.state?.routines(botID: botID).first { sheet = .routine(r) }
            case "pin": preferences.togglePin(botID)
            case "workstop": if let t = tasks.first { Task { await run(t.id) { try await workspace.cancelTask(t.id) } } }
            case "resume": if let t = tasks.first(where: { $0.status == "paused" }) { Task { await run(t.id) { try await workspace.resumeTask(t.id) } } }
            case "runroutine": if let r = workspace.state?.routines(botID: botID).first { Task { await runNow(r) } }
            case "togglefirstroutine": if let r = workspace.state?.routines(botID: botID).first { Task { await toggle(r, !r.enabled) } }
            default: break
            }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .top, spacing: 14) {
            if let bot { workspace.avatar(of: bot, size: 64) }
            VStack(alignment: .leading, spacing: 6) {
                Text(bot?.name ?? "").font(.headline).lineLimit(2)
                Text("个人 Agent").font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
                    .padding(.horizontal, 8).padding(.vertical, 2).background(Theme.secondary, in: Capsule())
                HStack(spacing: 6) {
                    Button("编辑身份") { sheet = .identity }
                    Text("·").foregroundStyle(Theme.muted)
                    Button("更换头像") { sheet = .avatar }
                }
                .font(.footnote).foregroundStyle(Theme.brand).buttonStyle(.plain)
            }
            Spacer(minLength: 0)
            let pinned = preferences.isPinned(botID)
            Button { preferences.togglePin(botID) } label: {
                Image(systemName: pinned ? "pin.fill" : "pin").font(.system(size: 15, weight: .medium))
                    .frame(width: 36, height: 36)
                    .foregroundStyle(pinned ? Theme.brand : Theme.muted)
                    .background(pinned ? Theme.brandSoft : Theme.secondary, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(pinned ? "取消置顶" : "置顶联系人")
        }
    }

    // MARK: 工作

    @ViewBuilder private var work: some View {
        let state = workspace.state
        VStack(alignment: .leading, spacing: 6) {
            Text(tasks.first.map(\.phrase) ?? "准备就绪").font(.subheadline.weight(.bold))
            Text(tasks.first.map { String($0.objective.prefix(90)) } ?? "发一条消息，开始新的工作。").font(.footnote).foregroundStyle(Theme.muted)
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading).cardStyle()

        if !tasks.isEmpty {
            section("正在处理") {
                ForEach(tasks) { task in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(task.phrase).font(.caption2.weight(.semibold)).foregroundStyle(Theme.brand)
                            .padding(.horizontal, 8).padding(.vertical, 2).background(Theme.brandSoft, in: Capsule())
                        Text(task.objective.isEmpty ? "Agent 工作" : task.objective).font(.footnote).lineLimit(4)
                        HStack(spacing: 8) {
                            if task.status == "paused" {
                                Button("继续") { Task { await run(task.id) { try await workspace.resumeTask(task.id) } } }
                                    .buttonStyle(PillButtonStyle(primary: true))
                            }
                            Button("停止") { Task { await run(task.id) { try await workspace.cancelTask(task.id) } } }
                                .buttonStyle(PillButtonStyle())
                                .disabled(task.status == "cancelling")
                            if busyTask == task.id { ProgressView() }
                        }
                        .disabled(busyTask == task.id)
                    }
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading).cardStyle()
                }
            }
        }

        let occurrences = state?.occurrences(botID: botID) ?? []
        if !occurrences.isEmpty {
            section("最近执行") {
                VStack(spacing: 0) {
                    ForEach(occurrences) { o in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(o.name).font(.subheadline).lineLimit(1)
                            Text(o.summary).font(.caption).foregroundStyle(Theme.muted)
                        }
                        .padding(.vertical, 6).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }

        let connectors = state?.connectors(grantedTo: botID) ?? []
        section("连接器", trailing: ("plus", "管理连接器", { nav.openConnectors() })) {
            ForEach(connectors) { connector in
                Button { nav.openConnectors() } label: {
                    HStack {
                        Image(systemName: "puzzlepiece.extension").foregroundStyle(Theme.muted)
                        Text(connector.name).font(.subheadline).lineLimit(1)
                        Spacer()
                        Text("\(connector.grant(for: botID)?.tools.count ?? 0) 项工具").font(.caption).foregroundStyle(Theme.muted)
                    }
                }
                .buttonStyle(.plain)
            }
            Button { nav.openConnectors() } label: { Text("连接工具与管理授权 →").font(.footnote) }
                .foregroundStyle(Theme.brand).buttonStyle(.plain)
        }

        section("可用设备") {
            let devices = state?.boundDevices ?? []
            if devices.isEmpty { Text("还没有可用设备。").font(.footnote).foregroundStyle(Theme.muted) }
            ForEach(devices) { device in
                HStack {
                    Image(systemName: "cpu").foregroundStyle(Theme.muted)
                    Text(device.name).font(.subheadline).lineLimit(1)
                    Spacer()
                    Text(device.online ? "在线" : "离线").font(.caption2)
                        .foregroundStyle(device.online ? Theme.success : Theme.muted)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(device.online ? Theme.successSoft : Theme.secondary, in: Capsule())
                }
            }
            Button { nav.openDevices() } label: { Text("管理设备网络 →").font(.footnote) }
                .foregroundStyle(Theme.brand).buttonStyle(.plain)
        }

        section("例行任务", trailing: ("plus", "添加例行任务", { sheet = .routine(nil) })) {
            let routines = state?.routines(botID: botID) ?? []
            if routines.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("安排一项例行任务，Agent 会按计划工作并给你汇报。").font(.footnote).foregroundStyle(Theme.muted)
                    Button("添加例行任务") { sheet = .routine(nil) }.buttonStyle(PillButtonStyle())
                }
            }
            ForEach(routines) { routine in routineRow(routine) }
        }
    }

    private func routineRow(_ routine: Routine) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(routine.name).font(.subheadline.weight(.medium)).lineLimit(1)
                Spacer()
                Toggle("", isOn: Binding(get: { routine.enabled }, set: { value in Task { await toggle(routine, value) } }))
                    .labelsHidden().tint(Theme.success)
                    .accessibilityLabel(routine.enabled ? "暂停\(routine.name)" : "启用\(routine.name)")
            }
            Text(routine.label).font(.caption).foregroundStyle(Theme.muted)
            HStack(spacing: 8) {
                Button("编辑") { sheet = .routine(routine) }.buttonStyle(PillButtonStyle())
                Button(ranRoutine == routine.id ? "已提交" : "现在执行") { Task { await runNow(routine) } }
                    .buttonStyle(PillButtonStyle())
                Spacer()
                if routine.enabled, let next = routine.nextDueAt {
                    Text("下次 \(TimeFormat.formatTime(next))").font(.caption2).foregroundStyle(Theme.muted)
                }
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading).cardStyle()
    }

    // MARK: Actions

    private func run(_ id: String, _ action: () async throws -> Void) async {
        busyTask = id
        defer { busyTask = nil }
        do { try await action() } catch { errorText = message(of: error) }
    }

    private func toggle(_ routine: Routine, _ enabled: Bool) async {
        do { try await workspace.setRoutineEnabled(routine, enabled: enabled) } catch { errorText = message(of: error) }
    }

    private func runNow(_ routine: Routine) async {
        do {
            try await workspace.runRoutine(routine)
            ranRoutine = routine.id
            try? await Task.sleep(for: .seconds(2))
            if ranRoutine == routine.id { ranRoutine = nil }
        } catch { errorText = message(of: error) }
    }

    private func section<C: View>(_ title: String, trailing: (icon: String, label: String, action: () -> Void)? = nil, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: title, trailing: trailing)
            content()
        }
    }
}

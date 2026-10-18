import SwiftUI
import NexClientKit

/// The agent's 助手详情 screen: header plus 工作 / 设置 tabs (`Navigation.detailTab`).
struct AgentDetailView: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(Navigation.self) private var nav
    @Environment(ContactPreferences.self) private var preferences
    @State private var sheet: Sheet?
    @State private var errorText: String?
    @State private var busyTask: String?
    /// The routine whose switch is submitting; every switch is disabled meanwhile.
    @State private var togglingRoutine: String?

    enum Sheet: Identifiable {
        case avatar, routine(Routine?)
        var id: String {
            switch self {
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
            case .avatar: AvatarPickerSheet(workspace: workspace, botID: botID)
            case .routine(let routine): RoutineEditorSheet(workspace: workspace, botID: botID, existing: routine)
            }
        }
        .errorAlert($errorText)
        .debugCommand { command, _ in
            switch command {
            case "avatarpicker": sheet = .avatar
            case "routine": sheet = .routine(nil)
            case "routineedit": if let r = workspace.state?.routines(botID: botID).first { sheet = .routine(r) }
            case "pin": preferences.togglePin(botID)
            case "workstop": if let t = tasks.first { Task { await run(t.id) { try await workspace.cancelTask(t.id) } } }
            case "resume": if let t = tasks.first(where: { $0.status == "paused" }) { Task { await run(t.id) { try await workspace.resumeTask(t.id) } } }
            case "togglefirstroutine": if let r = workspace.state?.routines(botID: botID).first { Task { await toggle(r, !r.enabled) } }
            default: break
            }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            if let bot {
                Button { sheet = .avatar } label: { workspace.avatar(of: bot, size: 64, animated: true) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("更换 \(bot.name) 的头像")
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(bot?.name ?? "").font(.headline).lineLimit(2)
                Text("个人 Agent").font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
                    .padding(.horizontal, 8).padding(.vertical, 2).background(Theme.secondary, in: Capsule())
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
        if let preview = PreviewCenter.shared.items[botID] {
            PreviewCard(item: preview) { PreviewCenter.shared.items[botID] = nil }
        }

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

        let routines = state?.routines(botID: botID) ?? []
        section("例行任务", trailing: ("plus", "添加例行任务", { sheet = .routine(nil) })) {
            if !routines.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(routines.enumerated()), id: \.element.id) { index, routine in
                        if index > 0 { Divider().overlay(Theme.border).padding(.leading, 14) }
                        routineRow(routine)
                    }
                }
                .cardStyle(radius: 16)
                .accessibilityLabel("例行任务列表")
            }
        }
    }

    private func routineRow(_ routine: Routine) -> some View {
        HStack(spacing: 12) {
            Button { sheet = .routine(routine) } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(routine.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text("\(routine.label) · \(routine.prompt)").font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Toggle(routine.name, isOn: Binding(get: { routine.enabled }, set: { value in Task { await toggle(routine, value) } }))
                .labelsHidden().tint(Theme.brand)
                .disabled(togglingRoutine != nil)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
    }

    // MARK: Actions

    private func run(_ id: String, _ action: () async throws -> Void) async {
        busyTask = id
        defer { busyTask = nil }
        do { try await action() } catch { errorText = message(of: error) }
    }

    private func toggle(_ routine: Routine, _ enabled: Bool) async {
        guard togglingRoutine == nil else { return }
        togglingRoutine = routine.id
        defer { togglingRoutine = nil }
        do { try await workspace.setRoutineEnabled(routine, enabled: enabled) } catch { errorText = message(of: error) }
    }

    private func section<C: View>(_ title: String, trailing: (icon: String, label: String, action: () -> Void)? = nil, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: title, trailing: trailing)
            content()
        }
    }
}

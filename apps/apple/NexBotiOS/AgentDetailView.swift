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
                PillTabs(items: AgentDetailTab.allCases, title: { $0.rawValue }, selection: Bindable(nav).detailTab)
                switch nav.detailTab {
                case .work: work
                case .settings: AgentSettingsTab(workspace: workspace, botID: botID)
                }
            }
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background { WorkspaceSurface(kind: .stage) }
        .navigationTitle("助手详情")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .toolbarBackground(.ultraThinMaterial, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
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

    private var state: CompanionState { workspace.companionState(of: botID) }

    /// 在线, the current task phrase, or the label of the avatar state.
    private var heroState: String {
        if workspace.connection == .resyncing { return CompanionState.offline.label }
        if let first = tasks.first { return first.phrase }
        return state == .idle ? "在线" : state.label
    }

    private var heroDot: Color {
        switch state {
        case .approval, .offline, .paused: Theme.approval
        case .failed: Theme.danger
        default: Theme.success
        }
    }

    /// A large avatar with a soft halo, the name and the status; the pin sits in the corner.
    private var header: some View {
        VStack(spacing: 4) {
            if let bot {
                Button { sheet = .avatar } label: {
                    HeroHalo(accent: workspace.appearance(of: bot).accent) { workspace.avatar(of: bot, size: 96, animated: true) }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("更换 \(bot.name) 的头像")
            }
            Text(bot?.name ?? "").font(.system(size: 20, weight: .semibold)).tracking(-0.3).lineLimit(2).multilineTextAlignment(.center)
            HStack(spacing: 6) {
                Circle().fill(heroDot).frame(width: 7, height: 7).overlay(Circle().stroke(heroDot.opacity(0.2), lineWidth: 3))
                Text(heroState).font(.footnote).foregroundStyle(Theme.muted).lineLimit(1)
            }
            .accessibilityElement(children: .combine)
        }
        .frame(maxWidth: .infinity)
        .overlay(alignment: .topTrailing) {
            let pinned = preferences.isPinned(botID)
            Button { preferences.togglePin(botID) } label: {
                Image(systemName: pinned ? "pin.fill" : "pin").font(.system(size: 14, weight: .medium))
                    .foregroundStyle(pinned ? Theme.background : Theme.foreground)
                    .frame(width: 36, height: 36)
                    .background { Circle().fill(pinned ? Theme.foreground : .clear) }
                    .glass(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(pinned ? "取消置顶" : "置顶联系人")
        }
    }

    // MARK: 工作

    private func title(_ text: String, trailing: (icon: String, label: String, action: () -> Void)? = nil) -> some View {
        HStack {
            Text(text).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted)
            Spacer()
            if let trailing {
                Button(action: trailing.action) { Image(systemName: trailing.icon).font(.system(size: 15, weight: .medium)).frame(width: 32, height: 28) }
                    .buttonStyle(.plain).foregroundStyle(Theme.foreground).accessibilityLabel(trailing.label)
            }
        }
        .padding(.horizontal, 2).padding(.top, 8)
    }

    @ViewBuilder private var work: some View {
        let state = workspace.state
        if let preview = PreviewCenter.shared.items[botID] {
            PreviewCard(item: preview) { PreviewCenter.shared.items[botID] = nil }
        }

        VStack(alignment: .leading, spacing: 0) {
            if !tasks.isEmpty {
                title("正在处理")
                ForEach(tasks) { task in
                    RunEntryRow(symbol: "arrow.triangle.2.circlepath", tone: .live, title: task.objective.isEmpty ? "Agent 工作" : task.objective,
                                status: task.phrase, time: task.createdAt.map { TimeFormat.formatClock($0) }) {
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
                        .padding(.top, 6)
                    }
                }
            }

            let occurrences = state?.occurrences(botID: botID) ?? []
            if !occurrences.isEmpty {
                title("最近执行")
                ForEach(Array(occurrences.enumerated()), id: \.element.id) { index, o in
                    let day = o.scheduledAt.map { TimeFormat.dayLabel($0) } ?? ""
                    if !day.isEmpty, index == 0 || day != occurrences[index - 1].scheduledAt.map({ TimeFormat.dayLabel($0) }) {
                        DayLabel(text: day)
                    }
                    RunEntryRow(symbol: RunPresentation.symbol(o.status), tone: RunPresentation.tone(o.status), title: o.name,
                                status: o.statusText, time: o.scheduledAt.map { TimeFormat.formatClock($0) })
                }
            }

            let routines = state?.routines(botID: botID) ?? []
            if routines.isEmpty {
                title("例行任务")
                HStack {
                    Text("暂无例行任务").font(.footnote).foregroundStyle(Theme.muted)
                    Spacer()
                    Button { sheet = .routine(nil) } label: {
                        Image(systemName: "plus").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.foreground)
                            .frame(width: 30, height: 30).background(Theme.card, in: Circle())
                    }
                    .buttonStyle(.plain).accessibilityLabel("添加例行任务")
                }
                .padding(.leading, 14).padding(.trailing, 10).padding(.vertical, 10)
                .background(Theme.wash, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            } else {
                title("例行任务", trailing: ("plus", "添加例行任务", { sheet = .routine(nil) }))
                VStack(spacing: 0) {
                    ForEach(Array(routines.enumerated()), id: \.element.id) { index, routine in
                        if index > 0 { Divider().overlay(Theme.border).padding(.leading, 14) }
                        routineRow(routine)
                    }
                }
                .background(Theme.wash, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
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

import SwiftUI
import NexClientKit

/// Right panel "助手详情": a large avatar, the Agent's name and status, and the 工作 / 设置 tabs.
/// The selected tab lives in `UIState.inspectorTab`.
struct InspectorView: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(UIState.self) private var ui
    @Environment(ContactPreferences.self) private var preferences
    private var tab: InspectorTab { ui.inspectorTab }

    private var bot: Bot? { workspace.bot(botID) }
    private var state: CompanionState { workspace.companionState(botID) }
    private var tasks: [AgentTask] { workspace.state?.unfinishedTasks(botID: botID) ?? [] }

    /// 在线, the current task phrase, or the avatar state's label.
    private var heroState: String {
        if workspace.connection != .connected { return CompanionState.offline.label }
        if let first = tasks.first { return ToolLabels.taskPhrase(first) }
        return state == .idle ? "在线" : state.label
    }

    private var heroDot: Color {
        switch state {
        case .approval, .offline, .paused: Theme.approval
        case .failed: Theme.danger
        default: Theme.success
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            heading
            profile
            PillTabs(items: InspectorTab.allCases, title: { $0.rawValue }, selection: Bindable(ui).inspectorTab)
                .padding(.horizontal, 4).padding(.bottom, 6)
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    switch tab {
                    case .work: InspectorWorkTab(workspace: workspace, botID: botID)
                    case .settings: InspectorSettingsTab(workspace: workspace, botID: botID)
                    }
                }
                .padding(.horizontal, 4).padding(.bottom, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollIndicators(.never)
        }
        .padding(.horizontal, 14).padding(.top, 8)
    }

    private var heading: some View {
        let pinned = preferences.isPinned(botID)
        return HStack {
            RoundIconButton(symbol: pinned ? "pin.fill" : "pin", help: pinned ? "取消置顶" : "置顶联系人", selected: pinned, size: 30) {
                preferences.togglePin(botID)
            }
            Spacer()
            RoundIconButton(symbol: "xmark", help: "收起资料", size: 30) { ui.inspectorVisible = false }
        }
        .frame(height: 34)
    }

    private var profile: some View {
        VStack(spacing: 4) {
            Button { AgentUI.shared.pickAvatar(botID) } label: {
                HeroHalo(accent: bot.map { workspace.appearance($0).accent } ?? Color(hex: Theme.defaultAccent)) {
                    if let bot { AgentAvatar(appearance: workspace.appearance(bot), state: state, size: 96, animated: preferences.motionEnabled) }
                }
                .contentShape(Circle())
            }
            .buttonStyle(.plain).help("更换头像").accessibilityLabel("更换 \(bot?.name ?? "") 的头像")
            Text(bot?.name ?? "").font(.system(size: 17, weight: .semibold)).tracking(-0.3).lineLimit(2).multilineTextAlignment(.center)
            HStack(spacing: 6) {
                Circle().fill(heroDot).frame(width: 7, height: 7)
                    .overlay(Circle().stroke(heroDot.opacity(0.2), lineWidth: 3))
                Text(heroState).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
            }
            .accessibilityElement(children: .combine)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, -6).padding(.bottom, 12)
    }
}

/// A section title, optionally with a trailing "+" button.
struct InspectorSectionTitle: View {
    let title: String
    var addLabel: String?
    var add: (() -> Void)?

    var body: some View {
        HStack {
            Text(title).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Theme.muted)
            Spacer()
            if let addLabel, let add {
                Button(action: add) {
                    Image(systemName: "plus").font(.system(size: 13)).foregroundStyle(Theme.foreground).frame(width: 24, height: 24).contentShape(Rectangle())
                }
                .buttonStyle(.plain).help(addLabel).accessibilityLabel(addLabel)
            }
        }
        .padding(.horizontal, 2).padding(.top, 10)
    }
}

// MARK: - 工作

struct InspectorWorkTab: View {
    let workspace: WorkspaceStore
    let botID: String
    @State private var error: String?
    @State private var submitting = false

    private var tasks: [AgentTask] { workspace.state?.unfinishedTasks(botID: botID) ?? [] }

    var body: some View {
        let state = workspace.state
        if let item = AgentUI.shared.preview, AgentUI.shared.previewBotID == botID { PreviewCard(item: item) { AgentUI.shared.preview = nil } }
        if let error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled) }
        if !tasks.isEmpty {
            InspectorSectionTitle(title: "正在处理")
            ForEach(tasks) { task in activeTask(task) }
        }
        let occurrences = state?.occurrences(botID: botID) ?? []
        if !occurrences.isEmpty {
            InspectorSectionTitle(title: "最近执行")
            ForEach(Array(occurrences.enumerated()), id: \.element.id) { index, o in
                let day = o.scheduledAt.map { TimeFormat.dayLabel($0) } ?? ""
                if !day.isEmpty, index == 0 || day != occurrences[index - 1].scheduledAt.map({ TimeFormat.dayLabel($0) }) {
                    DayLabel(text: day)
                }
                RunEntryRow(symbol: RunPresentation.symbol(o.status), tone: RunPresentation.tone(o.status), title: o.name,
                            status: o.statusText, time: o.scheduledAt.map { TimeFormat.formatClock($0) })
            }
        }
        routines
    }

    // MARK: Cards

    private func activeTask(_ task: AgentTask) -> some View {
        RunEntryRow(symbol: "arrow.triangle.2.circlepath", tone: .live, title: task.objective.isEmpty ? "Agent 工作" : task.objective,
                    status: ToolLabels.taskPhrase(task), time: task.createdAt.map { TimeFormat.formatClock($0) }) {
            HStack(spacing: 8) {
                if task.status == "paused" {
                    pill("play.fill", "继续") { run { try await workspace.resumeTask(task.id) } }
                }
                pill("stop.fill", "停止") { run { try await workspace.cancelTask(task.id) } }
            }
            .padding(.top, 6)
        }
    }

    /// One rounded list: name and schedule on the left, a switch on the right. The row opens the editor.
    /// With no routine yet, a quiet row offers the add button.
    private var routines: some View {
        let list = workspace.state?.routines(botID: botID) ?? []
        return VStack(alignment: .leading, spacing: 6) {
            if list.isEmpty {
                InspectorSectionTitle(title: "例行任务")
                HStack {
                    Text("暂无例行任务").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    Spacer()
                    Button { AgentUI.shared.editRoutine(botID: botID) } label: {
                        Image(systemName: "plus").font(.system(size: 12)).foregroundStyle(Theme.foreground)
                            .frame(width: 26, height: 26).background(Theme.card, in: Circle()).contentShape(Circle())
                    }
                    .buttonStyle(.plain).help("添加例行任务").accessibilityLabel("添加例行任务")
                }
                .padding(.leading, 12).padding(.trailing, 10).padding(.vertical, 10)
                .background(Theme.wash, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            } else {
                InspectorSectionTitle(title: "例行任务", addLabel: "添加例行任务") { AgentUI.shared.editRoutine(botID: botID) }
                VStack(spacing: 0) {
                    ForEach(list) { routine in routineRow(routine) }
                }
                .padding(.vertical, 4)
                .background(Theme.wash, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .accessibilityLabel("例行任务列表")
            }
        }
    }

    private func routineRow(_ routine: Routine) -> some View {
        HStack(spacing: 14) {
            Button { AgentUI.shared.editRoutine(botID: botID, existing: routine) } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(routine.name).font(.system(size: 13)).foregroundStyle(Theme.foreground).lineLimit(1)
                    Text("\(routine.label) · \(routine.prompt.replacingOccurrences(of: "\n", with: " "))").font(.system(size: 12))
                        .foregroundStyle(Theme.muted).lineLimit(1)
                }
                .padding(.vertical, 3)
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("\(routine.name) · \(routine.label) · \(routine.prompt)")
            RoutineSwitch(on: routine.enabled, disabled: submitting, label: routine.name) {
                run { try await workspace.setRoutineEnabled(routine, enabled: !routine.enabled) }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private func pill(_ symbol: String?, _ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let symbol { Image(systemName: symbol).font(.system(size: 8)) }
                Text(title).font(.system(size: 11))
            }
            .foregroundStyle(Theme.foreground)
            .padding(.horizontal, 10).frame(height: 26)
            .background(Theme.card, in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.border))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func run(_ body: @escaping () async throws -> Void) {
        error = nil; submitting = true
        Task {
            defer { submitting = false }
            do { try await body() } catch { self.error = message(of: error) }
        }
    }
}

/// The 34 x 21 blue switch of the web routine list (`.routine-toggle`).
private struct RoutineSwitch: View {
    let on: Bool
    let disabled: Bool
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Capsule().fill(on ? Color(hex: 0x3566ED) : Theme.muted)
                .frame(width: 34, height: 21)
                .overlay(alignment: on ? .trailing : .leading) { Circle().fill(.white).frame(width: 15, height: 15).padding(3) }
                .animation(.easeOut(duration: 0.15), value: on)
                .opacity(disabled ? 0.5 : 1)
                .contentShape(Capsule())
        }
        .buttonStyle(.plain).disabled(disabled)
        .accessibilityLabel(label).accessibilityValue(on ? "已启用" : "已暂停").accessibilityAddTraits(.isButton)
    }
}

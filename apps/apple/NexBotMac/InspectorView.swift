import SwiftUI
import NexClientKit

/// Right column "助手详情" with the 工作 / 设置 tabs. The selected tab lives in `UIState.inspectorTab`.
struct InspectorView: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(UIState.self) private var ui
    @Environment(ContactPreferences.self) private var preferences
    private var tab: InspectorTab { ui.inspectorTab }

    private var bot: Bot? { workspace.bot(botID) }
    private var state: CompanionState { workspace.companionState(botID) }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("助手详情").font(.system(size: 12)).foregroundStyle(Theme.muted)
                Spacer()
                Button { ui.inspectorVisible = false } label: {
                    Image(systemName: "xmark").font(.system(size: 12)).foregroundStyle(Theme.foreground)
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain).help("收起资料").accessibilityLabel("收起资料")
            }
            .padding(.leading, 20).padding(.trailing, 14).padding(.top, 18)

            profile
            tabs
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    switch tab {
                    case .work: InspectorWorkTab(workspace: workspace, botID: botID)
                    case .settings: InspectorSettingsTab(workspace: workspace, botID: botID)
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(Theme.background)
    }

    private var profile: some View {
        let pinned = preferences.isPinned(botID)
        return VStack(spacing: 4) {
            HStack {
                Spacer()
                RoundIconButton(symbol: pinned ? "pin.fill" : "pin", help: pinned ? "取消置顶" : "置顶联系人", selected: pinned, size: 28) {
                    preferences.togglePin(botID)
                }
            }
            HStack(spacing: 12) {
                Button { AgentUI.shared.pickAvatar(botID) } label: {
                    Group {
                        if let bot { AgentAvatar(appearance: workspace.appearance(bot), state: state, size: 64, animated: preferences.motionEnabled) }
                    }
                    .frame(width: 64, height: 64).contentShape(Rectangle())
                }
                .buttonStyle(.plain).help("更换头像").accessibilityLabel("更换 \(bot?.name ?? "") 的头像")
                Text(bot?.name ?? "").font(.system(size: 15, weight: .semibold)).lineLimit(2).multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 20).padding(.top, 4).padding(.bottom, 16)
    }

    private var tabs: some View {
        HStack(spacing: 0) {
            ForEach(InspectorTab.allCases, id: \.self) { item in
                Button { ui.inspectorTab = item } label: {
                    Text(item.rawValue).font(.system(size: 12)).foregroundStyle(tab == item ? Theme.brand : Theme.muted)
                        .frame(maxWidth: .infinity).frame(height: 36)
                        .overlay(alignment: .bottom) { Rectangle().fill(tab == item ? Theme.brand : .clear).frame(height: 2) }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .overlay(alignment: .bottom) { Hairline() }
    }
}

/// A bold section title, optionally with a trailing "+" button.
struct InspectorSectionTitle: View {
    let title: String
    var addLabel: String?
    var add: (() -> Void)?

    var body: some View {
        HStack {
            Text(title).font(.system(size: 12, weight: .bold))
            Spacer()
            if let addLabel, let add {
                Button(action: add) {
                    Image(systemName: "plus").font(.system(size: 13)).foregroundStyle(Theme.foreground).frame(width: 24, height: 24).contentShape(Rectangle())
                }
                .buttonStyle(.plain).help(addLabel).accessibilityLabel(addLabel)
            }
        }
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
            VStack(alignment: .leading, spacing: 10) {
                InspectorSectionTitle(title: "正在处理")
                ForEach(tasks) { task in activeTask(task) }
            }
        }
        let occurrences = state?.occurrences(botID: botID) ?? []
        if !occurrences.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                InspectorSectionTitle(title: "最近执行")
                ForEach(occurrences) { o in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(o.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                        Text(o.summary).font(.system(size: 11)).foregroundStyle(Theme.muted)
                    }
                    .fieldCard()
                }
            }
        }
        routines
    }

    // MARK: Cards

    private func activeTask(_ task: AgentTask) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(ToolLabels.taskPhrase(task)).font(.system(size: 10, weight: .medium)).foregroundStyle(Theme.brand)
                .padding(.horizontal, 8).padding(.vertical, 3).background(Theme.brandSoft, in: Capsule())
            Text(task.objective.isEmpty ? "Agent 工作" : task.objective).font(.system(size: 12)).foregroundStyle(Theme.foreground)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                if task.status == "paused" {
                    pill("play.fill", "继续") { run { try await workspace.resumeTask(task.id) } }
                }
                pill("stop.fill", "停止") { run { try await workspace.cancelTask(task.id) } }
            }
        }
        .fieldCard()
    }

    /// One rounded list: name and schedule on the left, a blue switch on the right. The row opens the editor.
    private var routines: some View {
        let list = workspace.state?.routines(botID: botID) ?? []
        return VStack(alignment: .leading, spacing: 10) {
            InspectorSectionTitle(title: "例行任务", addLabel: "添加例行任务") { AgentUI.shared.editRoutine(botID: botID) }
            if !list.isEmpty {
                VStack(spacing: 0) {
                    ForEach(list) { routine in routineRow(routine) }
                }
                .padding(.vertical, 6)
                .background(Theme.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.border))
                .accessibilityLabel("例行任务列表")
            }
        }
    }

    private func routineRow(_ routine: Routine) -> some View {
        HStack(spacing: 14) {
            Button { AgentUI.shared.editRoutine(botID: botID, existing: routine) } label: {
                VStack(alignment: .leading, spacing: 5) {
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
        .padding(.horizontal, 12).padding(.vertical, 9)
    }

    private func pill(_ symbol: String?, _ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let symbol { Image(systemName: symbol).font(.system(size: 8)) }
                Text(title).font(.system(size: 11))
            }
            .foregroundStyle(Theme.foreground)
            .padding(.horizontal, 10).frame(height: 26)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Theme.border))
            .contentShape(Rectangle())
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

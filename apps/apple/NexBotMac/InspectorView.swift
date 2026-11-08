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
                Group {
                    if let bot, workspace.appearance(bot).isQ {
                        AgentAvatar(appearance: workspace.appearance(bot), state: state, size: 210, animated: preferences.motionEnabled)
                    } else {
                        HeroHalo(accent: bot.map { workspace.appearance($0).accent } ?? Color(hex: Theme.defaultAccent)) {
                            if let bot { AgentAvatar(appearance: workspace.appearance(bot), state: state, size: 96, animated: preferences.motionEnabled) }
                        }
                    }
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
    @State private var selectedOccurrence: RoutineOccurrence?
    @State private var selectedRoutine: Routine?

    // The running task, background jobs and recent results are not listed here: the composer stops work,
    // jobs open from the chat, and routine results from their row.
    var body: some View {
        if let item = AgentUI.shared.preview, AgentUI.shared.previewBotID == botID { PreviewCard(item: item) { AgentUI.shared.preview = nil } }
        routines
            .sheet(item: $selectedRoutine) { RoutinePlanDetailView(workspace: workspace, routine: $0) }
            .sheet(item: $selectedOccurrence) { RoutineOccurrenceDetailView(workspace: workspace, occurrence: $0) }
    }

    private var routines: some View {
        let list = workspace.state?.routines(botID: botID) ?? []
        return VStack(alignment: .leading, spacing: 6) {
            InspectorSectionTitle(title: "定时任务")
            if list.isEmpty {
                Text("暂无定时任务").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(14)
            } else {
                VStack(spacing: 0) {
                    ForEach(list) { routine in
                        let latest = workspace.state?.occurrences.first { $0.routineID == routine.id }
                        RoutineListEntry(routine: routine, latest: latest,
                            showPlan: { selectedRoutine = routine }, showResult: { selectedOccurrence = latest })
                    }
                }.background(Theme.wash, in: RoundedRectangle(cornerRadius: 14))
                    .accessibilityLabel("定时任务列表")
            }
        }
    }
}

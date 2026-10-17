import SwiftUI
import NexClientKit

/// Right column "助手详情" with the 工作 / 资料 / 设置 tabs. The selected tab lives in `UIState.inspectorTab`.
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
                    case .memory: InspectorMemoryTab(workspace: workspace, botID: botID)
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
        return VStack(spacing: 8) {
            HStack(spacing: 4) {
                Spacer()
                RoundIconButton(symbol: "paintpalette", help: "更换头像", size: 28) { AgentUI.shared.pickAvatar(botID) }
                RoundIconButton(symbol: pinned ? "pin.fill" : "pin", help: pinned ? "取消置顶" : "置顶联系人", selected: pinned, size: 28) {
                    preferences.togglePin(botID)
                }
            }
            if let bot { AgentAvatar(appearance: workspace.appearance(bot), state: state, size: 64) }
            Text(bot?.name ?? "").font(.system(size: 15, weight: .semibold)).lineLimit(2).multilineTextAlignment(.center)
            Text("个人 Agent").font(.system(size: 10, weight: .medium)).foregroundStyle(Theme.brand)
                .padding(.horizontal, 9).padding(.vertical, 3).background(Theme.brandSoft, in: Capsule())
            HStack(spacing: 6) {
                LinkButton(title: "编辑身份") { AgentUI.shared.editIdentity(botID) }
                Text("·").font(.system(size: 11)).foregroundStyle(Theme.muted)
                LinkButton(title: "更换头像") { AgentUI.shared.pickAvatar(botID) }
            }
        }
        .padding(.horizontal, 20).padding(.top, 4).padding(.bottom, 16)
        .frame(maxWidth: .infinity)
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
    @Environment(UIState.self) private var ui
    @State private var error: String?

    private var tasks: [AgentTask] { workspace.state?.unfinishedTasks(botID: botID) ?? [] }
    private var state: CompanionState { workspace.companionState(botID) }

    var body: some View {
        let state = workspace.state
        statusCard
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
        connectors
        devices
        routines
    }

    // MARK: Cards

    private var statusCard: some View {
        let first = tasks.first
        let dot: Color = !tasks.isEmpty ? (state == .approval ? Theme.approval : Theme.success) : Theme.offline
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Circle().fill(dot).frame(width: 7, height: 7)
                Text(first.map { ToolLabels.taskPhrase($0) } ?? "准备就绪").font(.system(size: 12, weight: .bold))
            }
            Text(first.map { String($0.objective.prefix(90)) } ?? "发一条消息，开始新的工作。")
                .font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.leading, 15)
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

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

    private var connectors: some View {
        let granted = workspace.state?.connectors(grantedTo: botID) ?? []
        return VStack(alignment: .leading, spacing: 10) {
            InspectorSectionTitle(title: "连接器", addLabel: "管理连接器") { ui.openConnectors() }
            VStack(alignment: .leading, spacing: 8) {
                ForEach(granted) { connector in
                    Button { ui.openConnectors() } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "powerplug").font(.system(size: 12)).foregroundStyle(Theme.muted)
                            Text(connector.name).font(.system(size: 12)).lineLimit(1)
                            Spacer()
                            Text("\(connector.grant(for: botID)?.tools.count ?? 0) 项工具").font(.system(size: 11)).foregroundStyle(Theme.muted)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                Button { ui.openConnectors() } label: {
                    Text("连接工具与管理授权 →").font(.system(size: 11)).foregroundStyle(Theme.muted).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var devices: some View {
        VStack(alignment: .leading, spacing: 10) {
            InspectorSectionTitle(title: "可用设备")
            VStack(alignment: .leading, spacing: 8) {
                ForEach(workspace.state?.boundDevices ?? []) { device in
                    let online = device.online
                    HStack(spacing: 8) {
                        Image(systemName: "cpu").font(.system(size: 12)).foregroundStyle(Theme.muted)
                        Text(device.name).font(.system(size: 12)).lineLimit(1)
                        Spacer()
                        Text(online ? "在线" : "离线").font(.system(size: 10))
                            .foregroundStyle(online ? Theme.success : Theme.muted)
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(online ? Theme.successSoft : Theme.secondary, in: Capsule())
                    }
                }
                Button { ui.openDevices() } label: {
                    Text("管理设备网络 →").font(.system(size: 11)).foregroundStyle(Theme.muted).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var routines: some View {
        let list = workspace.state?.routines(botID: botID) ?? []
        return VStack(alignment: .leading, spacing: 10) {
            InspectorSectionTitle(title: "例行任务", addLabel: "添加例行任务") { AgentUI.shared.editRoutine(botID: botID) }
            ForEach(list) { routine in routineCard(routine) }
            if list.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Image(systemName: "clock").font(.system(size: 16)).foregroundStyle(Theme.muted)
                    Text("安排一项例行任务，Agent 会按计划工作并给你汇报。").font(.system(size: 12)).foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    pill(nil, "添加例行任务") { AgentUI.shared.editRoutine(botID: botID) }
                }
                .fieldCard()
            }
        }
    }

    private func routineCard(_ routine: Routine) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(routine.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                Spacer()
                Toggle("", isOn: Binding(get: { routine.enabled }, set: { value in run { try await workspace.setRoutineEnabled(routine, enabled: value) } }))
                    .labelsHidden().toggleStyle(.switch).controlSize(.small)
                    .accessibilityLabel("\(routine.enabled ? "暂停" : "启用")\(routine.name)")
            }
            Text(routine.label).font(.system(size: 11)).foregroundStyle(Theme.muted)
            HStack(spacing: 8) {
                pill(nil, "编辑") { AgentUI.shared.editRoutine(botID: botID, existing: routine) }
                pill("play.fill", "现在执行") { run { try await workspace.runRoutine(routine) } }
            }
            if routine.enabled, let next = routine.nextDueAt {
                Text("下次 \(TimeFormat.formatTime(next))").font(.system(size: 11)).foregroundStyle(Theme.muted)
            }
        }
        .fieldCard()
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
        error = nil
        Task {
            do { try await body() } catch { self.error = message(of: error) }
        }
    }
}

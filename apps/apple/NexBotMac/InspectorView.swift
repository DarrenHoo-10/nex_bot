import SwiftUI
import NexClientKit

/// Right column "助手详情" with the 工作 / 资料 / 设置 tabs; only 工作 has content in the native client.
struct InspectorView: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(UIState.self) private var ui
    @State private var tab = Tab.work

    enum Tab: String, CaseIterable { case work = "工作", memory = "资料", settings = "设置" }

    private var bot: Bot? { workspace.bot(botID) }
    private var task: AgentTask? { workspace.state?.unfinishedTask(botID: botID) }
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
                .buttonStyle(.plain).help("关闭").accessibilityLabel("关闭助手详情")
            }
            .padding(.leading, 20).padding(.trailing, 14).padding(.top, 18)

            HStack(spacing: 14) {
                if let bot { AgentAvatar(appearance: workspace.appearance(bot), state: state, size: 56) }
                Text(bot?.name ?? "").font(.system(size: 15, weight: .semibold)).lineLimit(2)
                Spacer()
            }
            .padding(.horizontal, 20).padding(.top, 22).padding(.bottom, 16)

            tabs
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if tab == .work { work } else {
                        Text("请在网页端管理资料与助手设置。").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(Theme.background)
    }

    private var tabs: some View {
        HStack(spacing: 0) {
            ForEach(Tab.allCases, id: \.self) { item in
                Button { tab = item } label: {
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

    // MARK: 工作

    @ViewBuilder private var work: some View {
        statusCard
        if let task {
            section("正在处理") {
                Text(task.objective.isEmpty ? "任务" : task.objective).font(.system(size: 12)).foregroundStyle(Theme.muted)
                Button { Task { await workspace.conversation(for: botID).stop() } } label: {
                    HStack(spacing: 5) {
                        RoundedRectangle(cornerRadius: 2).strokeBorder(Theme.foreground, lineWidth: 1.2).frame(width: 9, height: 9)
                        Text("停止").font(.system(size: 11))
                    }
                    .padding(.horizontal, 10).frame(height: 28)
                    .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                }
                .buttonStyle(.plain).disabled(workspace.conversation(for: botID).canStop == false)
            }
        }
        section("可用设备") {
            let devices = (workspace.state?.devices ?? []).filter { $0.string("status").map { $0 == "bound" } ?? true }
            if devices.isEmpty {
                Text("还没有可用设备。").font(.system(size: 12)).foregroundStyle(Theme.muted)
            }
            ForEach(Array(devices.enumerated()), id: \.offset) { _, device in
                let online = workspace.state?.onlineDevices.contains(device.string("id") ?? "") ?? false
                HStack(spacing: 8) {
                    Image(systemName: "cpu").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    Text(device.string("name") ?? "设备").font(.system(size: 12)).lineLimit(1)
                    Spacer()
                    Text(online ? "在线" : "离线").font(.system(size: 10))
                        .foregroundStyle(online ? Theme.success : Theme.muted)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(online ? Theme.successSoft : Theme.secondary, in: Capsule())
                }
            }
        }
        section("例行任务") {
            let routines = (workspace.state?.routines ?? []).filter { $0.string("bot_id") == botID }
            if routines.isEmpty {
                Text("安排一项例行任务，Agent 会按计划工作并给你汇报。").font(.system(size: 12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(routines.enumerated()), id: \.offset) { _, routine in
                let enabled = routine.bool("enabled") ?? ((routine.int("enabled") ?? 0) != 0)
                HStack(spacing: 8) {
                    Text(routine.string("name") ?? "例行任务").font(.system(size: 12, weight: .medium)).lineLimit(1)
                    Spacer()
                    Text(enabled ? "已启用" : "已暂停").font(.system(size: 10)).foregroundStyle(enabled ? Theme.success : Theme.muted)
                }
                .padding(10).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
    }

    private var statusCard: some View {
        let title: String = {
            switch state {
            case .idle: "准备就绪"
            case .approval: "等你批准"
            case .offline: "正在重新连接"
            default: task.map { ToolLabels.taskPhrase($0) } ?? state.label
            }
        }()
        let dot: Color = state == .approval ? Theme.approval : state == .idle || state == .offline || state == .paused ? Theme.offline : Theme.success
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Circle().fill(dot).frame(width: 7, height: 7)
                Text(title).font(.system(size: 12, weight: .bold))
            }
            Text(task.map { $0.objective.isEmpty ? "任务" : $0.objective } ?? "发一条消息，开始新的工作。")
                .font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.leading, 15)
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func section<C: View>(_ title: String, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.system(size: 12, weight: .bold))
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

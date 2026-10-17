import SwiftUI
import NexClientKit

/// The agent's 助手详情 screen: header plus 工作 / 资料 / 设置 tabs (`Navigation.detailTab`).
struct AgentDetailView: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(Navigation.self) private var nav

    private var bot: Bot? { workspace.bot(botID) }
    private var task: AgentTask? { workspace.state?.unfinishedTask(botID: botID) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 14) {
                    if let bot { workspace.avatar(of: bot, size: 56) }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(bot?.name ?? "").font(.headline).lineLimit(2)
                        Text(workspace.companionState(of: botID).label).font(.caption).foregroundStyle(Theme.muted)
                    }
                    Spacer()
                }
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
    }

    // MARK: 工作

    @ViewBuilder private var work: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(task.map(\.phrase) ?? "准备就绪").font(.subheadline.weight(.bold))
            Text(task.map { $0.objective.isEmpty ? "任务" : $0.objective } ?? "发一条消息，开始新的工作。").font(.footnote).foregroundStyle(Theme.muted)
            if task != nil {
                Button("停止") { Task { await workspace.conversation(for: botID).stop() } }
                    .buttonStyle(PillButtonStyle()).disabled(!workspace.conversation(for: botID).canStop).padding(.top, 4)
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading).cardStyle()
        section("可用设备") {
            let devices = workspace.state?.boundDevices ?? []
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
        }
        section("例行任务") {
            let routines = workspace.state?.routines(botID: botID) ?? []
            if routines.isEmpty { Text("安排一项例行任务，Agent 会按计划工作并给你汇报。").font(.footnote).foregroundStyle(Theme.muted) }
            ForEach(routines) { routine in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(routine.name).font(.subheadline.weight(.medium)).lineLimit(1)
                        Text(routine.label).font(.caption).foregroundStyle(Theme.muted)
                    }
                    Spacer()
                    Text(routine.enabled ? "已启用" : "已暂停").font(.caption2).foregroundStyle(routine.enabled ? Theme.success : Theme.muted)
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading).cardStyle()
            }
        }
    }

    private func section<C: View>(_ title: String, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.footnote.weight(.bold))
            content()
        }
    }
}

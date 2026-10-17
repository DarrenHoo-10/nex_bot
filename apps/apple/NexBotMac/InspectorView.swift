import SwiftUI
import NexClientKit

/// Third column: approvals across all agents and recent tasks of the selected agent.
struct InspectorView: View {
    let workspace: WorkspaceStore

    private var tasks: [AgentTask] {
        guard let id = workspace.selectedBotID else { return [] }
        return Array((workspace.state?.tasks ?? []).filter { $0.botID == id }.prefix(12))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                section("待批准", count: workspace.approvals.count) {
                    if workspace.approvals.isEmpty {
                        Text("没有待处理的批准").font(.callout).foregroundStyle(.secondary)
                    } else {
                        ForEach(workspace.approvals) { ApprovalCard(workspace: workspace, approval: $0) }
                    }
                }
                section("最近任务", count: tasks.count) {
                    if tasks.isEmpty {
                        Text("暂无任务").font(.callout).foregroundStyle(.secondary)
                    } else {
                        ForEach(tasks) { TaskRow(task: $0) }
                    }
                }
            }
            .padding(14)
        }
        .background(.background)
        .navigationTitle("详情")
    }

    private func section<C: View>(_ title: String, count: Int, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).font(.headline)
                if count > 0 { Text("\(count)").font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
            }
            content()
        }
    }
}

private struct TaskRow: View {
    let task: AgentTask

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(task.objective.isEmpty ? "任务" : task.objective).font(.callout).lineLimit(2)
            HStack(spacing: 6) {
                Circle().fill(color).frame(width: 6, height: 6)
                Text(task.isUnfinished ? task.phrase : ToolLabels.statusText(task.status)).font(.caption).foregroundStyle(.secondary)
                Spacer()
                if let at = task.createdAt { Text(at.formatted(date: .abbreviated, time: .shortened)).font(.caption2).foregroundStyle(.tertiary) }
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var color: Color {
        switch task.status {
        case "succeeded": .green
        case "failed", "rejected", "cancelled": .red
        case "awaiting_approval": .orange
        default: task.isUnfinished ? .blue : .secondary
        }
    }
}

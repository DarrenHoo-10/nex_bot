import SwiftUI
import NexClientKit

struct ApprovalsView: View {
    let workspace: WorkspaceStore
    @State private var selected: Approval?
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            List(workspace.approvals) { approval in
                Button { selected = approval } label: { row(approval) }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .trailing) {
                        Button("拒绝", role: .destructive) { decide(approval, false) }
                    }
                    .swipeActions(edge: .leading) {
                        Button("批准") { decide(approval, true) }.tint(.green)
                    }
            }
            .overlay {
                if workspace.state != nil && workspace.approvals.isEmpty {
                    ContentUnavailableView("没有待审批事项", systemImage: "checkmark.shield")
                }
            }
            .refreshable { await workspace.refresh() }
            .navigationTitle("审批")
            .sheet(item: $selected) { approval in
                ApprovalDetail(approval: approval, agentName: workspace.bot(approval.botID)?.name ?? "") { allow in
                    decide(approval, allow)
                    selected = nil
                }
                .presentationDetents([.medium, .large])
            }
            .errorAlert($errorText)
        }
    }

    private func row(_ approval: Approval) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(approval.title).font(.headline)
            if let name = workspace.bot(approval.botID)?.name { Text(name).font(.subheadline).foregroundStyle(.secondary) }
            if let date = approval.expiresAt { Text("截止 \(date.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func decide(_ approval: Approval, _ allow: Bool) {
        Task {
            do { try await workspace.decide(approval, allow: allow) }
            catch { errorText = (error as? CoreError)?.message ?? error.localizedDescription }
        }
    }
}

struct ApprovalDetail: View {
    let approval: Approval
    let agentName: String
    let decide: (Bool) -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if !agentName.isEmpty { Label(agentName, systemImage: "person.crop.circle").foregroundStyle(.secondary) }
                    Text("工具：\(approval.toolName)").font(.subheadline)
                    Text("参数").font(.headline)
                    Text(approval.argumentsText.isEmpty ? "（无）" : approval.argumentsText)
                        .font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                }
                .padding()
            }
            .navigationTitle(approval.title)
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                HStack {
                    Button("拒绝", role: .destructive) { decide(false) }.buttonStyle(.bordered)
                    Button("批准") { decide(true) }.buttonStyle(.borderedProminent)
                }
                .controlSize(.large).padding().frame(maxWidth: .infinity).background(.bar)
            }
        }
    }
}

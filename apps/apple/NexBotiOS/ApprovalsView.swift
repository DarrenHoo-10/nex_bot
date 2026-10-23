import SwiftUI
import NexClientKit

/// Pending approvals, reached from the banner on the contacts list.
struct ApprovalsView: View {
    let workspace: WorkspaceStore
    @State private var errorText: String?

    var body: some View {
        List(workspace.approvals) { approval in
            ApprovalCard(approval: approval, botName: workspace.bot(approval.botID)?.name ?? "") { allow, remember in await decide(approval, allow, remember: remember) }
                .listRowBackground(Color.clear).listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                .swipeActions(edge: .trailing) {
                    Button("拒绝", role: .destructive) { Task { await decide(approval, false) } }
                }
                .swipeActions(edge: .leading) {
                    Button("允许一次") { Task { await decide(approval, true) } }.tint(Theme.success)
                    if approval.rememberLabel != nil {
                        Button("始终允许") { Task { await decide(approval, true, remember: true) } }.tint(Theme.brand)
                    }
                }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .overlay {
            if workspace.state != nil && workspace.approvals.isEmpty {
                ContentUnavailableView("没有待审批事项", systemImage: "checkmark.shield")
            }
        }
        .refreshable { await workspace.refresh() }
        .navigationTitle("待你批准")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .errorAlert($errorText)
    }

    private func decide(_ approval: Approval, _ allow: Bool, remember: Bool = false) async {
        do { try await workspace.decide(approval, allow: allow, remember: remember) }
        catch { errorText = (error as? CoreError)?.message ?? error.localizedDescription }
    }
}

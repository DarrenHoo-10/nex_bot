import SwiftUI
import NexClientKit

/// Pending tool approval with approve / deny. Used inline in chat and in the inspector.
struct ApprovalCard: View {
    let workspace: WorkspaceStore
    let approval: Approval
    var showsAgent = true
    @State private var busy = false
    @State private var error: String?
    @State private var showArguments = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
                Text(approval.title).font(.headline)
            }
            if showsAgent, let bot = workspace.bot(approval.botID) {
                Text("来自 \(bot.name)").font(.caption).foregroundStyle(.secondary)
            }
            DisclosureGroup("调用参数", isExpanded: $showArguments) {
                ScrollView(.horizontal) {
                    Text(approval.argumentsText.isEmpty ? "无参数" : approval.argumentsText)
                        .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 160)
                .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 6))
            }.font(.caption)
            HStack {
                Button { decide(true) } label: { Label("批准", systemImage: "checkmark") }
                    .buttonStyle(.borderedProminent)
                Button(role: .destructive) { decide(false) } label: { Label("拒绝", systemImage: "xmark") }
                    .buttonStyle(.bordered)
                if busy { ProgressView().controlSize(.small) }
            }
            .disabled(busy)
            if let error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.orange.opacity(0.35)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("approval-card")
    }

    private func decide(_ allow: Bool) {
        busy = true; error = nil
        Task {
            do { try await workspace.decide(approval, allow: allow) }
            catch { self.error = message(of: error) }
            busy = false
        }
    }
}

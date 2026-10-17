import SwiftUI
import NexClientKit

/// Inline approval request in a chat.
struct ApprovalCard: View {
    let approval: Approval
    let decide: (Bool) async -> Void
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(approval.title, systemImage: "exclamationmark.shield").font(.headline)
            if !approval.argumentsText.isEmpty {
                Text(approval.argumentsText)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(8).textSelection(.enabled)
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
            }
            HStack {
                Button("拒绝", role: .destructive) { run(false) }.buttonStyle(.bordered)
                Button("批准") { run(true) }.buttonStyle(.borderedProminent)
                if busy { ProgressView() }
            }
            .disabled(busy)
        }
        .padding(12)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.orange.opacity(0.4)))
    }

    private func run(_ allow: Bool) {
        busy = true
        Task { await decide(allow); busy = false }
    }
}

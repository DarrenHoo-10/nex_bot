import SwiftUI
import NexClientKit

/// Inline approval request, styled like the web UI's approval card.
struct ApprovalCard: View {
    let approval: Approval
    var botName = ""
    let decide: (Bool) async -> Void
    @State private var busy = false
    @State private var showArguments = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(botName.isEmpty ? "需要你的批准" : "\(botName) 需要你的批准").font(.subheadline.weight(.semibold))
            Text(approval.title).font(.caption).foregroundStyle(Theme.muted)
            if !details.isEmpty {
                Button { withAnimation(.easeOut(duration: 0.15)) { showArguments.toggle() } } label: {
                    Text("\(showArguments ? "▾" : "▸") 查看具体操作").font(.caption).foregroundStyle(Theme.muted)
                }
                .buttonStyle(.plain)
                if showArguments {
                    Text(details)
                        .font(.system(.caption2, design: .monospaced))
                        .lineLimit(12).textSelection(.enabled)
                        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            }
            HStack(spacing: 8) {
                Button("批准") { run(true) }.buttonStyle(PillButtonStyle(primary: true))
                Button("拒绝") { run(false) }.buttonStyle(PillButtonStyle())
                if busy { ProgressView() }
            }
            .disabled(busy)
            .padding(.top, 2)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(radius: 12, stroke: Theme.approval.opacity(0.7))
    }

    /// Pretty arguments; `memory.forget` adds 清理范围 from the authorization snapshot.
    private var details: String {
        guard approval.toolName == "memory.forget" else { return approval.argumentsText }
        func parse(_ key: String) -> JSONValue? {
            approval.row.string(key).flatMap { $0.data(using: .utf8) }.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
        }
        var object = parse("arguments_json")?.objectValue ?? [:]
        if let counts = parse("authorization_snapshot_json")?["forgetCounts"] { object["清理范围"] = counts }
        return prettyJSON(.object(object)) ?? approval.argumentsText
    }

    private func run(_ allow: Bool) {
        busy = true
        Task { await decide(allow); busy = false }
    }
}

import SwiftUI
import NexClientKit

/// Pending tool approval with approve / deny, shown above the composer.
struct ApprovalCard: View {
    let workspace: WorkspaceStore
    let approval: Approval
    @State private var busy = false
    @State private var error: String?
    @State private var showArguments = false

    /// Pretty arguments; memory.forget also lists the 清理范围 from the authorization snapshot.
    private var argumentsText: String {
        guard approval.toolName == "memory.forget",
              let raw = approval.row.string("authorization_snapshot_json"), let data = raw.data(using: .utf8),
              let snapshot = try? JSONDecoder().decode(JSONValue.self, from: data), let counts = snapshot["forgetCounts"] else { return approval.argumentsText }
        var object: [String: JSONValue] = [:]
        if let args = approval.row.string("arguments_json").flatMap({ $0.data(using: .utf8) }).flatMap({ try? JSONDecoder().decode(JSONValue.self, from: $0) })?.objectValue { object = args }
        object["清理范围"] = counts
        return prettyJSON(.object(object)) ?? approval.argumentsText
    }

    private var botName: String { workspace.bot(approval.botID)?.name ?? "Agent" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(botName) 需要你的批准").font(.system(size: 13, weight: .semibold))
            Text(approval.title).font(.system(size: 11)).foregroundStyle(Theme.muted)
            Button { showArguments.toggle() } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold)).rotationEffect(.degrees(showArguments ? 90 : 0))
                    Text("查看具体操作").font(.system(size: 11))
                }
                .foregroundStyle(Theme.muted).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if showArguments {
                ScrollView(.horizontal) {
                    Text(argumentsText.isEmpty ? "无参数" : argumentsText)
                        .font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 160)
                .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            HStack(spacing: 8) {
                Button { decide(true) } label: {
                    Text("批准").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.primaryForeground)
                        .padding(.horizontal, 14).frame(height: 28)
                        .background(Theme.primary, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                }
                Button { decide(false) } label: {
                    Text("拒绝").font(.system(size: 11)).foregroundStyle(Theme.foreground)
                        .padding(.horizontal, 12).frame(height: 28)
                        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                }
                if busy { ProgressView().controlSize(.small) }
            }
            .buttonStyle(.plain)
            .disabled(busy)
            if let error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled) }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.approval, lineWidth: 1))
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

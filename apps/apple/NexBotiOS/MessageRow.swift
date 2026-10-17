import SwiftUI
import NexClientKit

struct MessageRow: View {
    let message: AgentMessage

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if message.isFromUser { Spacer(minLength: 48) }
            VStack(alignment: message.isFromUser ? .trailing : .leading, spacing: 4) {
                if !message.toolSteps.isEmpty { ToolStepsRow(steps: message.toolSteps) }
                if !message.content.isEmpty {
                    Text(Markdown.attributed(message.content))
                        .foregroundStyle(foreground)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .textSelection(.enabled)
                }
                if let date = message.createdAt {
                    Text(date, format: .dateTime.hour().minute()).font(.caption2).foregroundStyle(.secondary)
                }
            }
            if !message.isFromUser { Spacer(minLength: 48) }
        }
    }

    private var isError: Bool { message.kind == "error" }
    private var foreground: Color { message.isFromUser ? .white : (isError ? .red : .primary) }
    private var background: Color {
        message.isFromUser ? .accentColor : Color(.secondarySystemBackground)
    }
}

struct StreamingRow: View {
    let text: String
    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            Text(Markdown.attributed(text))
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            ProgressView()
            Spacer(minLength: 32)
        }
    }
}

/// Tool steps collapsed to one summary line; tap to see each step.
struct ToolStepsRow: View {
    let steps: [ToolStep]
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(steps) { step in
                    HStack(spacing: 6) {
                        Image(systemName: icon(step)).foregroundStyle(color(step))
                        Text(step.summary.isEmpty ? step.label : "\(step.label)：\(step.summary)").lineLimit(2)
                    }
                }
            }
            .font(.caption).padding(.top, 4)
        } label: {
            Label(summary, systemImage: "wrench.and.screwdriver")
                .font(.caption).foregroundStyle(steps.contains { ["failed", "rejected"].contains($0.status) } ? .red : .secondary)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    /// The collapsed row still tells whether the call ran, e.g. 执行终端命令 · 已拒绝.
    private var summary: String {
        if steps.count == 1 { return "\(steps[0].label) · \(ToolLabels.statusText(steps[0].status))" }
        let unsuccessful = steps.filter { ["failed", "rejected", "cancelled"].contains($0.status) }.count
        return "\(steps[0].label) 等 \(steps.count) 步" + (unsuccessful > 0 ? " · \(unsuccessful) 步未成功" : "")
    }

    private func icon(_ step: ToolStep) -> String {
        switch step.status {
        case "failed", "rejected", "cancelled": "xmark.circle"
        case "running", "pending", "queued": "clock"
        default: "checkmark.circle"
        }
    }
    private func color(_ step: ToolStep) -> Color {
        switch step.status {
        case "failed", "rejected": .red
        case "running", "pending", "queued": .orange
        default: .green
        }
    }
}

import SwiftUI
import NexClientKit

/// "今天" style divider between days.
struct DateDivider: View {
    let date: Date
    var body: some View {
        Text(label).font(.caption2).foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity).padding(.vertical, 6)
    }
    private var label: String {
        let cal = Calendar.current
        if cal.isDateInToday(date) { return "今天" }
        if cal.isDateInYesterday(date) { return "昨天" }
        return date.formatted(.dateTime.month().day())
    }
}

struct MessageRow: View {
    let message: AgentMessage

    var body: some View {
        VStack(alignment: message.isFromUser ? .trailing : .leading, spacing: 4) {
            if !message.toolSteps.isEmpty { ToolStepsRow(steps: message.toolSteps) }
            if !message.content.isEmpty {
                if message.isFromUser {
                    Text(Markdown.attributed(message.content))
                        .foregroundStyle(Theme.foreground)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .textSelection(.enabled)
                        .padding(.leading, 40)
                } else {
                    if message.kind == "error" {
                        Text(message.content).foregroundStyle(Theme.danger).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                    } else {
                        MarkdownText(source: message.content, fontSize: 16)
                    }
                }
            }
            if let date = message.createdAt {
                Text(date, format: .dateTime.hour(.twoDigits(amPM: .omitted)).minute()).font(.system(size: 10)).foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: message.isFromUser ? .trailing : .leading)
    }
}

/// An agent reply that is still streaming: plain text with a small spinner.
struct StreamingRow: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            MarkdownText(source: text, fontSize: 16)
            ProgressView().controlSize(.small)
        }
    }
}

/// Tool steps collapsed to "› 执行记录 · N 项操作"; tap to see each step.
struct ToolStepsRow: View {
    let steps: [ToolStep]
    @State private var expanded = false

    private var unsuccessful: [ToolStep] { steps.filter { ["failed", "rejected", "cancelled"].contains($0.status) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() } } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).rotationEffect(.degrees(expanded ? 90 : 0))
                    Text("执行记录 · \(steps.count) 项操作")
                    if let first = unsuccessful.first {
                        Text("· \(ToolLabels.statusText(first.status))").foregroundStyle(Theme.danger)
                    }
                }
                .font(.caption).foregroundStyle(Theme.muted)
            }
            .buttonStyle(.plain)
            if expanded {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(steps) { step in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Circle().fill(color(step)).frame(width: 6, height: 6)
                            Text(step.summary.isEmpty ? step.label : "\(step.label)：\(step.summary)").lineLimit(2)
                            Text(ToolLabels.statusText(step.status)).foregroundStyle(color(step))
                        }
                    }
                }
                .font(.caption).foregroundStyle(Theme.foreground).padding(.leading, 13)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func color(_ step: ToolStep) -> Color {
        switch step.status {
        case "failed", "rejected": Theme.danger
        case "running", "pending", "queued": Theme.approval
        case "cancelled": Theme.muted
        default: Theme.success
        }
    }
}

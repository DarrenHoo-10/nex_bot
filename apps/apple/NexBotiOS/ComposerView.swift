import SwiftUI
import NexClientKit

struct ComposerView: View {
    @Bindable var conversation: ConversationStore
    let botName: String

    private var hasText: Bool { !conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var canSend: Bool { hasText && !conversation.isSending }

    var body: some View {
        VStack(spacing: 6) {
            if let task = conversation.activeTask {
                HStack(spacing: 6) {
                    Circle().fill(Theme.success).frame(width: 6, height: 6)
                    Text(task.phrase.isEmpty ? "Agent 正在工作" : "Agent 正在工作 · \(task.phrase)")
                        .font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                    Spacer()
                    if conversation.canStop {
                        Button { Task { await conversation.stop() } } label: {
                            Label("停止任务", systemImage: "stop").font(.caption).foregroundStyle(Theme.foreground)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 6)
            }
            if let error = conversation.sendError {
                Text(error).font(.footnote).foregroundStyle(Theme.danger).frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("给 \(botName) 发消息...", text: $conversation.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.leading, 6).padding(.vertical, 6)
                Button { Task { await conversation.send() } } label: {
                    Group {
                        if conversation.isSending { ProgressView() }
                        else { Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold)) }
                    }
                    .frame(width: 32, height: 32)
                    .foregroundStyle(hasText ? Theme.primaryForeground : Theme.muted)
                    .background(hasText ? Theme.primary : Theme.secondary, in: Circle())
                }
                .disabled(!canSend)
                .accessibilityLabel("发送")
            }
            .padding(.leading, 10).padding(.trailing, 6).padding(.vertical, 6)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Theme.border))
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.background)
    }
}

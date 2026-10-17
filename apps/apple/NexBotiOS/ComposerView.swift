import SwiftUI
import NexClientKit

struct ComposerView: View {
    @Bindable var conversation: ConversationStore

    private var canSend: Bool {
        !conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !conversation.isSending
    }

    var body: some View {
        VStack(spacing: 6) {
            if let error = conversation.sendError {
                Text(error).font(.footnote).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("发消息…", text: $conversation.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                if conversation.canStop {
                    Button { Task { await conversation.stop() } } label: {
                        Image(systemName: "stop.circle.fill").font(.title).foregroundStyle(.red)
                    }
                    .accessibilityLabel("停止")
                }
                Button { Task { await conversation.send() } } label: {
                    if conversation.isSending { ProgressView().frame(width: 30, height: 30) }
                    else { Image(systemName: "arrow.up.circle.fill").font(.title) }
                }
                .disabled(!canSend)
                .accessibilityLabel("发送")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(.bar)
    }
}

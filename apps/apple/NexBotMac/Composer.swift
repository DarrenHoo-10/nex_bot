import SwiftUI
import NexClientKit

/// Return sends, Shift-Return inserts a newline. Stop replaces Send while a task runs.
struct Composer: View {
    let workspace: WorkspaceStore
    @Bindable var conversation: ConversationStore
    let botName: String
    @Environment(UIState.self) private var ui
    @FocusState private var focused: Bool

    private var canSend: Bool { !conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !conversation.isSending }
    private var height: CGFloat {
        let lines = conversation.draft.split(separator: "\n", omittingEmptySubsequences: false).count
        return min(120, max(24, CGFloat(lines) * 18 + 8))
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextEditor(text: $conversation.draft)
                .font(.body)
                .scrollContentBackground(.hidden)
                .focused($focused)
                .frame(height: height)
                .padding(.horizontal, 6).padding(.vertical, 4)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.separator))
                .overlay(alignment: .topLeading) {
                    if conversation.draft.isEmpty {
                        Text("发消息给 \(botName)　Return 发送，Shift-Return 换行")
                            .foregroundStyle(.tertiary).padding(.horizontal, 11).padding(.vertical, 8).allowsHitTesting(false)
                    }
                }
                .onKeyPress(.return, phases: .down) { press in
                    if press.modifiers.contains(.shift) { return .ignored }
                    send()
                    return .handled
                }
                .accessibilityLabel("消息输入框")
            if conversation.canStop {
                Button { Task { await conversation.stop() } } label: { Label("停止", systemImage: "stop.circle.fill") }
                    .controlSize(.large).help("停止当前任务 (⌘.)")
            }
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 26))
            }
            .buttonStyle(.plain).foregroundStyle(canSend ? Color.accentColor : Color.secondary)
            .disabled(!canSend).help("发送 (Return)").accessibilityLabel("发送")
        }
        .padding(12)
        .background(.bar)
        .onChange(of: ui.composerFocusTick) { focused = true }
        .onAppear { focused = true }
    }

    private func send() {
        guard canSend else { return }
        Task { await conversation.send() }
    }
}

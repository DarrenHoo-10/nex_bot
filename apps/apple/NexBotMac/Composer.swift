import SwiftUI
import NexClientKit

/// Return sends, Shift-Return inserts a newline.
struct Composer: View {
    @Bindable var conversation: ConversationStore
    let botName: String
    @Environment(UIState.self) private var ui
    @FocusState private var focused: Bool

    private var hasText: Bool { !conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var canSend: Bool { hasText && !conversation.isSending }
    private var height: CGFloat {
        let lines = conversation.draft.split(separator: "\n", omittingEmptySubsequences: false).count
        return min(120, max(22, CGFloat(lines) * 19 + 3))
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextEditor(text: $conversation.draft)
                .font(.system(size: 14))
                .scrollContentBackground(.hidden)
                .focused($focused)
                .frame(height: height)
                .overlay(alignment: .topLeading) {
                    if conversation.draft.isEmpty {
                        Text("给 \(botName) 发消息...")
                            .font(.system(size: 14)).foregroundStyle(Theme.muted)
                            .padding(.leading, 5).allowsHitTesting(false)
                    }
                }
                .onKeyPress(.return, phases: .down) { press in
                    if press.modifiers.contains(.shift) { return .ignored }
                    send()
                    return .handled
                }
                .accessibilityLabel("消息输入框")
            Button(action: send) {
                Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold))
                    .foregroundStyle(hasText ? Theme.primaryForeground : .white)
                    .frame(width: 34, height: 34)
                    .background(hasText ? Theme.primary : Color(hex: 0x9A9A9E), in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend).help("发送 (Return)").accessibilityLabel("发送")
        }
        .padding(.leading, 18).padding(.trailing, 14).padding(.vertical, 12)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.border))
        .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
        .onChange(of: ui.composerFocusTick) { focused = true }
        .onAppear { focused = true }
    }

    private func send() {
        guard canSend else { return }
        Task { await conversation.send() }
    }
}

import SwiftUI
import NexClientKit

/// A message the next send will quote (`引用 {author}`).
struct QuoteDraft: Equatable {
    let author: String
    let text: String
    /// `> {author}：{text, whitespace collapsed, first 140 characters}` followed by a blank line.
    var prefix: String {
        let collapsed = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return "> \(author)：\(String(collapsed.prefix(140)))\n\n"
    }
}

/// Return sends, Shift-Return inserts a newline. The "+" button opens the quick menu; typing `@` offers the other agents.
struct Composer: View {
    let workspace: WorkspaceStore
    @Bindable var conversation: ConversationStore
    let bot: Bot?
    @Environment(UIState.self) private var ui
    @FocusState private var focused: Bool
    @State private var menuOpen = false
    @State private var mentionIndex = 0
    @State private var mentionDismissed = false

    private var agentUI: AgentUI { AgentUI.shared }
    private var botID: String { conversation.botID }
    private var botName: String { bot?.name ?? "Agent" }
    private var quote: QuoteDraft? { agentUI.quotes[botID] }
    private var hasModel: Bool { workspace.state?.config != nil }
    private var hasText: Bool { !conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var canSend: Bool { hasText && !conversation.isSending && hasModel && bot != nil }
    private var height: CGFloat {
        let lines = conversation.draft.split(separator: "\n", omittingEmptySubsequences: false).count
        return min(104, max(22, CGFloat(min(lines, 5)) * 19 + 3))
    }

    /// Other agents whose name contains the text typed after a trailing `@`.
    private var mentions: [Bot] {
        guard !mentionDismissed, let fragment = Self.mentionFragment(conversation.draft) else { return [] }
        return workspace.bots.filter { $0.id != botID && (fragment.isEmpty || $0.name.localizedCaseInsensitiveContains(fragment)) }
    }

    var body: some View {
        VStack(spacing: 8) {
            if let quote { quoteBar(quote) }
            if !mentions.isEmpty { mentionMenu }
            field
        }
        .onChange(of: ui.composerFocusTick) { focused = true }
        .onChange(of: conversation.draft) { mentionIndex = 0; mentionDismissed = false }
        .onAppear { focused = true }
    }

    private var field: some View {
        HStack(alignment: .bottom, spacing: 10) {
            Button { menuOpen.toggle() } label: {
                Image(systemName: "plus").font(.system(size: 15)).foregroundStyle(Theme.foreground)
                    .frame(width: 34, height: 34).overlay(Circle().strokeBorder(Theme.border)).contentShape(Circle())
            }
            .buttonStyle(.plain).help("快捷操作").accessibilityLabel("打开快捷操作")
            .popover(isPresented: $menuOpen, arrowEdge: .top) { quickMenu }

            TextEditor(text: $conversation.draft)
                .font(.system(size: 14))
                .scrollContentBackground(.hidden)
                .focused($focused)
                .frame(height: height)
                .padding(.bottom, 5)
                .overlay(alignment: .topLeading) {
                    if conversation.draft.isEmpty {
                        Text("给 \(botName) 发消息…")
                            .font(.system(size: 14)).foregroundStyle(Theme.muted)
                            .padding(.leading, 5).allowsHitTesting(false)
                    }
                }
                .onKeyPress(.downArrow) { moveMention(1) }
                .onKeyPress(.upArrow) { moveMention(-1) }
                .onKeyPress(.tab) { applyMention() }
                .onKeyPress(.escape) {
                    guard !mentions.isEmpty else { return .ignored }
                    mentionDismissed = true
                    return .handled
                }
                .onKeyPress(.return, phases: .down) { press in
                    if press.modifiers.contains(.shift) { return .ignored }
                    if !mentions.isEmpty { return applyMention() }
                    send()
                    return .handled
                }
                .accessibilityLabel("发送给 Agent 的消息")
            Button(action: send) {
                Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold))
                    .foregroundStyle(canSend ? Theme.primaryForeground : .white)
                    .frame(width: 34, height: 34)
                    .background(canSend ? Theme.primary : Color(hex: 0x9A9A9E), in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend).help("发送 (Return)").accessibilityLabel("发送消息")
        }
        .padding(.leading, 14).padding(.trailing, 14).padding(.vertical, 12)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.border))
        .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
    }

    // MARK: Quick menu

    private var quickMenu: some View {
        VStack(alignment: .leading, spacing: 2) {
            menuItem("at", "提及同伴") { conversation.draft += " @"; focused = true }
            menuItem("clock", "安排例行任务") { agentUI.editRoutine(botID: botID) }
            menuItem("powerplug", "管理连接器") { ui.openSettings(.connectors) }
        }
        .padding(6).frame(width: 170)
        .accessibilityLabel("快捷操作")
    }

    private func menuItem(_ symbol: String, _ title: String, action: @escaping () -> Void) -> some View {
        Button { menuOpen = false; action() } label: {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.system(size: 12)).foregroundStyle(Theme.muted).frame(width: 16)
                Text(title).font(.system(size: 12)).foregroundStyle(Theme.foreground)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).frame(height: 30).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Quote and mention

    private func quoteBar(_ quote: QuoteDraft) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("引用 \(quote.author)").font(.system(size: 11, weight: .semibold))
                Text(quote.text).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(2)
            }
            Spacer(minLength: 0)
            Button { agentUI.quotes[botID] = nil } label: {
                Image(systemName: "xmark").font(.system(size: 10)).frame(width: 24, height: 24).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("取消引用").accessibilityLabel("取消引用")
        }
        .padding(.horizontal, 14).padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(alignment: .leading) { Rectangle().fill(Theme.brand).frame(width: 3).padding(.vertical, 6) }
    }

    private var mentionMenu: some View {
        let list = mentions
        return VStack(spacing: 2) {
            ForEach(Array(list.enumerated()), id: \.element.id) { index, peer in
                Button { insertMention(peer) } label: {
                    HStack(spacing: 10) {
                        AgentAvatar(appearance: workspace.appearance(peer), size: 28)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("@\(peer.name)").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.foreground)
                            Text(peer.instructions.isEmpty ? "同伴 Agent" : peer.instructions).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6).frame(maxWidth: .infinity, alignment: .leading)
                    .background(index == min(mentionIndex, list.count - 1) ? Theme.secondary : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(6)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.border))
        .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
        .accessibilityLabel("提及同伴 Agent")
    }

    /// The text after a trailing `@` that starts the draft or follows whitespace (`/(?:^|\s)@([^\s@]*)$/`).
    static func mentionFragment(_ draft: String) -> String? {
        guard let match = draft.firstMatch(of: /(?:^|\s)@([^\s@]*)$/) else { return nil }
        return String(match.1)
    }

    private func moveMention(_ delta: Int) -> KeyPress.Result {
        let list = mentions
        guard !list.isEmpty else { return .ignored }
        mentionIndex = (min(mentionIndex, list.count - 1) + delta + list.count) % list.count
        return .handled
    }

    private func applyMention() -> KeyPress.Result {
        let list = mentions
        guard !list.isEmpty else { return .ignored }
        insertMention(list[min(mentionIndex, list.count - 1)])
        return .handled
    }

    private func insertMention(_ peer: Bot) {
        guard let fragment = Self.mentionFragment(conversation.draft) else { return }
        conversation.draft = String(conversation.draft.dropLast(fragment.count + 1)) + "@\(peer.name) "
        focused = true
    }

    // MARK: Send

    private func send() {
        guard canSend else { return }
        let quoted = quote
        Task {
            if let quoted {
                let text = quoted.prefix + conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines)
                let sent = conversation.draft
                if await conversation.send(text: text) {
                    if conversation.draft == sent { conversation.draft = "" }
                    agentUI.quotes[botID] = nil
                }
            } else {
                await conversation.send()
            }
        }
    }
}

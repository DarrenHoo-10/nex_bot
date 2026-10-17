import SwiftUI
import NexClientKit

/// A message the next send quotes.
struct QuoteDraft: Equatable {
    var author: String
    var text: String
    /// `> {author}：{text, whitespace collapsed, first 140 characters}` followed by a blank line.
    var prefix: String {
        let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return "> \(author)：\(flat.prefix(140))\n\n"
    }
}

struct ComposerView: View {
    let workspace: WorkspaceStore
    let botID: String
    @Bindable var conversation: ConversationStore
    let botName: String
    @Binding var quote: QuoteDraft?
    var onRoutine: () -> Void = {}
    @Environment(Navigation.self) private var nav
    @State private var stopping = false
    @State private var showMentionsDismissed = false

    private var hasModel: Bool { workspace.state?.config != nil }
    private var hasText: Bool { !conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var canSend: Bool { hasText && !conversation.isSending && hasModel }
    private var tasks: [AgentTask] { workspace.state?.unfinishedTasks(botID: botID) ?? [] }
    private var allCancelling: Bool { !tasks.isEmpty && tasks.allSatisfy { $0.status == "cancelling" } }

    /// The `@fragment` at the end of the draft (`(?:^|\s)@([^\s@]*)$`).
    private var mentionFragment: String? {
        conversation.draft.firstMatch(of: /(?:^|\s)@([^\s@]*)$/).map { String($0.output.1) }
    }
    private var mentionCandidates: [Bot] {
        guard let fragment = mentionFragment, !showMentionsDismissed else { return [] }
        return workspace.bots.filter { $0.id != botID && (fragment.isEmpty || $0.name.localizedCaseInsensitiveContains(fragment)) }
    }

    var body: some View {
        VStack(spacing: 6) {
            if !tasks.isEmpty { statusBar }
            if let error = conversation.sendError {
                Text(error).font(.footnote).foregroundStyle(Theme.danger).frame(maxWidth: .infinity, alignment: .leading)
            }
            if !mentionCandidates.isEmpty { mentionList }
            if let quote { quoteBar(quote) }
            HStack(alignment: .bottom, spacing: 6) {
                Menu {
                    Button { conversation.draft += " @" } label: { Label("提及同伴", systemImage: "at") }
                    Button { onRoutine() } label: { Label("安排例行任务", systemImage: "clock") }
                    Button { nav.openConnectors() } label: { Label("管理连接器", systemImage: "puzzlepiece.extension") }
                } label: {
                    Image(systemName: "plus").font(.system(size: 17, weight: .medium)).foregroundStyle(Theme.muted)
                        .frame(width: 32, height: 32)
                }
                .accessibilityLabel("打开快捷操作")
                TextField("给 \(botName) 发消息…", text: $conversation.draft, axis: .vertical)
                    .lineLimit(1...5)
                    .padding(.vertical, 6)
                    .accessibilityLabel("发送给 Agent 的消息")
                    .onChange(of: conversation.draft) { showMentionsDismissed = false }
                Button { Task { await send() } } label: {
                    Group {
                        if conversation.isSending { ProgressView() }
                        else { Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold)) }
                    }
                    .frame(width: 32, height: 32)
                    .foregroundStyle(canSend ? Theme.primaryForeground : Theme.muted)
                    .background(canSend ? Theme.primary : Theme.secondary, in: Circle())
                }
                .disabled(!canSend)
                .accessibilityLabel("发送消息")
            }
            .padding(.leading, 4).padding(.trailing, 6).padding(.vertical, 6)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Theme.border))
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.background)
        .debugCommand { command, arg in
            switch command {
            case "type": conversation.draft = arg
            case "composerplus": conversation.draft += " @"
            case "sendquoted": Task { await send() }
            default: break
            }
        }
    }

    // MARK: Parts

    private var statusBar: some View {
        HStack(spacing: 6) {
            Circle().fill(Theme.success).frame(width: 6, height: 6)
            Text(tasks.contains { $0.status == "cancelling" } ? "正在停止…" : "Agent 正在工作 · \(tasks[0].phrase)")
                .font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
            Spacer()
            Button { Task { await stopAll() } } label: {
                Label("停止任务", systemImage: "stop").font(.caption).foregroundStyle(Theme.foreground)
            }
            .buttonStyle(.plain)
            .disabled(stopping || allCancelling || workspace.connection == .resyncing)
            .accessibilityLabel("停止任务")
        }
        .padding(.horizontal, 6)
    }

    private func quoteBar(_ quote: QuoteDraft) -> some View {
        HStack(spacing: 8) {
            Rectangle().fill(Theme.brand).frame(width: 3)
            VStack(alignment: .leading, spacing: 1) {
                Text("引用 \(quote.author)").font(.caption.weight(.semibold))
                Text(quote.text.split(whereSeparator: \.isWhitespace).joined(separator: " ")).font(.caption).foregroundStyle(Theme.muted).lineLimit(2)
            }
            Spacer(minLength: 4)
            Button { self.quote = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted).frame(width: 28, height: 28) }
                .buttonStyle(.plain).accessibilityLabel("取消引用")
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .fixedSize(horizontal: false, vertical: true)
    }

    private var mentionList: some View {
        VStack(spacing: 0) {
            ForEach(mentionCandidates.prefix(5)) { bot in
                Button { insert(bot) } label: {
                    HStack(spacing: 10) {
                        workspace.avatar(of: bot, size: 26)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("@\(bot.name)").font(.subheadline.weight(.semibold)).lineLimit(1)
                            Text(bot.instructions.isEmpty ? "同伴 Agent" : bot.instructions).font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .cardStyle(radius: 12)
        .accessibilityElement(children: .contain).accessibilityLabel("提及同伴 Agent")
    }

    // MARK: Actions

    private func insert(_ bot: Bot) {
        guard let fragment = mentionFragment else { return }
        conversation.draft = String(conversation.draft.dropLast(fragment.count)) + bot.name + " "
    }

    private func send() async {
        guard canSend else { return }
        let text = (quote?.prefix ?? "") + conversation.draft
        if await conversation.send(text: text) {
            conversation.draft = ""; quote = nil
        }
    }

    private func stopAll() async {
        stopping = true
        defer { stopping = false }
        for task in tasks where task.status != "cancelling" { try? await workspace.cancelTask(task.id) }
    }
}

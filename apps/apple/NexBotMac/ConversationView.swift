import SwiftUI
import AppKit
import NexClientKit

struct ConversationView: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(UIState.self) private var ui
    @Environment(\.controlActiveState) private var activeState
    @Environment(\.scenePhase) private var scenePhase

    private var conversation: ConversationStore { workspace.conversation(for: botID) }
    private var bot: Bot? { workspace.bot(botID) }
    private var isActive: Bool { activeState == .key && scenePhase == .active }
    private var pendingApprovals: [Approval] { workspace.approvals.filter { $0.botID == botID } }

    var body: some View {
        let conv = conversation
        VStack(spacing: 0) {
            header
            Hairline()
            MessageList(workspace: workspace, conversation: conv, bot: bot)
            VStack(spacing: 10) {
                ForEach(pendingApprovals) { ApprovalCard(workspace: workspace, approval: $0) }
                if let task = conv.activeTask { statusLine(task, conv) }
                Composer(conversation: conv, botName: bot?.name ?? "Agent")
            }
            .frame(maxWidth: Theme.readingWidth)
            .padding(.horizontal, 24).padding(.top, 8).padding(.bottom, 24)
            .frame(maxWidth: .infinity)
        }
        // Read receipts: only while this chat is visible and the window is key.
        .onChange(of: isActive, initial: true) { conv.isActive = isActive }
        .onChange(of: conv.messages.last?.seq) { Task { await conv.markReadIfNeeded() } }
        .onDisappear { conv.isActive = false }
    }

    private var header: some View {
        let phrase = ToolLabels.taskPhrase(workspace.state?.unfinishedTask(botID: botID))
        let state = workspace.companionState(botID)
        return HStack(spacing: 12) {
            if let bot { AgentAvatar(appearance: workspace.appearance(bot), state: state, size: 36) }
            VStack(alignment: .leading, spacing: 3) {
                Text(bot?.name ?? "NexBot").font(.system(size: 15, weight: .semibold))
                Text(phrase.isEmpty ? state.label : phrase).font(.system(size: 12)).foregroundStyle(Theme.muted)
            }
            Spacer()
            Button { ui.inspectorVisible.toggle() } label: {
                Image(systemName: ui.inspectorVisible ? "info.circle.fill" : "info.circle").font(.system(size: 16))
                    .foregroundStyle(ui.inspectorVisible ? Theme.brand : Theme.muted)
                    .frame(width: 32, height: 32).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("助手详情").accessibilityLabel("助手详情")
        }
        .padding(.horizontal, 28).frame(height: 64)
    }

    private func statusLine(_ task: AgentTask, _ conv: ConversationStore) -> some View {
        HStack(spacing: 8) {
            Circle().fill(task.status == "awaiting_approval" ? Theme.approval : Theme.success).frame(width: 6, height: 6)
            Text("Agent 正在工作 · \(task.phrase)").font(.system(size: 11)).foregroundStyle(Theme.muted)
            Spacer()
            Button { Task { await conv.stop() } } label: {
                HStack(spacing: 5) {
                    RoundedRectangle(cornerRadius: 2).strokeBorder(Theme.foreground, lineWidth: 1.2).frame(width: 9, height: 9)
                    Text("停止任务").font(.system(size: 11))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!conv.canStop).help("停止当前任务 (⌘.)")
        }
        .padding(.horizontal, 4)
    }
}

private struct MessageList: View {
    let workspace: WorkspaceStore
    let conversation: ConversationStore
    let bot: Bot?

    private var tailKey: String {
        "\(conversation.messages.last?.seq ?? 0)|\(conversation.streaming.map { $0.text.count }.reduce(0, +))|\(workspace.approvals.count)|\(conversation.activeTask?.id ?? "")"
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if conversation.hasOlder {
                        HStack {
                            Spacer()
                            if conversation.isLoadingOlder { ProgressView().controlSize(.small) }
                            else { Button("加载更早的消息") { loadOlder(proxy) }.buttonStyle(.link) }
                            Spacer()
                        }
                        .onAppear { loadOlder(proxy) }
                        .id("older")
                    }
                    let messages = conversation.messages
                    ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                        let day = Self.dayLabel(message.createdAt)
                        if let day, day != Self.dayLabel(index > 0 ? messages[index - 1].createdAt : nil) {
                            DayDivider(label: day)
                        }
                        MessageRow(message: message, bot: bot, workspace: workspace)
                            .padding(.bottom, 22)
                            .id(message.seq)
                    }
                    ForEach(conversation.streaming, id: \.taskId) { stream in
                        StreamingText(text: stream.text)
                    }
                    if conversation.streaming.isEmpty, let task = conversation.activeTask, task.status != "awaiting_approval" {
                        TypingDots().padding(.bottom, 14).accessibilityLabel(task.phrase)
                    }
                    if let error = conversation.sendError {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.system(size: 12)).foregroundStyle(Theme.danger).textSelection(.enabled)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .frame(maxWidth: Theme.readingWidth)
                .padding(.horizontal, 24).padding(.top, 8).padding(.bottom, 8)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .overlay {
                if !conversation.isLoaded {
                    ProgressView().controlSize(.large)
                } else if conversation.messages.isEmpty && conversation.streaming.isEmpty {
                    VStack(spacing: 6) {
                        Text("开始对话").font(.system(size: 15, weight: .semibold))
                        Text("给 \(bot?.name ?? "Agent") 发一条消息。").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    }
                }
            }
            .onChange(of: tailKey) { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: conversation.isLoaded) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .environment(\.openURL, OpenURLAction { url in
            guard Markdown.isOpenable(url) else { return .discarded }
            NSWorkspace.shared.open(url)
            return .handled
        })
    }

    private func loadOlder(_ proxy: ScrollViewProxy) {
        guard conversation.hasOlder, !conversation.isLoadingOlder, let anchor = conversation.messages.first?.seq else { return }
        Task {
            await conversation.loadOlder()
            proxy.scrollTo(anchor, anchor: .top)
        }
    }

    static func dayLabel(_ date: Date?) -> String? {
        guard let date else { return nil }
        let cal = Calendar.current
        if cal.isDateInToday(date) { return "今天" }
        if cal.isDateInYesterday(date) { return "昨天" }
        return date.formatted(.dateTime.year().month().day())
    }
}

private struct DayDivider: View {
    let label: String
    var body: some View {
        Text(label).font(.system(size: 12)).foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity).padding(.vertical, 14)
    }
}

private struct MessageRow: View {
    let message: AgentMessage
    let bot: Bot?
    let workspace: WorkspaceStore

    var body: some View {
        if let direction = message.a2aDirection, ["sent", "returned", "received"].contains(direction) {
            marker(direction)
        } else if message.role == "system" {
            Text(message.content).font(.system(size: 12)).foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity).textSelection(.enabled)
        } else if message.isFromUser {
            VStack(alignment: .trailing, spacing: 8) {
                Text(Markdown.attributed(message.content))
                    .font(.system(size: 14)).lineSpacing(4)
                    .textSelection(.enabled)
                    .padding(.horizontal, 18).padding(.vertical, 13)
                    .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                timeLabel
            }
            .padding(.leading, 80)
            .frame(maxWidth: .infinity, alignment: .trailing)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if message.role == "peer" {
                    Text("\(author) · \(message.kind == "request" ? "发来任务" : "返回结果")").font(.system(size: 11)).foregroundStyle(Theme.muted)
                }
                if !message.toolSteps.isEmpty { ToolSteps(steps: message.toolSteps) }
                if !message.content.isEmpty {
                    if message.kind == "error" {
                        Text(message.content).font(.system(size: 14)).foregroundStyle(Theme.danger).textSelection(.enabled)
                    } else {
                        MarkdownText(source: message.content)
                    }
                }
                timeLabel
            }
            .padding(.trailing, 40)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var author: String {
        if message.role == "peer" {
            let id = message.a2aPeerID ?? message.senderBotID
            return workspace.bot(id ?? "")?.name ?? "同伴 Agent"
        }
        return bot?.name ?? "Agent"
    }

    private var timeLabel: some View {
        Group {
            if let at = message.createdAt { Text(at.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute())) }
        }
        .font(.system(size: 10)).foregroundStyle(Theme.muted)
    }

    private func marker(_ direction: String) -> some View {
        let peer = workspace.bot(message.a2aPeerID ?? message.senderBotID ?? "")
        return HStack(spacing: 6) {
            Image(systemName: "arrow.left.arrow.right").font(.system(size: 10))
            Text(direction == "sent" ? "已发消息给" : direction == "returned" ? "收到回复自" : "消息来自")
            Text(peer?.name ?? "Agent").fontWeight(.medium)
        }
        .font(.system(size: 12)).foregroundStyle(Theme.muted).frame(maxWidth: .infinity)
    }
}

private struct StreamingText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            MarkdownText(source: text)
            TypingDots()
        }
        .padding(.trailing, 40).padding(.bottom, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("streaming-bubble")
    }
}

/// Subtle three-dot typing indicator.
private struct TypingDots: View {
    var body: some View {
        TimelineView(.animation(minimumInterval: 0.2)) { context in
            let phase = Int(context.date.timeIntervalSinceReferenceDate / 0.35) % 3
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { i in
                    Circle().fill(Theme.muted).frame(width: 5, height: 5).opacity(i == phase ? 1 : 0.35)
                }
            }
        }
    }
}

/// "› 执行记录 · N 项操作", expanding to the individual steps.
private struct ToolSteps: View {
    let steps: [ToolStep]
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold)).rotationEffect(.degrees(expanded ? 90 : 0))
                    Text("执行记录 · \(steps.count) 项操作").font(.system(size: 11))
                }
                .foregroundStyle(Theme.muted).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(steps) { step in
                        HStack(spacing: 8) {
                            Circle().fill(color(step.status)).frame(width: 6, height: 6)
                            Text(step.label).font(.system(size: 12, weight: .medium))
                            if !step.summary.isEmpty {
                                Text(step.summary).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted).lineLimit(1)
                            }
                            Spacer(minLength: 4)
                            Text(ToolLabels.statusText(step.status)).font(.system(size: 11))
                                .foregroundStyle(["failed", "rejected", "cancelled"].contains(step.status) ? Theme.danger : Theme.muted)
                        }
                    }
                }
                .padding(10)
                .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
    }

    private func color(_ status: String) -> Color {
        switch status {
        case "succeeded": Theme.success
        case "failed", "rejected", "cancelled": Theme.danger
        case "running", "pending", "awaiting_approval": Theme.approval
        default: Theme.muted
        }
    }
}

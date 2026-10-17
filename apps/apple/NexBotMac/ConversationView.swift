import SwiftUI
import AppKit
import NexClientKit

struct ConversationView: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(\.controlActiveState) private var activeState
    @Environment(\.scenePhase) private var scenePhase

    private var conversation: ConversationStore { workspace.conversation(for: botID) }
    private var bot: Bot? { workspace.bot(botID) }
    private var isActive: Bool { activeState == .key && scenePhase == .active }
    private var pendingApprovals: [Approval] { workspace.approvals.filter { $0.botID == botID } }

    var body: some View {
        let conv = conversation
        VStack(spacing: 0) {
            MessageList(workspace: workspace, conversation: conv, bot: bot, approvals: pendingApprovals)
            Divider()
            Composer(workspace: workspace, conversation: conv, botName: bot?.name ?? "Agent")
        }
        .navigationTitle(bot?.name ?? "NexBot")
        .navigationSubtitle(ToolLabels.taskPhrase(workspace.state?.unfinishedTask(botID: botID)))
        .toolbar {
            ToolbarItem {
                Button { Task { await workspace.refresh() } } label: { Label("刷新", systemImage: "arrow.clockwise") }
                    .help("刷新 (⌘R)")
            }
        }
        // Read receipts: only while this chat is visible and the window is key.
        .onChange(of: isActive, initial: true) { conv.isActive = isActive }
        .onChange(of: conv.messages.last?.seq) { Task { await conv.markReadIfNeeded() } }
        .onDisappear { conv.isActive = false }
    }
}

private struct MessageList: View {
    let workspace: WorkspaceStore
    let conversation: ConversationStore
    let bot: Bot?
    let approvals: [Approval]

    private var tailKey: String {
        "\(conversation.messages.last?.seq ?? 0)|\(conversation.streaming.map { $0.text.count }.reduce(0, +))|\(approvals.count)|\(conversation.activeTask?.id ?? "")"
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
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
                    ForEach(conversation.messages) { message in
                        MessageRow(message: message, bot: bot, workspace: workspace)
                            .id(message.seq)
                    }
                    ForEach(conversation.streaming, id: \.taskId) { stream in
                        StreamingBubble(text: stream.text, name: bot?.name ?? "Agent")
                    }
                    if conversation.streaming.isEmpty, let task = conversation.activeTask, task.status != "awaiting_approval" {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text(task.phrase).font(.callout).foregroundStyle(.secondary)
                        }.padding(.leading, 4)
                    }
                    ForEach(approvals) { approval in
                        ApprovalCard(workspace: workspace, approval: approval, showsAgent: false)
                    }
                    if let error = conversation.sendError {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.callout).foregroundStyle(.red).textSelection(.enabled)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(16)
            }
            .defaultScrollAnchor(.bottom)
            .overlay {
                if !conversation.isLoaded {
                    ProgressView().controlSize(.large)
                } else if conversation.messages.isEmpty && conversation.streaming.isEmpty {
                    ContentUnavailableView("开始对话", systemImage: "text.bubble", description: Text("给 \(bot?.name ?? "Agent") 发一条消息。"))
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
}

private struct MessageRow: View {
    let message: AgentMessage
    let bot: Bot?
    let workspace: WorkspaceStore

    var body: some View {
        if let direction = message.a2aDirection, ["sent", "returned", "received"].contains(direction) {
            marker(direction)
        } else if message.role == "system" {
            Text(message.content).font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity).textSelection(.enabled)
        } else if message.isFromUser {
            HStack(alignment: .top) {
                Spacer(minLength: 60)
                VStack(alignment: .trailing, spacing: 3) {
                    Text(Markdown.attributed(message.content))
                        .textSelection(.enabled)
                        .foregroundStyle(.white)
                        .tint(.white)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    timeLabel
                }
            }
        } else {
            HStack(alignment: .top, spacing: 8) {
                AvatarView(name: author, size: 30)
                VStack(alignment: .leading, spacing: 4) {
                    if message.role == "peer" {
                        Text("\(author) · \(message.kind == "request" ? "发来任务" : "返回结果")").font(.caption).foregroundStyle(.secondary)
                    }
                    if !message.toolSteps.isEmpty { ToolSteps(steps: message.toolSteps) }
                    if !message.content.isEmpty {
                        Text(Markdown.attributed(message.content))
                            .textSelection(.enabled)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(message.kind == "error" ? AnyShapeStyle(Color.red.opacity(0.15)) : AnyShapeStyle(.quaternary),
                                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    timeLabel
                }
                Spacer(minLength: 60)
            }
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
            if let at = message.createdAt { Text(at.formatted(date: .omitted, time: .shortened)) }
        }
        .font(.caption2).foregroundStyle(.tertiary)
    }

    private func marker(_ direction: String) -> some View {
        let peer = workspace.bot(message.a2aPeerID ?? message.senderBotID ?? "")
        return HStack(spacing: 6) {
            Image(systemName: "arrow.left.arrow.right").font(.caption2)
            Text(direction == "sent" ? "已发消息给" : direction == "returned" ? "收到回复自" : "消息来自")
            Text(peer?.name ?? "Agent").fontWeight(.medium)
        }
        .font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
    }
}

private struct StreamingBubble: View {
    let text: String
    let name: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            AvatarView(name: name, size: 30)
            VStack(alignment: .leading, spacing: 4) {
                Text(Markdown.attributed(text))
                    .textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                HStack(spacing: 4) {
                    ProgressView().controlSize(.mini)
                    Text("正在回复…")
                }.font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 60)
        }
        .accessibilityIdentifier("streaming-bubble")
    }
}

/// Collapsed tool-step rows.
private struct ToolSteps: View {
    let steps: [ToolStep]
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(steps) { step in
                    HStack(spacing: 6) {
                        Circle().fill(color(step.status)).frame(width: 6, height: 6)
                        Text(step.label).font(.caption.weight(.medium))
                        if !step.summary.isEmpty {
                            Text(step.summary).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 4)
                        Text(ToolLabels.statusText(step.status)).font(.caption2).foregroundStyle(.tertiary)
                    }
                }
            }.padding(.top, 4)
        } label: {
            Label(summary, systemImage: "wrench.and.screwdriver").font(.caption).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var summary: String {
        steps.count == 1 ? steps[0].label : "\(steps.count) 个步骤 · \(steps[0].label) 等"
    }

    private func color(_ status: String) -> Color {
        switch status {
        case "succeeded": .green
        case "failed", "rejected", "cancelled": .red
        case "running", "pending", "awaiting_approval": .orange
        default: .secondary
        }
    }
}

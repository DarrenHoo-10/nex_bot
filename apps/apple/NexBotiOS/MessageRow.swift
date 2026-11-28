import SwiftUI
import NexClientKit
import NexMarkdown

/// Day divider: 今天 / 昨天 / M月D日.
struct DateDivider: View {
    let date: Date
    var body: some View {
        Text(TimeFormat.dayLabel(date)).font(.system(size: 11, weight: .medium).monospacedDigit()).foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity).padding(.top, 18).padding(.bottom, 4)
    }
}

/// Full GFM Markdown for iOS chat bubbles, sharing `ChatMarkdownBlocks` with macOS.
struct ChatMarkdown: View {
    let source: String
    var fontSize: CGFloat = 16
    var pending = false
    /// Shrink to the content width (bubbles) instead of filling the column.
    var hug = false
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1
    private var size: CGFloat { fontSize * scale }

    /// URL scheme of a file-path chip; `ChatView` turns taps into previews.
    static let fileScheme = ChatLinks.scheme

    var body: some View {
        VStack(alignment: .leading, spacing: size * 0.6) {
            ForEach(Array(HTMLPreview.parts(source).enumerated()), id: \.offset) { _, part in
                switch part {
                case .markdown(let text): ordinary(text)
                case .preview(let html, let complete): HTMLPreviewMessage(source: html, complete: complete, pending: pending)
                }
            }
        }
    }

    @ViewBuilder private func ordinary(_ source: String) -> some View {
        let document = ChatDocument(source)
        if let html = document.staticHTML {
            StaticHTMLMessage(fragment: html, fontSize: size)
        } else {
            ChatMarkdownBlocks(blocks: document.blocks, fontSize: size)
                .textSelection(.enabled)
                .frame(maxWidth: hug ? nil : .infinity, alignment: .leading)
        }
    }
}

/// One conversation message: user gradient bubble, assistant card bubble or document card, A2A markers, the tool
/// capsule and the long-press actions 引用 / 复制. Consecutive replies of one group show the avatar and time once.
struct MessageRow: View {
    let message: AgentMessage
    let workspace: WorkspaceStore
    let botName: String
    var bot: Bot?
    /// Last message of its group: it carries the avatar and the time.
    var groupEnd = true
    var hasJobReply = false
    var onQuote: (_ author: String, _ text: String) -> Void = { _, _ in }
    var onOpenStep: (ToolStep) -> Void = { _ in }
    var onOpenFile: ((String) -> Void)? = nil
    var onOpenPeer: (String) -> Void = { _ in }
    var onOpenJob: (String) -> Void = { _ in }
    var onReplyJob: (Job) -> Void = { _ in }
    @Environment(\.colorScheme) private var scheme
    @State private var folded = true

    private var peerID: String? { message.a2aPeerID ?? message.senderBotID }
    private var peer: Bot? { peerID.flatMap { workspace.bot($0) } }
    private var peerName: String { peer?.name ?? "同伴 Agent" }
    private var author: String {
        switch message.role {
        case "user": "我"
        case "peer": peerName
        default: botName
        }
    }
    private var accentHex: UInt32 { bot.map { workspace.appearance(of: $0).accentHex } ?? Theme.defaultAccent }
    /// The Markdown text without the trailing attachment link lines, and those links.
    private var parsed: (links: [AttachmentLink], body: String) { AttachmentLink.parse(message.content) }
    private var quotable: Bool { ["user", "assistant", "peer"].contains(message.role) && !parsed.body.isEmpty }
    private var replied: Bool { message.a2aDirection == "replied" && message.role == "assistant" }
    private var isMarker: Bool { message.a2aDirection.map { ["sent", "returned", "received"].contains($0) } ?? false }

    var body: some View {
        Group {
            if message.isJobStart {
                JobMarkerView(message: message, job: message.jobID.flatMap { workspace.state?.job($0) }) { if let id = message.jobID { onOpenJob(id) } }
            } else if message.isJobReport {
                HStack(alignment: .bottom, spacing: 8) {
                    if let bot { AgentAvatar(appearance: workspace.appearance(of: bot), state: .idle, size: 26).padding(.bottom, 22) }
                    VStack(alignment: .leading, spacing: 4) {
                        JobReportCard(message: message, workspace: workspace, open: { if let id = message.jobID { onOpenJob(id) } }, reply: onReplyJob, hasReply: hasJobReply) {
                            let pictures = AttachmentLink.embeddedImages(message.content)
                            if !pictures.isEmpty {
                                AttachmentCards(links: pictures, workspace: workspace, conversation: workspace.conversation(for: message.botID), messageID: message.id)
                            }
                        }
                        time.padding(.horizontal, 4)
                    }
                }
                .padding(.trailing, 28).frame(maxWidth: .infinity, alignment: .leading)
            } else if isMarker {
                marker.frame(maxWidth: .infinity)
            } else if message.role == "system" {
                VStack(alignment: .leading) {
                    if !message.streamProgress.isEmpty { MoreContent { ChatMarkdown(source: message.streamProgress) } }
                    Text(message.content).font(.caption).foregroundStyle(Theme.muted).multilineTextAlignment(.center).frame(maxWidth: .infinity)
                }
            } else if message.isFromUser {
                userColumn.padding(.leading, 56).frame(maxWidth: .infinity, alignment: .trailing)
            } else if message.role == "assistant" {
                HStack(alignment: .bottom, spacing: 8) {
                    if groupEnd, let bot {
                        AgentAvatar(appearance: workspace.appearance(of: bot), state: .idle, size: 26).padding(.bottom, 22)
                    } else {
                        Color.clear.frame(width: 26, height: 1)
                    }
                    assistantColumn
                }
                .padding(.trailing, 28).frame(maxWidth: .infinity, alignment: .leading)
            } else {
                assistantColumn.padding(.horizontal, 34).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .contentShape(Rectangle())
        .contextMenu {
            if message.streamProgress.isEmpty { messageActions }
        }
    }

    @ViewBuilder private var messageActions: some View {
        if quotable {
            Button { onQuote(author, parsed.body) } label: { Label("引用", systemImage: "arrow.turn.up.left") }
            Button { UIPasteboard.general.string = parsed.body } label: { Label("复制", systemImage: "doc.on.doc") }
        }
    }

    // MARK: Columns

    private var userColumn: some View {
        let split = parsed
        let images = split.links.filter(\.isImage), files = split.links.filter { !$0.isImage }
        let conversation = workspace.conversation(for: message.botID)
        return VStack(alignment: .trailing, spacing: 6) {
            if message.jobID != nil {
                Text("回复后台任务：\(message.jobID.flatMap { workspace.state?.job($0)?.title } ?? message.jobTitle)").font(.caption).foregroundStyle(Theme.muted)
            }
            if !images.isEmpty {
                AttachmentCards(links: images, workspace: workspace, conversation: conversation, messageID: message.id, trailing: true)
            }
            if !split.body.isEmpty {
                ChatMarkdown(source: split.body, hug: true)
                    .environment(\.chatInk, .white).environment(\.chatOnAccent, true)
                    .padding(.horizontal, 16).padding(.vertical, 9)
                    .background(userBubbleGradient(accentHex: accentHex, dark: scheme == .dark), in: Bubble.user)
                    .shadow(color: Color(hex: accentHex).opacity(0.26), radius: 9, y: 6)
            }
            if !files.isEmpty {
                AttachmentCards(links: files, workspace: workspace, conversation: conversation, messageID: message.id, trailing: true)
            }
        }
    }

    private var assistantColumn: some View {
        VStack(alignment: .leading, spacing: 4) {
            if message.role == "peer" && message.a2aDirection == nil { peerAuthor }
            if !message.streamProgress.isEmpty || !message.toolSteps.isEmpty {
                MoreContent(durationMs: workDurationMs(steps: message.toolSteps, endedAt: message.createdAt)) {
                    if !message.streamProgress.isEmpty { ChatMarkdown(source: message.streamProgress) }
                    if !message.toolSteps.isEmpty {
                        InlineToolStepsList(workspace: workspace, steps: message.toolSteps, onPreviewFile: onOpenFile)
                    }
                }
            }
            let conversation = workspace.conversation(for: message.botID)
            let pictures = AttachmentLink.embeddedImages(message.content)
            let body = AttachmentLink.stripped(message.content)
            if !pictures.isEmpty {
                AttachmentCards(links: pictures, workspace: workspace, conversation: conversation, messageID: message.id)
            }
            if !body.isEmpty {
                if message.streamProgress.isEmpty { reply(body) }
                else { reply(body).contextMenu { messageActions } }
            }
            if groupEnd || message.role != "assistant" { time.padding(.horizontal, 4) }
        }
    }

    @ViewBuilder private func reply(_ content: String) -> some View {
        let tail = groupEnd && message.role == "assistant"
        if message.kind == "error" {
            Text(content).foregroundStyle(Theme.danger).textSelection(.enabled)
                .padding(.horizontal, 16).padding(.vertical, 10).cardSurface(Bubble.assistant(tail: tail))
        } else if replied {
            VStack(alignment: .leading, spacing: 6) {
                Text(botName).font(.caption.weight(.semibold)).foregroundStyle(Theme.muted).padding(.leading, 4)
                FoldedReply(label: "已回复给\(peerName)", folded: $folded) { ChatMarkdown(source: content) }
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .cardSurface(Bubble.assistant(tail: tail))
            }
        } else if message.role == "assistant", ReplyLayout.of(content).document {
            DocumentCard(outline: ReplyLayout.outline(content), tail: tail) { ChatMarkdown(source: content) }
        } else {
            ChatMarkdown(source: content, hug: true)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .cardSurface(Bubble.assistant(tail: tail))
                .overlay { if message.role == "peer" { Bubble.assistant(tail: false).strokeBorder(Theme.border) } }
        }
    }

    @ViewBuilder private var time: some View {
        if let date = message.createdAt {
            Text(TimeFormat.formatShortTime(date)).font(.system(size: 10.5).monospacedDigit()).foregroundStyle(Theme.muted)
                .accessibilityLabel(TimeFormat.formatTime(date))
        }
    }

    /// 已发消息给 / 消息来自 with a chip that opens the peer's conversation.
    @ViewBuilder private var marker: some View {
        if let direction = message.a2aDirection, let peerID {
            HStack(spacing: 6) {
                Text(direction == "received" ? "消息来自" : "已发消息给").font(.caption).foregroundStyle(Theme.muted)
                peerChip(peerID)
            }
        }
    }

    private var peerAuthor: some View {
        HStack(spacing: 6) {
            if let peer { workspace.avatar(of: peer, size: 22) }
            Text("\(peerName) · \(message.kind == "request" ? "发来任务" : "返回结果")").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
        }
        .padding(.leading, 4)
    }

    private func peerChip(_ id: String) -> some View {
        Button { onOpenPeer(id) } label: {
            HStack(spacing: 5) {
                if let peer { workspace.avatar(of: peer, size: 16) }
                Text(peerName).font(.caption.weight(.semibold))
            }
            .foregroundStyle(Theme.foreground)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Theme.wash, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("打开\(peerName)的对话")
    }
}

/// 已回复给{peer} · 展开/收起.
struct FoldedReply<Content: View>: View {
    let label: String
    @Binding var folded: Bool
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.easeOut(duration: 0.15)) { folded.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).rotationEffect(.degrees(folded ? 0 : 90))
                    Text(label)
                    Text(folded ? "展开" : "收起").foregroundStyle(Theme.brand)
                }
                .font(.caption).foregroundStyle(Theme.muted)
            }
            .buttonStyle(.plain)
            if !folded { content() }
        }
    }
}

/// An agent reply that is still streaming. A reply to a peer's task is folded as 正在回复给{peer}.
struct StreamingRow: View {
    let text: String
    var replyingTo: String?
    var workspace: WorkspaceStore?
    var bot: Bot?
    @State private var folded = true

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if let workspace, let bot {
                workspace.avatar(of: bot, size: 26).padding(.bottom, 22)
            } else {
                Color.clear.frame(width: 26, height: 1)
            }
            VStack(alignment: .leading, spacing: 4) {
                if let replyingTo {
                    FoldedReply(label: "正在回复给\(replyingTo)", folded: $folded) { ChatMarkdown(source: text, pending: true) }
                        .padding(.horizontal, 14).padding(.vertical, 10).cardSurface(Bubble.assistant(tail: true))
                } else {
                    ChatMarkdown(source: text, pending: true, hug: true)
                        .padding(.horizontal, 16).padding(.vertical, 10).cardSurface(Bubble.assistant(tail: true))
                }
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("正在回复…").font(.caption).foregroundStyle(Theme.muted)
                }
                .padding(.horizontal, 6)
            }
        }
        .padding(.trailing, 28).frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Three pulsing dots in a card while the agent works and nothing streams yet.
struct ThinkingIndicator: View {
    let name: String
    let phrase: String
    var workspace: WorkspaceStore?
    var bot: Bot?
    @State private var phase = false
    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if let workspace, let bot { workspace.avatar(of: bot, size: 26) } else { Color.clear.frame(width: 26, height: 1) }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 4) {
                    ForEach(0..<3, id: \.self) { index in
                        Circle().fill(Theme.muted).frame(width: 6, height: 6)
                            .opacity(phase ? 1 : 0.3)
                            .animation(.easeInOut(duration: 0.6).repeatForever().delay(Double(index) * 0.15), value: phase)
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 14)
                .cardSurface(Bubble.assistant(tail: true))
                .accessibilityElement().accessibilityLabel("\(name) 正在处理消息")
                if !phrase.isEmpty { Text(phrase).font(.caption).foregroundStyle(Theme.muted).padding(.horizontal, 6) }
            }
        }
        .onAppear { phase = true }
    }
}

/// The tool-activity capsule (icons, `N 项操作`, red `· M 项失败`); tap to list the steps, tap a step to open its details in the detail 工作 tab.
struct ToolStepsRow: View {
    let steps: [ToolStep]
    var onOpen: (ToolStep) -> Void = { _ in }
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() } } label: {
                ToolCapsuleLabel(summary: ToolActivity.summary(steps), expanded: expanded)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isButton)
            if expanded {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(steps) { step in
                        Button { onOpen(step) } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Circle().fill(color(step)).frame(width: 6, height: 6)
                                Text(step.label)
                                if !step.summary.isEmpty {
                                    Text(step.summary).font(.system(.caption2, design: .monospaced)).lineLimit(2)
                                        .padding(.horizontal, 4).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 4))
                                }
                                Text(ToolLabels.statusText(step.status)).foregroundStyle(color(step))
                            }
                            .padding(.vertical, 4).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("在助手详情中查看")
                    }
                }
                .font(.caption).foregroundStyle(Theme.foreground)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .cardSurface(RoundedRectangle(cornerRadius: 16, style: .continuous))
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

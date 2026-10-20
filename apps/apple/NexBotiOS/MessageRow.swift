import SwiftUI
import NexClientKit
import NexMarkdown

/// Day divider: 今天 / 昨天 / M月D日.
struct DateDivider: View {
    let date: Date
    var body: some View {
        Text(TimeFormat.dayLabel(date)).font(.caption2).foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity).padding(.vertical, 6)
    }
}

/// Block Markdown for chat text. Like `MarkdownText`, plus file-path code spans that open the preview.
struct ChatMarkdown: View {
    let source: String
    var fontSize: CGFloat = 16
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1
    private var size: CGFloat { fontSize * scale }

    /// URL scheme of a file-path chip; `ChatView` turns taps into previews.
    static let fileScheme = "nexbot-file"

    var body: some View {
        if let html = ChatDocument(source).staticHTML {
            StaticHTMLMessage(fragment: html, fontSize: size)
        } else {
        VStack(alignment: .leading, spacing: size * 0.6) {
            ForEach(Array(Markdown.blocks(source).enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Inline Markdown where `` `path/to/file.md` `` spans become tappable chips.
    static func inline(_ text: String) -> AttributedString {
        var result = Markdown.attributed(text)
        var spans: [(Range<AttributedString.Index>, String)] = []
        for run in result.runs where run.inlinePresentationIntent?.contains(.code) == true {
            let code = String(result[run.range].characters)
            if FilePathMatcher.isFilePath(code) { spans.append((run.range, code)) }
        }
        for (range, path) in spans {
            var components = URLComponents()
            components.scheme = fileScheme; components.host = "preview"
            components.queryItems = [URLQueryItem(name: "path", value: path)]
            result[range].link = components.url
            result[range].foregroundColor = Theme.brand
            result[range].backgroundColor = Theme.brandSoft
            result[range].underlineStyle = nil
        }
        return result
    }

    @ViewBuilder private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let text): line(text)
        case .heading(let level, let text):
            line(text).font(.system(size: size + CGFloat(max(0, 4 - level)) * 2, weight: .semibold))
        case .bullet(let level, let text): item(marker: level == 0 ? "•" : "◦", level: level, text: text)
        case .ordered(let level, let number, let text): item(marker: "\(number).", level: level, text: text)
        case .quote(let text):
            line(text).foregroundStyle(Theme.muted)
                .padding(.leading, 10)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.muted.opacity(0.45)).frame(width: 3) }
        case .code(_, let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text).font(.system(size: size - 1, design: .monospaced)).foregroundStyle(Theme.foreground).padding(10)
            }
            .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        case .rule: Rectangle().fill(Theme.border).frame(height: 1)
        }
    }

    private func line(_ text: String) -> some View {
        Text(Self.inline(text)).font(.system(size: size)).lineSpacing(size * 0.35).foregroundStyle(Theme.foreground)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func item(marker: String, level: Int, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(marker).font(.system(size: size)).foregroundStyle(Theme.foreground).frame(minWidth: 12, alignment: .trailing)
            line(text)
        }
        .padding(.leading, CGFloat(level) * 18 + 4)
    }
}

/// One conversation message: bubble or reply, A2A markers, tool steps and the long-press actions 引用 / 复制.
struct MessageRow: View {
    let message: AgentMessage
    let workspace: WorkspaceStore
    let botName: String
    var onQuote: (_ author: String, _ text: String) -> Void = { _, _ in }
    var onOpenStep: (ToolStep) -> Void = { _ in }
    var onOpenPeer: (String) -> Void = { _ in }
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
    /// The Markdown text without the trailing attachment link lines, and those links.
    private var parsed: (links: [AttachmentLink], body: String) { AttachmentLink.parse(message.content) }
    private var quotable: Bool { ["user", "assistant", "peer"].contains(message.role) && !parsed.body.isEmpty }
    private var replied: Bool { message.a2aDirection == "replied" && message.role == "assistant" }

    var body: some View {
        VStack(alignment: message.isFromUser ? .trailing : .leading, spacing: 4) {
            marker
            if message.role == "peer" && message.a2aDirection == nil { peerAuthor }
            if !message.toolSteps.isEmpty { ToolStepsRow(steps: message.toolSteps, onOpen: onOpenStep) }
            let split = parsed
            if !split.body.isEmpty { bodyText(split.body) }
            if !split.links.isEmpty { AttachmentCards(links: split.links, workspace: workspace, trailing: message.isFromUser) }
            if let date = message.createdAt {
                Text(TimeFormat.formatShortTime(date)).font(.system(size: 10)).foregroundStyle(Theme.muted)
                    .accessibilityLabel(TimeFormat.formatTime(date))
            }
        }
        .frame(maxWidth: .infinity, alignment: message.isFromUser ? .trailing : .leading)
        .contentShape(Rectangle())
        .contextMenu {
            if quotable {
                Button { onQuote(author, parsed.body) } label: { Label("引用", systemImage: "arrow.turn.up.left") }
                Button { UIPasteboard.general.string = parsed.body } label: { Label("复制", systemImage: "doc.on.doc") }
            }
        }
    }

    @ViewBuilder private func bodyText(_ content: String) -> some View {
        if message.isFromUser {
            ChatMarkdown(source: content)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .padding(.leading, 40)
        } else if message.kind == "error" {
            Text(content).foregroundStyle(Theme.danger).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
        } else if replied {
            VStack(alignment: .leading, spacing: 6) {
                Text(botName).font(.caption.weight(.semibold))
                FoldedReply(label: "已回复给\(peerName)", folded: $folded) { ChatMarkdown(source: content) }
            }
        } else {
            ChatMarkdown(source: content)
        }
    }

    /// 已发消息给 / 消息来自 with a chip that opens the peer's conversation.
    @ViewBuilder private var marker: some View {
        if let direction = message.a2aDirection, ["sent", "returned", "received"].contains(direction), let peerID {
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
    }

    private func peerChip(_ id: String) -> some View {
        Button { onOpenPeer(id) } label: {
            HStack(spacing: 5) {
                if let peer { workspace.avatar(of: peer, size: 16) }
                Text(peerName).font(.caption.weight(.semibold))
            }
            .foregroundStyle(Theme.foreground)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Theme.secondary, in: Capsule())
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
    @State private var folded = true

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let replyingTo {
                FoldedReply(label: "正在回复给\(replyingTo)", folded: $folded) { ChatMarkdown(source: text) }
            } else {
                ChatMarkdown(source: text)
            }
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("正在回复…").font(.caption).foregroundStyle(Theme.muted)
            }
        }
    }
}

/// Three pulsing dots while the agent works and nothing streams yet.
struct ThinkingIndicator: View {
    let name: String
    let phrase: String
    @State private var phase = false
    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { index in
                    Circle().fill(Theme.muted).frame(width: 6, height: 6)
                        .opacity(phase ? 1 : 0.3)
                        .animation(.easeInOut(duration: 0.6).repeatForever().delay(Double(index) * 0.15), value: phase)
                }
            }
            .accessibilityElement().accessibilityLabel("\(name) 正在处理消息")
            if !phrase.isEmpty { Text(phrase).font(.caption).foregroundStyle(Theme.muted) }
        }
        .onAppear { phase = true }
    }
}

/// Tool steps collapsed to "› 执行记录 · N 项操作"; tap a step to open its details in the detail 工作 tab.
struct ToolStepsRow: View {
    let steps: [ToolStep]
    var onOpen: (ToolStep) -> Void = { _ in }
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

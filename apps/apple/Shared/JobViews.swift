import SwiftUI
import NexClientKit

/// Splits a failed job report into its readable first sentence and collapsible technical details (`JobReportCard.tsx`).
func splitJobFailure(_ text: String) -> (lead: String, rest: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let firstSentence = trimmed.split(whereSeparator: { "。！？!?".contains($0) }).first.map(String.init) ?? ""
    let technicalPattern = #"^\s*\d{3}\b|^\s*[\{\[]|https?://"#
    if firstSentence.range(of: technicalPattern, options: .regularExpression) != nil {
        return ("执行时出错了。", trimmed)
    }
    if let range = trimmed.range(of: #"[。！？!?]"#, options: .regularExpression),
       range.upperBound < trimmed.endIndex {
        let lead = String(trimmed[..<range.upperBound])
        let rest = String(trimmed[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        return (lead, rest)
    }
    return (trimmed, "")
}

/// Strips internal main-chat relay framing (`用户在主对话中说（...）：` and `主对话备注：...`) so relayed messages
/// read cleanly as user speech and wake/note-only messages render as subtle notices (`JobChat.tsx`).
func parseJobUserMessage(_ raw: String) -> (isNotice: Bool, content: String) {
    let pattern = #"^用户在主对话中说（[^）]*）：(?:\n([\s\S]*))?$"#
    if let regex = try? NSRegularExpression(pattern: pattern),
       let match = regex.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)) {
        let body: String
        if match.range(at: 1).location != NSNotFound, let r = Range(match.range(at: 1), in: raw) {
            body = String(raw[r])
        } else {
            body = ""
        }
        if let noteRegex = try? NSRegularExpression(pattern: #"(?:^|\n)主对话备注：([\s\S]*)$"#),
           let noteMatch = noteRegex.firstMatch(in: body, range: NSRange(body.startIndex..., in: body)),
           let fullNote = Range(noteMatch.range, in: body) {
            let clean = String(body[..<fullNote.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !clean.isEmpty { return (false, clean) }
            if noteMatch.range(at: 1).location != NSNotFound, let noteTextRange = Range(noteMatch.range(at: 1), in: body) {
                return (true, String(body[noteTextRange]).trimmingCharacters(in: .whitespacesAndNewlines))
            }
            return (true, "")
        }
        let clean = body.trimmingCharacters(in: .whitespacesAndNewlines)
        return (false, clean)
    }
    if raw.hasPrefix("主对话备注：") {
        return (true, String(raw.dropFirst("主对话备注：".count)).trimmingCharacters(in: .whitespacesAndNewlines))
    }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.hasSuffix("已空闲，可以继续。") && trimmed.count > "已空闲，可以继续。".count {
        return (true, trimmed)
    }
    return (false, raw)
}

/// 已交给后台：the main chat handed work to a background job. Opens the job's interactive JobChat.
struct JobMarkerView: View {
    let message: AgentMessage
    let job: Job?
    let open: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text("已交给后台").font(.system(size: 12)).foregroundStyle(Theme.muted)
            Button(action: open) {
                Text(job?.title ?? message.jobTitle).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground).lineLimit(1)
                    .padding(.horizontal, 9).padding(.vertical, 3)
                    .background(Theme.card, in: Capsule()).overlay(Capsule().strokeBorder(Theme.border))
            }
            .buttonStyle(.plain).accessibilityLabel("查看后台任务：\(job?.title ?? message.jobTitle)")
            if let at = message.createdAt { Text(TimeFormat.formatTime(at)).font(.system(size: 10.5)).foregroundStyle(Theme.muted) }
        }
        .frame(maxWidth: .infinity).padding(.vertical, 6)
    }
}

/// A background job's report: title, its current stage (from state, not the message), the conclusion and files, and
/// the actions the stage allows. Actions appear only on the job's latest report when the user hasn't replied yet.
struct JobReportCard<Media: View>: View {
    let message: AgentMessage
    let workspace: WorkspaceStore
    let open: () -> Void
    let reply: (Job) -> Void
    var hasReply = false
    @ViewBuilder var media: () -> Media
    @State private var busy = false
    @State private var error: String?
    @State private var revising = false
    @State private var feedback = ""

    private var job: Job? { message.jobID.flatMap { workspace.state?.job($0) } }
    var isCurrentReport: Bool {
        guard let taskID = job?.taskID, !hasReply else { return false }
        return taskID == message.taskID && job?.latestReport?.messageID == message.id
    }
    private var threadColor: Color {
        let palette: [UInt32] = [0x438ece, 0x369f96, 0x9472cf, 0xcc9141]
        let digit = message.jobID?.first?.hexDigitValue ?? 0
        return Color(hex: palette[digit % palette.count])
    }
    private var report: some View {
        let bodyText = AttachmentLink.stripped(message.jobReportBody).trimmingCharacters(in: .whitespacesAndNewlines)
        let isFailed = message.jobState == "failed"
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Button(action: open) {
                    Text(job?.title ?? message.jobTitle)
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.foreground)
                        .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(threadColor.opacity(0.16), in: RoundedRectangle(cornerRadius: 6))
                }.buttonStyle(.plain).accessibilityHint("查看执行详情")
                if let job {
                    Spacer(minLength: 0)
                    HStack(spacing: 5) {
                        Circle().frame(width: 5, height: 5).accessibilityHidden(true)
                        Text(job.stageText).font(.system(size: 11.5, weight: .semibold))
                    }
                    .foregroundStyle(jobStageInk(job.stage)).fixedSize()
                }
            }
            media()
            if isFailed && !bodyText.isEmpty {
                let failure = splitJobFailure(bodyText)
                VStack(alignment: .leading, spacing: 6) {
                    Text(failure.lead)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.foreground)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    if !failure.rest.isEmpty {
                        DisclosureGroup("详细信息") {
                            Text(failure.rest)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(Theme.muted)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.top, 4)
                        }
                        .font(.caption)
                        .tint(Theme.muted)
                    }
                }
            } else if !bodyText.isEmpty {
                MarkdownText(source: bodyText)
            }
            if isCurrentReport, let job, (job.stage == "failed" || (job.stage == "review" && job.todoID != nil)) {
                cardActions(job)
            }
            if let error { Text(error).font(.caption).foregroundStyle(Theme.danger).textSelection(.enabled) }
        }
        .padding(.horizontal, 15).padding(.vertical, 12)
        .frame(maxWidth: 560, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(isFailed ? Theme.danger.opacity(0.35) : Theme.border))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            report
            if isCurrentReport, let job, job.stage == "question" { responseActions(job) }
        }
        .alert("继续修改", isPresented: $revising) {
            TextField("告诉 AI 要调整什么", text: $feedback)
            Button("取消", role: .cancel) { feedback = "" }
            Button("提交") {
                if let job {
                    let note = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
                    run { try await workspace.reviseJob(job, feedback: note) }
                    feedback = ""
                }
            }
            .disabled(feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    @ViewBuilder private func cardActions(_ job: Job) -> some View {
        HStack(spacing: 10) {
            if job.stage == "review", job.todoID != nil {
                Button("验收") { run { try await workspace.acceptJob(job) } }.buttonStyle(ConversationActionButtonStyle())
                Button("修改") { revising = true }.buttonStyle(ConversationActionButtonStyle(tone: .dark))
            }
            if job.stage == "failed" {
                Button("重试") { run { try await workspace.retryJob(job) } }.buttonStyle(ConversationActionButtonStyle())
                Button("查看") { open() }.buttonStyle(ConversationActionButtonStyle(tone: .dark))
            }
            if busy { ProgressView().controlSize(.small) }
        }
        .disabled(busy)
    }

    @ViewBuilder private func responseActions(_ job: Job) -> some View {
        HStack(spacing: 10) {
            if job.stage == "question" {
                Button("回复") { reply(job) }
                    .buttonStyle(ConversationActionButtonStyle(size: .compact))
            }
            if busy { ProgressView().controlSize(.small) }
        }
        .disabled(busy)
    }

    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        busy = true; error = nil
        Task {
            defer { busy = false }
            do { try await action() } catch { self.error = (error as? CoreError)?.message ?? error.localizedDescription }
        }
    }
}

/// Interactive conversation with one background job's sub-agent (mirrors `src/personal/components/JobChat.tsx`).
struct JobDetailView: View {
    let workspace: WorkspaceStore
    let jobID: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var detail: JobDetail?
    @State private var error: String?
    @State private var loading = false
    @State private var stopping = false
    @State private var draft = ""
    @State private var pendingSend: (text: String, clientID: String)?
    @State private var sending = false
    @State private var outgoing: [(id: String, text: String, at: Double)] = []
    @State private var refreshNonce = 0
    @State private var expandedSteps: Set<String> = []

    private var job: Job? { detail?.job ?? workspace.state?.job(jobID) }
    private var bot: Bot? { job.flatMap { workspace.bot($0.botID) } }
    private var working: Bool { job?.isBusy == true }
    private var canSend: Bool {
        !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && job != nil && job?.stage != "stopped"
    }

    private enum EntryKind {
        case user(pending: Bool)
        case assistant(progress: String, question: String?)
        case notice
        case steps([ToolStep])
    }

    private struct TimelineEntry: Identifiable {
        let id: String
        let at: Double
        let content: String
        let kind: EntryKind
    }

    private var brief: AgentMessage? {
        detail?.messages.first(where: \.isFromUser)
    }

    private var entries: [TimelineEntry] {
        guard let detail else { return [] }
        let messages = detail.messages
        let reports = detail.reports
        let briefID = brief?.id
        let timeline = messages.filter { m in
            guard m.id != briefID else { return false }
            guard !m.content.isEmpty || !m.streamProgress.isEmpty else { return false }
            return m.role == "user" || m.role == "assistant" || (m.role == "system" && !m.streamProgress.isEmpty)
        }

        func isArtifact(_ m: AgentMessage) -> Bool {
            m.sourceKey.hasPrefix("image:") || m.sourceKey.hasPrefix("html:")
        }

        var reportByTask: [String: JobRoundReport] = [:]
        for report in reports {
            if let taskID = report.taskID, !taskID.isEmpty { reportByTask[taskID] = report }
        }
        var finalAnswerByTask: [String: AgentMessage] = [:]
        for m in timeline where m.role == "assistant" && !isArtifact(m) {
            if let taskID = m.taskID, !taskID.isEmpty { finalAnswerByTask[taskID] = m }
        }

        var suppressedMessages = Set<String>()
        var suppressedReports = Set<String>()
        var reportProgress: [String: String] = [:]
        for (taskID, report) in reportByTask {
            guard let finalAnswer = finalAnswerByTask[taskID] else { continue }
            if report.automatic {
                suppressedReports.insert(report.id)
            } else if !report.summary.isEmpty || report.question != nil {
                suppressedMessages.insert(finalAnswer.id)
                if !finalAnswer.streamProgress.isEmpty {
                    reportProgress[report.id] = finalAnswer.streamProgress
                }
            }
        }

        let keptTimeline = timeline.filter { !suppressedMessages.contains($0.id) }
        let replies = Set(keptTimeline.filter { $0.role != "user" }.map { $0.content.trimmingCharacters(in: .whitespacesAndNewlines) })

        var built: [TimelineEntry] = []
        for m in keptTimeline {
            let at = m.createdAt?.timeIntervalSince1970 ?? 0
            if m.role == "user" {
                let parsed = parseJobUserMessage(m.content)
                guard !parsed.content.isEmpty else { continue }
                built.append(TimelineEntry(
                    id: "m:\(m.id)",
                    at: at,
                    content: parsed.content,
                    kind: parsed.isNotice ? .notice : .user(pending: false)
                ))
            } else {
                built.append(TimelineEntry(
                    id: "m:\(m.id)",
                    at: at,
                    content: m.content,
                    kind: .assistant(progress: m.streamProgress, question: nil)
                ))
            }
        }

        for report in reports where !suppressedReports.contains(report.id) {
            let include: Bool
            if let taskID = report.taskID, !taskID.isEmpty {
                include = !report.summary.isEmpty || report.question != nil
            } else {
                include = report.question != nil || (!report.summary.isEmpty && !replies.contains(report.summary.trimmingCharacters(in: .whitespacesAndNewlines)))
            }
            guard include else { continue }
            built.append(TimelineEntry(
                id: "r:\(report.id)",
                at: report.createdAt?.timeIntervalSince1970 ?? 0,
                content: report.summary,
                kind: .assistant(progress: reportProgress[report.id] ?? "", question: report.question)
            ))
        }

        let visibleSteps = detail.steps.filter { $0.toolName != "job.report" && $0.toolName != "job.progress" }
        var stepBuckets: [String: (at: Double, steps: [ToolStep])] = [:]
        var bucketOrder: [String] = []
        for step in visibleSteps {
            let at = step.createdAt?.timeIntervalSince1970 ?? 0
            let beforeKey = built.filter { $0.at <= at }.last?.id ?? "start"
            let key = "s:\(beforeKey)"
            if var existing = stepBuckets[key] {
                existing.steps.append(step)
                stepBuckets[key] = existing
            } else {
                stepBuckets[key] = (at, [step])
                bucketOrder.append(key)
            }
        }
        for key in bucketOrder {
            if let bucket = stepBuckets[key] {
                built.append(TimelineEntry(id: key, at: bucket.at, content: "", kind: .steps(bucket.steps)))
            }
        }

        let shownUserTexts = Set(built.compactMap { entry -> String? in
            if case .user = entry.kind { return entry.content }
            return nil
        })
        for item in outgoing where !shownUserTexts.contains(item.text) {
            built.append(TimelineEntry(id: "o:\(item.id)", at: item.at, content: item.text, kind: .user(pending: true)))
        }

        return built.sorted { $0.at < $1.at }
    }

    var body: some View {
        VStack(spacing: 0) {
            headerBar
            Divider().overlay(Theme.border)
            if let error {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.danger)
                    Text(error).font(.caption).foregroundStyle(Theme.danger).textSelection(.enabled)
                    Spacer()
                }
                .padding(.horizontal, 16).padding(.vertical, 8)
                .background(Theme.danger.opacity(0.08))
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if let brief {
                            DisclosureGroup("任务书") {
                                Text(brief.content)
                                    .font(.system(size: 13))
                                    .foregroundStyle(Theme.muted)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.top, 6)
                            }
                            .font(.caption.weight(.semibold))
                            .tint(Theme.muted)
                            .padding(.horizontal, 14).padding(.vertical, 10)
                            .background(Theme.wash, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }

                        ForEach(entries) { entry in
                            entryRow(entry)
                        }

                        if working {
                            workingRow
                        }

                        if detail == nil && loading {
                            HStack { Spacer(); ProgressView(); Spacer() }.padding(.vertical, 32)
                        }

                        Color.clear.frame(height: 1).id("job-chat-bottom")
                    }
                    .frame(maxWidth: Theme.readingWidth)
                    .padding(.horizontal, 16).padding(.vertical, 16)
                    .frame(maxWidth: .infinity)
                }
                #if os(iOS)
                .scrollDismissesKeyboard(.interactively)
                #endif
                .defaultScrollAnchor(.bottom)
                .refreshable { await refresh() }
                .onChange(of: entries.count) { _, _ in
                    proxy.scrollTo("job-chat-bottom", anchor: .bottom)
                }
                .onChange(of: detail?.streaming ?? "") { _, _ in
                    proxy.scrollTo("job-chat-bottom", anchor: .bottom)
                }
            }
            composerBar
        }
        .background(Theme.background)
        .task(id: "\(jobID):\(refreshNonce)") {
            await refresh()
            while !Task.isCancelled, (detail?.job.isOpen ?? true) {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                await refresh()
            }
        }
        #if os(macOS)
        .frame(minWidth: 540, idealWidth: 660, minHeight: 500, idealHeight: 680)
        #endif
    }

    private var headerBar: some View {
        HStack(spacing: 10) {
            if let bot {
                AgentAvatar(appearance: AgentAppearance.of(bot, firstID: workspace.bots.first?.id), size: 26)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(job?.title ?? "后台任务")
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(Theme.foreground)
                    .lineLimit(1)
                if let bot {
                    Text(bot.name).font(.caption2).foregroundStyle(Theme.muted)
                }
            }
            if let job {
                Text(job.stageText)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(jobStageInk(job.stage))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(jobStageInk(job.stage).opacity(0.12), in: Capsule())
                    .fixedSize()
            }
            Spacer(minLength: 8)
            if job?.isOpen == true {
                Button(stopping ? "停止中…" : "停止") { Task { await stop() } }
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(Theme.danger)
                    .padding(.horizontal, 10).frame(height: 30)
                    .background(Theme.danger.opacity(0.10), in: Capsule())
                    .buttonStyle(.plain)
                    .disabled(stopping)
            }
            Button("关闭") { dismiss() }
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(Theme.foreground)
                .padding(.horizontal, 12).frame(height: 30)
                .background(Theme.secondary, in: Capsule())
                .buttonStyle(.plain)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.card)
    }

    @ViewBuilder private func entryRow(_ entry: TimelineEntry) -> some View {
        switch entry.kind {
        case .steps(let steps):
            let open = expandedSteps.contains(entry.id)
            VStack(alignment: .leading, spacing: 6) {
                Button {
                    withAnimation(.easeOut(duration: 0.14)) {
                        if open { expandedSteps.remove(entry.id) } else { expandedSteps.insert(entry.id) }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Text("\(steps.count) 项操作")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Theme.muted)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Theme.muted.opacity(0.75))
                            .rotationEffect(.degrees(open ? 90 : 0))
                    }
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(Theme.wash, in: Capsule())
                }
                .buttonStyle(.plain)
                if open {
                    InlineToolStepsList(workspace: workspace, steps: steps)
                }
            }
            .padding(.leading, 34)

        case .notice:
            Text(entry.content)
                .font(.caption)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 12).padding(.vertical, 4)
                .background(Theme.wash, in: Capsule())
                .frame(maxWidth: .infinity)

        case .user(let pending):
            VStack(alignment: .trailing, spacing: 4) {
                MarkdownText(source: entry.content, hug: true)
                    .environment(\.chatInk, .white)
                    .environment(\.chatOnAccent, true)
                    .padding(.horizontal, 15).padding(.vertical, 9)
                    .background(userBubbleGradient(dark: scheme == .dark), in: Bubble.user)
                    .opacity(pending ? 0.78 : 1)
                if pending {
                    Text("发送中…").font(.system(size: 10.5)).foregroundStyle(Theme.muted).padding(.horizontal, 4)
                }
            }
            .padding(.leading, 56)
            .frame(maxWidth: .infinity, alignment: .trailing)

        case .assistant(let progress, let question):
            HStack(alignment: .bottom, spacing: 8) {
                if let bot {
                    AgentAvatar(appearance: AgentAppearance.of(bot, firstID: workspace.bots.first?.id), size: 26)
                        .padding(.bottom, 18)
                } else {
                    Color.clear.frame(width: 26, height: 1)
                }
                VStack(alignment: .leading, spacing: 5) {
                    if !progress.isEmpty {
                        MoreContent { MarkdownText(source: progress) }
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        if !entry.content.isEmpty {
                            MarkdownText(source: entry.content, hug: true)
                        }
                        if let question, !question.isEmpty {
                            Text(question)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Theme.foreground)
                                .textSelection(.enabled)
                        }
                    }
                    .padding(.horizontal, 15).padding(.vertical, 10)
                    .cardSurface(Bubble.assistant(tail: true))
                    if entry.at > 0 {
                        Text(TimeFormat.formatShortTime(Date(timeIntervalSince1970: entry.at)))
                            .font(.system(size: 10.5).monospacedDigit())
                            .foregroundStyle(Theme.muted)
                            .padding(.horizontal, 4)
                    }
                }
            }
            .padding(.trailing, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var workingRow: some View {
        let streaming = detail?.streaming ?? ""
        return HStack(alignment: .bottom, spacing: 8) {
            if let bot {
                AgentAvatar(appearance: AgentAppearance.of(bot, firstID: workspace.bots.first?.id), state: .working, size: 26)
                    .padding(.bottom, 16)
            } else {
                Color.clear.frame(width: 26, height: 1)
            }
            VStack(alignment: .leading, spacing: 4) {
                if !streaming.isEmpty {
                    MarkdownText(source: streaming, pending: true, hug: true)
                        .padding(.horizontal, 15).padding(.vertical, 10)
                        .cardSurface(Bubble.assistant(tail: true))
                } else {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text(job?.progress ?? "子代理正在工作…")
                            .font(.system(size: 12.5))
                            .foregroundStyle(Theme.muted)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .cardSurface(Bubble.assistant(tail: true))
                }
                if !streaming.isEmpty {
                    Text("正在回复…").font(.system(size: 11)).foregroundStyle(Theme.muted).padding(.horizontal, 4)
                }
            }
        }
        .padding(.trailing, 32)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var composerBar: some View {
        let stopped = job?.stage == "stopped"
        return HStack(alignment: .bottom, spacing: 8) {
            TextField(
                stopped ? "后台任务已停止" : (job.map { "给「\($0.title)」发消息…" } ?? "发消息…"),
                text: $draft,
                axis: .vertical
            )
            .lineLimit(1...5)
            .textFieldStyle(.plain)
            .font(.system(size: 14))
            .disabled(job == nil || stopped)
            .onSubmit {
                #if os(macOS)
                if canSend { Task { await send() } }
                #endif
            }
            .onChange(of: draft) { _, next in
                let trimmed = next.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty, let pendingSend, pendingSend.text != trimmed {
                    self.pendingSend = nil
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 8)

            Button { Task { await send() } } label: {
                Group {
                    if sending { ProgressView().controlSize(.small) }
                    else { Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold)) }
                }
                .foregroundStyle(canSend ? Theme.primaryForeground : Theme.muted)
                .frame(width: 34, height: 34)
                .background(canSend ? Theme.primary : Theme.wash, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel("发送消息")
        }
        .padding(.leading, 8).padding(.trailing, 6).padding(.vertical, 6)
        .glass(RoundedRectangle(cornerRadius: 24, style: .continuous), strong: true)
        .frame(maxWidth: Theme.readingWidth)
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity)
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending, let job, job.stage != "stopped" else { return }
        if pendingSend?.text != text {
            pendingSend = (text: text, clientID: UUID().uuidString)
        }
        let clientID = pendingSend!.clientID
        sending = true
        error = nil
        draft = ""
        outgoing.append((id: clientID, text: text, at: Date().timeIntervalSince1970))
        defer { sending = false }
        do {
            try await workspace.sendJobInput(jobID: job.id, text: text, clientID: clientID)
            pendingSend = nil
            refreshNonce += 1
            await refresh()
        } catch {
            outgoing.removeAll { $0.id == clientID }
            if draft.isEmpty { draft = text }
            self.error = (error as? CoreError)?.message ?? error.localizedDescription
        }
    }

    private func stop() async {
        stopping = true
        defer { stopping = false }
        do { try await workspace.stopJob(jobID) }
        catch { self.error = (error as? CoreError)?.message ?? error.localizedDescription; return }
        await refresh()
    }

    private func refresh() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let next = try await workspace.jobDetail(id: jobID)
            detail = next
            error = nil
            let receivedKeys = Set(next.messages.compactMap { $0.row.string("source_key") })
            let receivedUsers = Set(next.messages.filter(\.isFromUser).map { parseJobUserMessage($0.content).content })
            outgoing.removeAll { item in
                receivedKeys.contains("job-input:\(jobID):\(item.id)")
                    || receivedKeys.contains("input:\(item.id)")
                    || (receivedKeys.isEmpty && receivedUsers.contains(item.text))
            }
        } catch {
            self.error = (error as? CoreError)?.message ?? error.localizedDescription
        }
    }
}

/// An open background job row in the assistant's 工作 panel (Mac inspector / iOS detail).
struct JobListEntry: View {
    let job: Job
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(job.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.foreground)
                        .lineLimit(1)
                    if let progress = job.progress {
                        Text(progress)
                            .font(.caption)
                            .foregroundStyle(Theme.muted)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Text(job.stageText)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(jobStageInk(job.stage))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(jobStageInk(job.stage).opacity(0.12), in: Capsule())
                    .fixedSize()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(job.title)，\(job.stageText)")
        .accessibilityHint("查看执行详情")
    }
}

func jobStageInk(_ stage: String) -> Color {
    switch stage {
    case "running", "queued": Theme.dynamic(light: 0x3767a3, dark: 0x9ec1ee)
    case "approval", "question", "review": Theme.dynamic(light: 0x925b1e, dark: 0xefba80)
    case "blocked", "failed": Theme.dynamic(light: 0xa64643, dark: 0xf2a5a1)
    case "done": Theme.dynamic(light: 0x327663, dark: 0x91cdb9)
    default: Theme.muted
    }
}

/// Opens a job's details as a sheet by id.
struct JobSheetItem: Identifiable, Hashable { let id: String }

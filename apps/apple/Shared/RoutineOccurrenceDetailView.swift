import SwiftUI
import NexClientKit

/// Scoped to scheduling controls, aligned with the NexBot bright-blue palette.
struct RoutineButtonStyle: ButtonStyle {
    var primary = false
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(primary ? Theme.primaryForeground : Theme.foreground)
            .padding(.horizontal, 14).frame(minWidth: 40, minHeight: 36)
            .background {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(primary ? Theme.primary : Theme.secondary)
            }
            .overlay {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .strokeBorder(primary ? Color.white.opacity(0.18) : Theme.border, lineWidth: 1)
            }
            .opacity(enabled ? (configuration.isPressed ? 0.85 : 1) : 0.42)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
            .contentShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
    }
}

/// Presentation shared by the two native scheduling surfaces.
enum RoutineCopy {
    static let activeStatuses: Set<String> = [
        "pending", "queued", "running", "awaiting_approval", "paused", "needs_reconciliation", "cancelling",
    ]
    static func category(_ kind: RoutineTaskKind) -> String {
        switch kind { case .reminder: "提醒我"; case .monitor: "帮我检查"; case .report: "整理汇总"; case .action: "帮我处理" }
    }
    static func frequency(_ kind: ScheduleKind) -> String {
        switch kind { case .daily: "每天"; case .interval: "每隔一段时间"; case .once: "只做一次" }
    }
    static func schedule(_ routine: Routine) -> String {
        switch routine.scheduleKind {
        case .daily: "每天 \(routine.localTime ?? "")"
        case .interval: routine.intervalMinutes % 60 == 0 ? "每 \(routine.intervalMinutes / 60) 小时" : "每 \(routine.intervalMinutes) 分钟"
        case .once: routine.runAt.map { "\(TimeFormat.formatTime($0)) · 只做一次" } ?? "只做一次"
        }
    }
    static func hasEnded(_ routine: Routine, now: Date = Date()) -> Bool {
        routine.scheduleKind == .once && !routine.enabled && routine.nextDueAt == nil && (routine.runAt.map { $0 <= now } ?? false)
    }
    static func next(_ routine: Routine) -> String {
        if hasEnded(routine) { return "已结束" }
        if !routine.enabled { return "已关闭" }
        return routine.nextDueAt.map { "下一次 \(TimeFormat.formatTime($0))" } ?? "等待安排"
    }
    static func status(_ raw: String) -> String {
        switch raw {
        case "pending", "queued": "等待开始"
        case "running": "正在处理"
        case "awaiting_approval": "等待你的确认"
        case "needs_reconciliation": "需要确认结果"
        case "cancelling": "正在停止"
        case "rejected": "未获同意"
        case "failed": "未完成"
        default: ToolLabels.statusText(raw)
        }
    }
    static func skipReason(_ raw: String) -> String {
        switch raw {
        case "expired": "已过期"
        case "coalesced": "已合并到后续执行"
        default: raw
        }
    }
}

struct RoutineListEntry: View {
    let routine: Routine
    let latest: RoutineOccurrence?
    let showPlan: () -> Void
    let showResult: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: showPlan) {
                HStack {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(routine.name).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.foreground)
                        Text(RoutineCopy.schedule(routine)).font(.caption).foregroundStyle(Theme.muted)
                        Text(RoutineCopy.next(routine)).font(.caption).foregroundStyle(Theme.muted)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.right").foregroundStyle(Theme.brand)
                }.frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityHint("查看任务安排")
            if let latest {
                Button("最近结果 · \(RoutineCopy.status(latest.displayStatus))", action: showResult)
                    .buttonStyle(RoutineButtonStyle())
            }
        }.padding(14)
    }
}

/// Read-only plan, available even before the first execution exists.
struct RoutinePlanDetailView: View {
    let workspace: WorkspaceStore
    let routine: Routine
    @Environment(\.dismiss) private var dismiss
    @State private var occurrence: RoutineOccurrence?
    @State private var confirmation: Routine?
    @State private var deleting = false
    @State private var confirming = false
    @State private var busy = false
    @State private var error: String?

    private var current: Routine { workspace.state?.routines.first { $0.id == routine.id } ?? routine }
    private var latest: RoutineOccurrence? { workspace.state?.occurrences.first { $0.routineID == routine.id } }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("任务安排").font(.headline)
                Spacer()
                Button("完成") { dismiss() }.buttonStyle(RoutineButtonStyle())
            }.padding(20)
            Divider().overlay(Theme.border)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(current.name).font(.title2.weight(.semibold))
                    Text(current.prompt).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                        .background(Theme.wash, in: RoundedRectangle(cornerRadius: 14))
                    VStack(alignment: .leading, spacing: 8) {
                        Text(RoutineCopy.schedule(current))
                        Text(current.timeZone).font(.caption).foregroundStyle(Theme.muted)
                        Text(RoutineCopy.next(current)).foregroundStyle(Theme.muted)
                    }
                    if let latest {
                        Button("最近结果 · \(RoutineCopy.status(latest.displayStatus))") { occurrence = latest }
                            .buttonStyle(RoutineButtonStyle())
                    }
                    HStack(spacing: 12) {
                        if current.enabled {
                            Button("关闭任务") { confirmation = current; deleting = false; confirming = true }
                                .buttonStyle(RoutineButtonStyle())
                        }
                        Button(role: .destructive) { confirmation = current; deleting = true; confirming = true } label: {
                            Label("删除任务", systemImage: "trash").foregroundStyle(Theme.danger)
                        }.buttonStyle(RoutineButtonStyle())
                        if busy { ProgressView() }
                    }.disabled(busy)
                    if let error { Text(error).foregroundStyle(Theme.danger).textSelection(.enabled) }
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .foregroundStyle(Theme.foreground).background(Theme.background)
        .sheet(item: $occurrence) { RoutineOccurrenceDetailView(workspace: workspace, occurrence: $0) }
        .alert(deleting ? "删除任务？" : "关闭任务？", isPresented: $confirming) {
            Button("取消", role: .cancel) { confirmation = nil }
            Button(deleting ? "删除任务" : "关闭任务", role: .destructive) { performConfirmedAction() }
        } message: {
            Text(deleting ? "停止后续安排，保留已有结果。" : "停止后续安排，不影响正在执行的任务。")
        }
        .interactiveDismissDisabled(busy)
        #if os(macOS)
        .frame(minWidth: 460, idealWidth: 560, minHeight: 440, idealHeight: 560)
        #endif
    }

    private func performConfirmedAction() {
        guard let target = confirmation, !busy else { return }
        let shouldDelete = deleting
        busy = true; error = nil
        Task {
            defer { busy = false; confirmation = nil }
            do {
                if shouldDelete { try await workspace.deleteRoutine(target); dismiss() }
                else { try await workspace.setRoutineEnabled(target, enabled: false) }
            } catch { self.error = (error as? CoreError)?.message ?? error.localizedDescription }
        }
    }
}

/// A routine's own transcript; polls every 3 s while active and never changes the main conversation.
struct RoutineOccurrenceDetailView: View {
    let workspace: WorkspaceStore
    let occurrence: RoutineOccurrence
    @Environment(\.dismiss) private var dismiss
    @State private var detail: RoutineOccurrenceDetail?
    @State private var error: String?
    @State private var loading = false

    private var currentStatus: String { detail?.status ?? occurrence.displayStatus }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("定时任务").font(.headline)
                Spacer()
                Button(loading ? "加载中…" : "刷新") { Task { await refresh() } }.disabled(loading)
                Button("关闭") { dismiss() }
            }.buttonStyle(RoutineButtonStyle()).padding(20)
            Divider().overlay(Theme.border)
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    let current = detail?.occurrence ?? occurrence
                    let status = detail?.status ?? current.displayStatus
                    VStack(alignment: .leading, spacing: 8) {
                        Text(current.name).font(.title2.weight(.semibold))
                        HStack(spacing: 10) {
                            Label(RoutineCopy.status(status), systemImage: RunPresentation.symbol(status))
                                .font(.subheadline).foregroundStyle(status == "succeeded" ? Theme.success : status == "failed" ? Theme.danger : Theme.muted)
                            if let scheduled = current.scheduledAt {
                                Text(TimeFormat.formatTime(scheduled)).font(.caption).foregroundStyle(Theme.muted)
                            }
                        }
                    }
                    if let detail {
                        result(detail)
                        RunTranscriptView(workspace: workspace, messages: detail.messages.filter { !$0.isFromUser }, streaming: detail.streaming, steps: detail.steps, shownResult: detail.resultSummary)
                    }
                    DisclosureGroup("任务安排") {
                        VStack(alignment: .leading, spacing: 12) {
                            if !current.prompt.isEmpty { Text(current.prompt).textSelection(.enabled) }
                            if let kind = current.taskKind { Text(RoutineCopy.category(kind)).foregroundStyle(Theme.muted) }
                            timestamps(current)
                        }.padding(.top, 12).frame(maxWidth: .infinity, alignment: .leading)
                    }.font(.subheadline).tint(Theme.muted)
                    if let error { Text(error).foregroundStyle(Theme.danger).textSelection(.enabled) }
                    if loading && detail == nil { ProgressView() }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
            }.refreshable { await refresh() }
        }
        .background(Theme.background)
        .task(id: occurrence.id) {
            await refresh()
            while !Task.isCancelled && RoutineCopy.activeStatuses.contains(currentStatus) {
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                await refresh()
            }
        }
        #if os(macOS)
        .frame(minWidth: 500, idealWidth: 600, minHeight: 440, idealHeight: 600)
        #endif
    }

    @ViewBuilder private func result(_ detail: RoutineOccurrenceDetail) -> some View {
        let summary = detail.resultSummary.trimmingCharacters(in: .whitespacesAndNewlines)
        let streaming = detail.streaming.trimmingCharacters(in: .whitespacesAndNewlines)
        let latestAssistant = detail.messages.last(where: { $0.role == "assistant" && !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })?.content.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let rawReason = detail.occurrence.reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let reason = rawReason.isEmpty ? "" : RoutineCopy.skipReason(rawReason)
        let hasResult = !summary.isEmpty || !streaming.isEmpty || !latestAssistant.isEmpty

        VStack(alignment: .leading, spacing: 12) {
            Text(detail.status == "running" ? "最新进展" : "本次结果")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.muted)
            if !summary.isEmpty {
                MarkdownText(source: summary, fontSize: 15)
            } else if !streaming.isEmpty {
                MarkdownText(source: streaming, fontSize: 15, pending: true)
            } else if !latestAssistant.isEmpty {
                MarkdownText(source: latestAssistant, fontSize: 15)
            }
            if !reason.isEmpty && reason != summary {
                Text(reason).foregroundStyle(Theme.muted).textSelection(.enabled)
            }
            if !hasResult && reason.isEmpty {
                let emptyText = (detail.status == "skipped" || detail.status == "cancelled") ? "本次未执行"
                    : RoutineCopy.activeStatuses.contains(detail.status) ? "有新进展会显示在这里" : "暂无结果"
                Text(emptyText).foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(18)
        .background(Theme.wash, in: RoundedRectangle(cornerRadius: 14))
    }

    @ViewBuilder private func timestamps(_ run: RoutineOccurrence) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            if let date = run.scheduledAt { Text("原定时间 · \(TimeFormat.formatTime(date))") }
            if let date = run.startedAt { Text("开始时间 · \(TimeFormat.formatTime(date))") }
            if let date = run.finishedAt { Text("完成时间 · \(TimeFormat.formatTime(date))") }
        }.font(.caption).foregroundStyle(Theme.muted)
    }

    private func refresh() async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do { detail = try await workspace.routineOccurrence(id: occurrence.id) }
        catch { self.error = (error as? CoreError)?.message ?? error.localizedDescription }
    }
}

func workDurationMs(steps: [ToolStep], endedAt: Date?) -> Int? {
    guard let end = endedAt, let start = steps.compactMap(\.createdAt).min() else { return nil }
    let ms = Int((end.timeIntervalSince(start) * 1000).rounded())
    return ms >= 1000 ? ms : nil
}

struct MoreContent<Content: View>: View {
    var durationMs: Int? = nil
    @State private var expanded = false
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.easeOut(duration: 0.16)) { expanded.toggle() } } label: {
                HStack(spacing: 5) {
                    Text(CliTranscript.formatWorkDuration(durationMs) ?? "更多内容")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.muted)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Theme.muted.opacity(0.75))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .padding(.vertical, 2)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(expanded ? "已展开" : "已收起")
            if expanded { content() }
        }
    }
}

/// The execution record of a routine occurrence or background run.
struct RunTranscriptView: View {
    let workspace: WorkspaceStore
    let messages: [AgentMessage]
    let streaming: String
    let steps: [ToolStep]
    var shownResult = ""

    var body: some View {
        let finalID = messages.last(where: { $0.role == "assistant" })?.id
        let visible = messages.filter { $0.id != finalID || $0.content != shownResult || !$0.streamProgress.isEmpty }
        if !visible.isEmpty || !streaming.isEmpty || !steps.isEmpty {
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(visible) { message in
                        VStack(alignment: .leading, spacing: 6) {
                            if let date = message.createdAt { Text(TimeFormat.formatClock(date)).font(.caption).foregroundStyle(Theme.muted) }
                            if !message.streamProgress.isEmpty { MarkdownText(source: message.streamProgress) }
                            if message.id != finalID || message.content != shownResult { MarkdownText(source: message.content) }
                        }
                    }
                    if !streaming.isEmpty { MarkdownText(source: streaming, pending: true) }
                    if !steps.isEmpty {
                        InlineToolStepsList(workspace: workspace, steps: steps)
                    }
                }.padding(.top, 10)
            } label: {
                HStack(spacing: 6) {
                    Text("查看过程")
                    if !steps.isEmpty {
                        Text("\(steps.count) 个步骤").font(.caption).foregroundStyle(Theme.muted)
                    }
                }
            }
            .font(.subheadline).tint(Theme.muted)
        }
    }
}

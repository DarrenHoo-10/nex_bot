import SwiftUI
import NexClientKit

/// Scoped to scheduling controls so other screens retain their existing appearance.
struct RoutineButtonStyle: ButtonStyle {
    var primary = false
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(primary ? Color.white : Theme.identityAccent)
            .padding(.horizontal, 14).frame(minWidth: 44, minHeight: 44)
            .background {
                RoundedRectangle(cornerRadius: 13).fill(primary
                    ? LinearGradient(colors: [Color(hex: 0x328F88), Color(hex: 0x216F6C)], startPoint: .top, endPoint: .bottom)
                    : LinearGradient(colors: [Theme.glassStrong, Theme.secondary.opacity(0.6)], startPoint: .top, endPoint: .bottom))
            }
            .overlay { RoundedRectangle(cornerRadius: 13).strokeBorder(primary ? Color.white.opacity(0.28) : Theme.border, lineWidth: 1) }
            .overlay { RoundedRectangle(cornerRadius: 12).inset(by: 1).strokeBorder(LinearGradient(colors: [.white.opacity(0.45), .clear], startPoint: .top, endPoint: .bottom), lineWidth: 1) }
            .shadow(color: Theme.shadowInk.opacity(configuration.isPressed ? 0.02 : 0.07), radius: 3, y: 2)
            .opacity(enabled ? (configuration.isPressed ? 0.86 : 1) : 0.42)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
            .contentShape(RoundedRectangle(cornerRadius: 13))
    }
}

/// Presentation shared by the two native scheduling surfaces.
enum RoutineCopy {
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
        case "awaiting_approval": "等你确认"
        case "needs_reconciliation": "需要你核对"
        case "failed": "未完成"
        default: ToolLabels.statusText(raw)
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
                    Image(systemName: "chevron.right").foregroundStyle(Theme.identityAccent)
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

/// A routine's own transcript; never changes the main conversation.
struct RoutineOccurrenceDetailView: View {
    let workspace: WorkspaceStore
    let occurrence: RoutineOccurrence
    @Environment(\.dismiss) private var dismiss
    @State private var detail: RoutineOccurrenceDetail?
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("定时任务").font(.headline)
                Spacer()
                Button("刷新") { Task { await refresh() } }.disabled(loading)
                Button("关闭") { dismiss() }
            }.buttonStyle(RoutineButtonStyle()).foregroundStyle(Theme.muted).padding(20)
            Divider().overlay(Theme.border)
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    let current = detail?.occurrence ?? occurrence
                    let status = detail?.status ?? current.displayStatus
                    VStack(alignment: .leading, spacing: 8) {
                        Text(current.name).font(.title2.weight(.semibold))
                        Label(RoutineCopy.status(status), systemImage: RunPresentation.symbol(status))
                            .font(.subheadline).foregroundStyle(status == "succeeded" ? Theme.success : Theme.muted)
                    }
                    if let detail {
                        result(detail)
                        DisclosureGroup("查看过程") {
                            VStack(alignment: .leading, spacing: 18) {
                                ForEach(detail.messages) { message in
                                    VStack(alignment: .leading, spacing: 6) {
                                        if let date = message.createdAt { Text(TimeFormat.formatClock(date)).font(.caption).foregroundStyle(Theme.muted) }
                                        MarkdownText(source: message.content)
                                    }
                                }
                                if !detail.streaming.isEmpty { MarkdownText(source: detail.streaming) }
                                ForEach(detail.steps) { step in RoutineStepDetail(workspace: workspace, step: step) }
                                if detail.messages.isEmpty && detail.streaming.isEmpty && detail.steps.isEmpty {
                                    Text("暂无记录").foregroundStyle(Theme.muted)
                                }
                            }.padding(.top, 12)
                        }.font(.subheadline).tint(Theme.muted)
                    }
                    DisclosureGroup("任务安排") {
                        VStack(alignment: .leading, spacing: 12) {
                            if !current.prompt.isEmpty { Text(current.prompt).textSelection(.enabled) }
                            if let kind = current.taskKind { Text(RoutineCopy.category(kind)).foregroundStyle(Theme.muted) }
                            timestamps(current)
                        }.padding(.top, 12).frame(maxWidth: .infinity, alignment: .leading)
                    }.font(.subheadline).tint(Theme.muted)
                    if let error { Text(error).foregroundStyle(Theme.danger).textSelection(.enabled) }
                    if loading { ProgressView() }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
            }.refreshable { await refresh() }
        }
        .background(Theme.background)
        .task { await refresh() }
        #if os(macOS)
        .frame(minWidth: 500, idealWidth: 600, minHeight: 440, idealHeight: 600)
        #endif
    }

    @ViewBuilder private func result(_ detail: RoutineOccurrenceDetail) -> some View {
        let summary = detail.resultSummary.trimmingCharacters(in: .whitespacesAndNewlines)
        let reason = detail.occurrence.reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        VStack(alignment: .leading, spacing: 12) {
            if !summary.isEmpty { MarkdownText(source: summary, fontSize: 16) }
            else if !reason.isEmpty { Text(reason).textSelection(.enabled) }
            else { Text(detail.status == "succeeded" ? "已完成" : "还没有结果").foregroundStyle(Theme.muted) }
            if detail.status != "succeeded", !reason.isEmpty, !summary.isEmpty, reason != summary {
                Text(reason).foregroundStyle(Theme.muted).textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(18)
        .background(Theme.wash, in: RoundedRectangle(cornerRadius: 14))
    }

    @ViewBuilder private func timestamps(_ run: RoutineOccurrence) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            if let date = run.scheduledAt { Text("安排时间 · \(TimeFormat.formatTime(date))") }
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

private struct RoutineStepDetail: View {
    let workspace: WorkspaceStore
    let step: ToolStep
    @State private var expanded = false
    @State private var preview: PreviewItem?
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 8) {
                if !step.summary.isEmpty && step.summary != step.toolName { Text(step.summary).textSelection(.enabled) }
                if let preview {
                    Text(preview.content).textSelection(.enabled)
                    if let arguments = preview.arguments, !arguments.isEmpty {
                        DisclosureGroup("参数") { Text(arguments).font(.caption.monospaced()).textSelection(.enabled).padding(.top, 6) }
                    }
                } else if !step.preview.isEmpty { Text(step.preview).textSelection(.enabled) }
                if loading { ProgressView() }
                if let error { Text(error).foregroundStyle(Theme.danger).textSelection(.enabled) }
                Button("刷新") { Task { await load() } }.buttonStyle(RoutineButtonStyle()).disabled(loading)
            }.padding(.vertical, 8)
        } label: {
            HStack {
                Text(step.label)
                Spacer()
                Text(RoutineCopy.status(step.status)).font(.caption).foregroundStyle(Theme.muted)
            }
        }
        .onChange(of: expanded) { _, open in if open && preview == nil { Task { await load() } } }
    }

    private func load() async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do { preview = try await workspace.previewTool(callID: step.id) }
        catch { self.error = (error as? CoreError)?.message ?? error.localizedDescription }
    }
}

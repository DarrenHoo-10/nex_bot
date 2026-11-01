import SwiftUI
import NexClientKit

/// 已交给后台：the main chat handed work to a background job. Opens the job's details.
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
/// the actions the stage allows. Actions appear only on the job's latest report; 回复 sets the composer's reply target.
struct JobReportCard<Media: View>: View {
    let message: AgentMessage
    let workspace: WorkspaceStore
    let open: () -> Void
    let reply: (Job) -> Void
    @ViewBuilder var media: () -> Media
    @State private var busy = false
    @State private var error: String?
    @State private var revising = false
    @State private var feedback = ""

    private var job: Job? { message.jobID.flatMap { workspace.state?.job($0) } }
    private var latest: Bool { job?.latestReport?.messageID == message.id }
    private var tint: Color {
        switch message.jobState {
        case "blocked", "failed": Theme.danger
        case "question": Theme.identityAccent
        default: Theme.border
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Button(action: open) {
                    Text(job?.title ?? message.jobTitle).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Theme.foreground).lineLimit(1)
                }.buttonStyle(.plain).accessibilityHint("查看执行详情")
                if let job {
                    Text(job.stageText).font(.system(size: 11)).foregroundStyle(stageInk(job.stage))
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(stageInk(job.stage).opacity(0.12), in: Capsule())
                }
            }
            media()
            let body = AttachmentLink.stripped(message.jobReportBody).trimmingCharacters(in: .whitespacesAndNewlines)
            if !body.isEmpty { MarkdownText(source: body) }
            if latest, let job { actions(job) }
            if let error { Text(error).font(.caption).foregroundStyle(Theme.danger).textSelection(.enabled) }
        }
        .padding(.horizontal, 15).padding(.vertical, 12)
        .frame(maxWidth: 560, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(tint.opacity(message.jobState == "ready" || message.jobState == "dropped" ? 1 : 0.45)))
        .alert("继续修改", isPresented: $revising) {
            TextField("告诉 AI 要调整什么", text: $feedback)
            Button("取消", role: .cancel) { feedback = "" }
            Button("提交") { if let job { run { try await workspace.reviseJob(job, feedback: feedback.trimmingCharacters(in: .whitespacesAndNewlines)) }; feedback = "" } }
                .disabled(feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    @ViewBuilder private func actions(_ job: Job) -> some View {
        HStack(spacing: 8) {
            if job.stage == "question" { Button("回复") { reply(job) }.buttonStyle(RoutineButtonStyle(primary: true)) }
            if job.stage == "review", job.todoID != nil {
                Button("验收") { run { try await workspace.acceptJob(job) } }.buttonStyle(RoutineButtonStyle(primary: true))
                Button("修改") { revising = true }.buttonStyle(RoutineButtonStyle())
            }
            if job.isStoppable { Button("停止") { run { try await workspace.stopJob(job.id) } }.buttonStyle(RoutineButtonStyle()) }
            if busy { ProgressView().controlSize(.small) }
        }
        .disabled(busy)
    }

    private func stageInk(_ stage: String) -> Color {
        switch stage {
        case "blocked", "failed": Theme.danger
        case "done", "dropped", "stopped": Theme.muted
        default: Theme.identityAccent
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        busy = true; error = nil
        Task {
            defer { busy = false }
            do { try await action() } catch { self.error = (error as? CoreError)?.message ?? error.localizedDescription }
        }
    }
}

/// A background job's execution over all its rounds: the latest report first, then each round's report, the collapsed
/// record and the brief. Polls while the job is still open.
struct JobDetailView: View {
    let workspace: WorkspaceStore
    let jobID: String
    @Environment(\.dismiss) private var dismiss
    @State private var detail: JobDetail?
    @State private var error: String?
    @State private var loading = false

    private var job: Job? { detail?.job ?? workspace.state?.job(jobID) }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("后台任务").font(.headline)
                Spacer()
                Button("刷新") { Task { await refresh() } }.disabled(loading)
                Button("关闭") { dismiss() }
            }.buttonStyle(RoutineButtonStyle()).foregroundStyle(Theme.muted).padding(20)
            Divider().overlay(Theme.border)
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if let job {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(job.title).font(.title2.weight(.semibold))
                            Text(job.stageText).font(.subheadline).foregroundStyle(job.stage == "done" ? Theme.success : Theme.muted)
                        }
                        latest(job)
                    }
                    if let detail {
                        if detail.reports.count > 1 {
                            DisclosureGroup("各轮回报") {
                                VStack(alignment: .leading, spacing: 14) {
                                    ForEach(detail.reports) { report in
                                        VStack(alignment: .leading, spacing: 4) {
                                            if let at = report.createdAt { Text(TimeFormat.formatTime(at)).font(.caption).foregroundStyle(Theme.muted) }
                                            MarkdownText(source: report.summary)
                                        }
                                    }
                                }.padding(.top, 12)
                            }.font(.subheadline).tint(Theme.muted)
                        }
                        RunTranscriptView(workspace: workspace, messages: detail.messages.filter { !$0.isFromUser }, streaming: detail.streaming, steps: detail.steps)
                        if let brief = detail.messages.first(where: \.isFromUser) {
                            DisclosureGroup("任务书") { Text(brief.content).textSelection(.enabled).padding(.top, 12).frame(maxWidth: .infinity, alignment: .leading) }
                                .font(.subheadline).tint(Theme.muted)
                        }
                    }
                    if let error { Text(error).foregroundStyle(Theme.danger).textSelection(.enabled) }
                    if loading { ProgressView() }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
            }.refreshable { await refresh() }
        }
        .background(Theme.background)
        .task {
            await refresh()
            while !Task.isCancelled, detail?.job.isOpen ?? true {
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                await refresh()
            }
        }
        #if os(macOS)
        .frame(minWidth: 500, idealWidth: 600, minHeight: 440, idealHeight: 600)
        #endif
    }

    @ViewBuilder private func latest(_ job: Job) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let report = job.latestReport {
                if !report.summary.isEmpty { MarkdownText(source: report.summary) }
                if let question = report.question { Text(question).font(.subheadline.weight(.semibold)).textSelection(.enabled) }
            } else if let streaming = detail?.streaming, !streaming.isEmpty {
                MarkdownText(source: streaming)
            } else if let progress = job.progress {
                Text(progress)
            } else {
                Text("有新进展会显示在这里").foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(18)
        .background(Theme.wash, in: RoundedRectangle(cornerRadius: 14))
    }

    private func refresh() async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do { detail = try await workspace.jobDetail(id: jobID) }
        catch { self.error = (error as? CoreError)?.message ?? error.localizedDescription }
    }
}

/// Opens a job's details as a sheet by id.
struct JobSheetItem: Identifiable, Hashable { let id: String }

/// One entry of 最近结果: a routine run or a finished background job.
enum RecentRun: Identifiable {
    case occurrence(RoutineOccurrence)
    case job(Job)
    var id: String { switch self { case .occurrence(let o): "occurrence-\(o.id)"; case .job(let j): "job-\(j.id)" } }
    var at: Date? { switch self { case .occurrence(let o): o.scheduledAt; case .job(let j): j.createdAt } }
}

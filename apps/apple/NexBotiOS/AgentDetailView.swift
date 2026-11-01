import SwiftUI
import NexClientKit

/// The agent's 助手详情 screen: header plus 工作 / 设置 tabs (`Navigation.detailTab`).
struct AgentDetailView: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(Navigation.self) private var nav
    @Environment(ContactPreferences.self) private var preferences
    @State private var sheet: Sheet?
    @State private var errorText: String?
    @State private var busyTask: String?
    @State private var confirmStopAll = false

    enum Sheet: Identifiable {
        case avatar, routine(Routine), occurrence(RoutineOccurrence), job(String)
        var id: String {
            switch self {
            case .occurrence(let o): "occurrence-\(o.id)"
            case .avatar: "avatar"
            case .routine(let r): "routine-\(r.id)"
            case .job(let id): "job-\(id)"
            }
        }
    }

    private var bot: Bot? { workspace.bot(botID) }
    private var tasks: [AgentTask] { workspace.state?.unfinishedTasks(botID: botID) ?? [] }
    private var openJobs: [Job] { workspace.state?.openJobs(botID: botID) ?? [] }
    /// Routine runs and finished background jobs, newest first.
    private var recent: [RecentRun] {
        let runs = (workspace.state?.occurrences(botID: botID) ?? []).map { RecentRun.occurrence($0) }
        let jobs = (workspace.state?.jobs(botID: botID) ?? []).filter { !$0.isOpen }.map { RecentRun.job($0) }
        return Array((runs + jobs).sorted { ($0.at ?? .distantPast) > ($1.at ?? .distantPast) }.prefix(10))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                PillTabs(items: AgentDetailTab.allCases, title: { $0.rawValue }, selection: Bindable(nav).detailTab)
                switch nav.detailTab {
                case .work: work
                case .settings: AgentSettingsTab(workspace: workspace, botID: botID)
                }
            }
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background { WorkspaceSurface(kind: .stage) }
        .navigationTitle("助手详情")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .toolbarBackground(.ultraThinMaterial, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .refreshable { await workspace.refresh() }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .occurrence(let o): RoutineOccurrenceDetailView(workspace: workspace, occurrence: o)
            case .avatar: AvatarPickerSheet(workspace: workspace, botID: botID)
            case .routine(let routine): RoutinePlanDetailView(workspace: workspace, routine: routine)
            case .job(let id): JobDetailView(workspace: workspace, jobID: id)
            }
        }
        .errorAlert($errorText)
        .debugCommand { command, _ in
            switch command {
            case "avatarpicker": sheet = .avatar
            case "pin": preferences.togglePin(botID)
            case "workstop": if let t = tasks.first { Task { await run(t.id) { try await workspace.cancelTask(t.id) } } }
            case "resume": if let t = tasks.first(where: { $0.status == "paused" }) { Task { await run(t.id) { try await workspace.resumeTask(t.id) } } }
            default: break
            }
        }
    }

    // MARK: Header

    private var state: CompanionState { workspace.companionState(of: botID) }

    /// 在线, the current task phrase, or the label of the avatar state.
    private var heroState: String {
        if workspace.connection == .resyncing { return CompanionState.offline.label }
        if let first = tasks.first { return first.phrase }
        return state == .idle ? "在线" : state.label
    }

    private var heroDot: Color {
        switch state {
        case .approval, .offline, .paused: Theme.approval
        case .failed: Theme.danger
        default: Theme.success
        }
    }

    /// A large avatar with a soft halo, the name and the status; the pin sits in the corner.
    private var header: some View {
        VStack(spacing: 4) {
            if let bot {
                Button { sheet = .avatar } label: {
                    HeroHalo(accent: workspace.appearance(of: bot).accent) { workspace.avatar(of: bot, size: 96, animated: true) }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("更换 \(bot.name) 的头像")
            }
            Text(bot?.name ?? "").font(.system(size: 20, weight: .semibold)).tracking(-0.3).lineLimit(2).multilineTextAlignment(.center)
            HStack(spacing: 6) {
                Circle().fill(heroDot).frame(width: 7, height: 7).overlay(Circle().stroke(heroDot.opacity(0.2), lineWidth: 3))
                Text(heroState).font(.footnote).foregroundStyle(Theme.muted).lineLimit(1)
            }
            .accessibilityElement(children: .combine)
        }
        .frame(maxWidth: .infinity)
        .overlay(alignment: .topTrailing) {
            let pinned = preferences.isPinned(botID)
            Button { preferences.togglePin(botID) } label: {
                Image(systemName: pinned ? "pin.fill" : "pin").font(.system(size: 14, weight: .medium))
                    .foregroundStyle(pinned ? Theme.background : Theme.foreground)
                    .frame(width: 36, height: 36)
                    .background { Circle().fill(pinned ? Theme.foreground : .clear) }
                    .glass(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(pinned ? "取消置顶" : "置顶联系人")
        }
    }

    // MARK: 工作

    private func title(_ text: String, trailing: (icon: String, label: String, action: () -> Void)? = nil) -> some View {
        HStack {
            Text(text).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted)
            Spacer()
            if let trailing {
                Button(action: trailing.action) { Image(systemName: trailing.icon).font(.system(size: 15, weight: .medium)).frame(width: 32, height: 28) }
                    .buttonStyle(.plain).foregroundStyle(Theme.foreground).accessibilityLabel(trailing.label)
            }
        }
        .padding(.horizontal, 2).padding(.top, 8)
    }

    @ViewBuilder private var work: some View {
        let state = workspace.state
        if let preview = PreviewCenter.shared.items[botID] {
            PreviewCard(item: preview) { PreviewCenter.shared.items[botID] = nil }
        }

        VStack(alignment: .leading, spacing: 0) {
            if !tasks.isEmpty {
                title("正在处理")
                ForEach(tasks) { task in
                    RunEntryRow(symbol: "arrow.triangle.2.circlepath", tone: .live, title: task.objective.isEmpty ? "Agent 工作" : task.objective,
                                status: task.phrase, time: task.createdAt.map { TimeFormat.formatClock($0) }) {
                        HStack(spacing: 8) {
                            if task.status == "paused" {
                                Button("继续") { Task { await run(task.id) { try await workspace.resumeTask(task.id) } } }
                                    .buttonStyle(PillButtonStyle(primary: true))
                            }
                            Button("停止") { Task { await run(task.id) { try await workspace.cancelTask(task.id) } } }
                                .buttonStyle(PillButtonStyle())
                                .disabled(task.status == "cancelling")
                            if busyTask == task.id { ProgressView() }
                        }
                        .disabled(busyTask == task.id)
                        .padding(.top, 6)
                    }
                }
            }

            if !openJobs.isEmpty {
                title("后台任务")
                ForEach(openJobs) { job in
                    RunEntryRow(symbol: job.isBusy ? "arrow.triangle.2.circlepath" : "exclamationmark.circle", tone: job.isBusy ? .live : .warn, title: job.title,
                                status: [job.stageText, job.isBusy ? job.progress : nil].compactMap { $0 }.joined(separator: " · "), time: job.createdAt.map { TimeFormat.formatClock($0) }) {
                        HStack(spacing: 8) {
                            Button("详情") { sheet = .job(job.id) }.buttonStyle(PillButtonStyle())
                            Button("停止") { Task { await run(job.id) { try await workspace.stopJob(job.id) } } }.buttonStyle(PillButtonStyle())
                            if busyTask == job.id { ProgressView() }
                        }
                        .disabled(busyTask == job.id)
                        .padding(.top, 6)
                    }
                }
                Button("停止全部") { confirmStopAll = true }
                    .font(.footnote).foregroundStyle(Theme.danger).padding(.vertical, 6)
                    .confirmationDialog("停止全部工作？", isPresented: $confirmStopAll, titleVisibility: .visible) {
                        Button("停止全部", role: .destructive) { Task { await run(botID) { try await workspace.stopAll(botID: botID) } } }
                    } message: { Text("停止主对话和所有后台任务。") }
            }

            let runs = recent
            if !runs.isEmpty {
                title("最近结果")
                ForEach(Array(runs.enumerated()), id: \.element.id) { index, entry in
                    let day = entry.at.map { TimeFormat.dayLabel($0) } ?? ""
                    if !day.isEmpty, index == 0 || day != runs[index - 1].at.map({ TimeFormat.dayLabel($0) }) {
                        DayLabel(text: day)
                    }
                    switch entry {
                    case .occurrence(let o):
                        Button { sheet = .occurrence(o) } label: {
                            RunEntryRow(symbol: RunPresentation.symbol(o.displayStatus), tone: RunPresentation.tone(o.displayStatus), title: o.name,
                                        status: RoutineCopy.status(o.displayStatus), time: o.scheduledAt.map { TimeFormat.formatClock($0) })
                        }.buttonStyle(.plain).accessibilityHint("查看结果")
                    case .job(let job):
                        let good = job.stage == "done" || job.stage == "dropped"
                        Button { sheet = .job(job.id) } label: {
                            RunEntryRow(symbol: good ? "checkmark" : "exclamationmark.circle", tone: good ? .success : .warn, title: job.title,
                                        status: job.stageText, time: job.createdAt.map { TimeFormat.formatClock($0) })
                        }.buttonStyle(.plain).accessibilityHint("查看结果")
                    }
                }
            }

            let routines = state?.routines(botID: botID) ?? []
            if routines.isEmpty {
                title("定时任务")
                HStack {
                    Text("暂无定时任务").font(.footnote).foregroundStyle(Theme.muted)
                    Spacer()
                }
                .padding(.leading, 14).padding(.trailing, 10).padding(.vertical, 10)
                .background(Theme.wash, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            } else {
                title("定时任务")
                VStack(spacing: 0) {
                    ForEach(Array(routines.enumerated()), id: \.element.id) { index, routine in
                        if index > 0 { Divider().overlay(Theme.border).padding(.leading, 14) }
                        routineRow(routine)
                    }
                }
                .background(Theme.wash, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .accessibilityLabel("定时任务列表")
            }
        }
    }

    private func routineRow(_ routine: Routine) -> some View {
        let latest = workspace.state?.occurrences.first { $0.routineID == routine.id }
        return RoutineListEntry(routine: routine, latest: latest,
            showPlan: { sheet = .routine(routine) },
            showResult: { if let latest { sheet = .occurrence(latest) } })
    }

    // MARK: Actions

    private func run(_ id: String, _ action: () async throws -> Void) async {
        busyTask = id
        defer { busyTask = nil }
        do { try await action() } catch { errorText = message(of: error) }
    }

    private func section<C: View>(_ title: String, trailing: (icon: String, label: String, action: () -> Void)? = nil, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: title, trailing: trailing)
            content()
        }
    }
}

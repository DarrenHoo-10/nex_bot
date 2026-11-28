import SwiftUI
import NexClientKit

// Multi-agent collaboration ("协作") views: Lead overview panel, Worker back-to-lead banner,
// structured collaboration cards in transcripts, and Settings › 协作 preferences.
// Mirrors `TeamPanel.tsx`, `SessionPane.tsx` (worker banner), `TeamMessageCard.tsx`, and `TeamSettings.tsx`.

// MARK: - Lead Team Panel

struct AgentTeamPanel: View {
    let runs: [CliTeamRunView]
    let selectedKey: CliSessionKey
    let onOpenSession: (CliSessionKey) -> Void
    let onPause: (String) async throws -> Void
    let onResume: (String) async throws -> Void
    let onCancel: (String) async throws -> Void
    let onStopWorker: (String, String) async throws -> Void

    @State private var busyKey: String?
    @State private var confirmCancel = false
    @State private var historyExpanded = false
    @State private var error = ""

    private var activeRun: CliTeamRunView? { runs.first { $0.status.isLive } }
    private var activeWorkers: [CliTeamWorkerView] { activeRun?.visibleWorkers ?? [] }
    private var historyRuns: [(run: CliTeamRunView, workers: [CliTeamWorkerView])] {
        runs
            .filter { $0.id != activeRun?.id }
            .map { ($0, $0.visibleWorkers) }
            .filter { !$0.1.isEmpty }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let run = activeRun {
                    activeSection(run)
                } else {
                    HStack(spacing: 6) {
                        Text("历史协作").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.nexAgentInk)
                        Spacer()
                        Text("共 \(historyRuns.count) 次").font(.caption).foregroundStyle(Theme.nexAgentMuted)
                    }
                }

                if !historyRuns.isEmpty {
                    if activeRun != nil {
                        VStack(alignment: .leading, spacing: 8) {
                            Button { withAnimation(.easeOut(duration: 0.16)) { historyExpanded.toggle() } } label: {
                                HStack(spacing: 6) {
                                    Text("历史协作").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.nexAgentInk)
                                    Text("\(historyRuns.count) 次").font(.caption).foregroundStyle(Theme.nexAgentMuted)
                                    Spacer()
                                    Image(systemName: historyExpanded ? "chevron.down" : "chevron.right")
                                        .font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.nexAgentMuted)
                                }
                                .padding(.vertical, 4).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            if historyExpanded {
                                historyList
                            }
                        }
                        .padding(.top, 4)
                    } else {
                        historyList
                    }
                }
            }
            .padding(14)
        }
        .background(Theme.nexAgentSurface)
    }

    @ViewBuilder
    private func activeSection(_ run: CliTeamRunView) -> some View {
        HStack(spacing: 8) {
            Text(run.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.nexAgentInk).lineLimit(1)
            Spacer(minLength: 4)
            teamStatusPill(run.status.label, tone: run.status == .paused ? .paused : .running)
        }

        if let limitHit = run.limitHit, !limitHit.isEmpty {
            alertRow(limitHit)
        }
        if let held = run.heldCount, held > 0 {
            alertRow("\(held) 条协作消息待投递")
        }
        if !error.isEmpty {
            Text(error).font(.caption).foregroundStyle(Theme.danger)
        }

        VStack(spacing: 6) {
            ForEach(activeWorkers) { worker in
                workerRow(worker, runId: run.id, allowStop: true)
            }
        }

        Divider().overlay(Theme.nexAgentBorder)

        HStack(spacing: 8) {
            if confirmCancel {
                Text("结束当前协作？").font(.caption.weight(.medium)).foregroundStyle(Theme.nexAgentInk)
                Spacer()
                Button("取消") { confirmCancel = false }
                    .buttonStyle(.bordered).controlSize(.small).disabled(busyKey != nil)
                Button(busyKey == "cancel:\(run.id)" ? "结束中…" : "确认结束") {
                    runAction("cancel:\(run.id)") { try await onCancel(run.id) }
                }
                .buttonStyle(.borderedProminent).tint(Theme.danger).controlSize(.small).disabled(busyKey != nil)
            } else {
                if run.status == .paused {
                    Button {
                        runAction("resume:\(run.id)") { try await onResume(run.id) }
                    } label: {
                        Label(busyKey == "resume:\(run.id)" ? "恢复中…" : "恢复协作", systemImage: "play.fill")
                            .font(.system(size: 12, weight: .medium))
                    }
                    .buttonStyle(.bordered).controlSize(.small).disabled(busyKey != nil)
                } else {
                    Button {
                        runAction("pause:\(run.id)") { try await onPause(run.id) }
                    } label: {
                        Label(busyKey == "pause:\(run.id)" ? "暂停中…" : "暂停协作", systemImage: "pause.fill")
                            .font(.system(size: 12, weight: .medium))
                    }
                    .buttonStyle(.bordered).controlSize(.small).disabled(busyKey != nil)
                }
                Spacer()
                Button(role: .destructive) { confirmCancel = true } label: {
                    Label("结束协作", systemImage: "xmark.circle").font(.system(size: 12, weight: .medium))
                }
                .buttonStyle(.bordered).tint(Theme.danger).controlSize(.small).disabled(busyKey != nil)
            }
        }
    }

    private var historyList: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(historyRuns, id: \.run.id) { entry in
                let run = entry.run
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Text(run.title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.nexAgentInk).lineLimit(1)
                        Spacer(minLength: 4)
                        teamStatusPill(run.status.label, tone: run.status == .finished ? .reported : .stopped)
                    }
                    if let summary = run.summary, !summary.isEmpty {
                        Text(summary).font(.caption).foregroundStyle(Theme.nexAgentMuted).lineLimit(3)
                    }
                    VStack(spacing: 5) {
                        ForEach(entry.workers) { worker in
                            workerRow(worker, runId: run.id, allowStop: false)
                        }
                    }
                }
                .padding(10)
                .background(Theme.nexAgentInset, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.nexAgentBorder))
            }
        }
    }

    private func workerRow(_ worker: CliTeamWorkerView, runId: String, allowStop: Bool) -> some View {
        let tone = workerTone(worker.status)
        let active = worker.sessionKey == selectedKey
        let canStop = allowStop && worker.status.isLive
        let stopping = busyKey == "stop:\(runId):\(worker.name)"
        let permLabel = CliPermissions.label(engine: worker.engine, mode: worker.permissions)
        let ctxPct: String? = worker.context.flatMap { c in
            guard let w = c.window, w > 0 else { return nil }
            return "\(min(100, Int((Double(c.used) / Double(w) * 100).rounded())))%"
        }
        return HStack(spacing: 8) {
            Button {
                if let key = worker.sessionKey { onOpenSession(key) }
            } label: {
                HStack(spacing: 9) {
                    AgentEngineIcon(engine: worker.engine, tone: cliTone(for: worker.status), size: 22)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(worker.title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.nexAgentInk).lineLimit(1)
                            Spacer(minLength: 4)
                            teamStatusPill(worker.status.label, tone: tone)
                        }
                        HStack(spacing: 4) {
                            if let role = worker.role, !role.isEmpty {
                                Text(role)
                                Text("·")
                            }
                            Text(permLabel).foregroundStyle(worker.permissions == .readonly ? Theme.nexAgentAccent : Theme.nexAgentMuted)
                            Text("·")
                            Text(worker.name).font(.system(size: 11, design: .monospaced))
                            if let findings = worker.findingsCount, findings > 0 {
                                Text("·")
                                Text("\(findings) 个问题").foregroundStyle(Theme.approval)
                            }
                            if let ctxPct {
                                Text("·")
                                Text(ctxPct).monospacedDigit()
                            }
                        }
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.nexAgentMuted)
                        .lineLimit(1)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(worker.sessionKey == nil)

            if canStop {
                Button {
                    runAction("stop:\(runId):\(worker.name)") { try await onStopWorker(runId, worker.name) }
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.danger)
                        .frame(width: 24, height: 24)
                        .background(Theme.danger.opacity(0.1), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(busyKey != nil)
                .help(stopping ? "停止中…" : "停止工人")
                .accessibilityLabel("停止 \(worker.title)")
            } else {
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.nexAgentMuted.opacity(0.6))
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(active ? Theme.nexAgentSoft : Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(active ? Theme.nexAgentAccent.opacity(0.45) : Theme.nexAgentBorder))
    }

    private func alertRow(_ text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 12)).foregroundStyle(Theme.approval)
            Text(text).font(.caption).foregroundStyle(Theme.nexAgentInk)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(Theme.approvalSoft, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func runAction(_ key: String, _ work: @escaping @MainActor () async throws -> Void) {
        busyKey = key; error = ""
        Task {
            do {
                try await work()
                confirmCancel = false
            } catch {
                self.error = CliErrorText.text(for: error, fallback: "操作失败")
            }
            busyKey = nil
        }
    }
}

// MARK: - Worker Back-to-Lead Banner

struct AgentTeamWorkerBanner: View {
    let binding: CliTeamWorkerBinding
    let leadTitle: String
    let session: CliSession
    let pendingCount: Int
    let onOpenLead: (CliSessionKey) -> Void

    private var statusTone: TeamStatusTone {
        if pendingCount > 0 || session.state == .waiting || binding.worker.status == .waiting { return .waiting }
        if session.online && (session.state == .running || binding.worker.status == .starting) { return .running }
        if binding.worker.status == .failed { return .failed }
        if binding.worker.status == .reported { return .reported }
        return .stopped
    }

    private var statusLabel: String {
        switch statusTone {
        case .waiting: "等你处理"
        case .running: "工作中"
        default: binding.worker.status.label
        }
    }

    var body: some View {
        HStack(spacing: 8) {
            Button { onOpenLead(binding.run.leadKey) } label: {
                HStack(spacing: 5) {
                    Image(systemName: "network").font(.system(size: 11.5)).foregroundStyle(Theme.nexAgentAccent)
                    Text("协作 · 来自").font(.system(size: 12)).foregroundStyle(Theme.nexAgentMuted)
                    Text(leadTitle.isEmpty ? binding.run.title : leadTitle)
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.nexAgentInk).lineLimit(1)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("返回主会话")

            Spacer(minLength: 6)

            HStack(spacing: 5) {
                if let role = binding.worker.role, !role.isEmpty {
                    Text(role).font(.system(size: 11.5)).foregroundStyle(Theme.nexAgentMuted)
                    Text("·").font(.system(size: 11)).foregroundStyle(Theme.nexAgentMuted)
                }
                Text(CliPermissions.label(engine: binding.worker.engine, mode: binding.worker.permissions))
                    .font(.system(size: 11.5))
                    .foregroundStyle(binding.worker.permissions == .readonly ? Theme.nexAgentAccent : Theme.nexAgentMuted)
                Text("·").font(.system(size: 11)).foregroundStyle(Theme.nexAgentMuted)
                Text(binding.worker.name).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.nexAgentMuted).lineLimit(1)
                teamStatusPill(statusLabel, tone: statusTone)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 7)
        .background(Theme.nexAgentInset)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.nexAgentBorder).frame(height: 1) }
    }
}

// MARK: - Collaboration Transcript Card

struct AgentTeamMessageCard: View {
    let card: CliTeamCard
    var onSelectSession: ((CliSessionKey) -> Void)? = nil
    @Environment(\.colorScheme) private var scheme

    private static let maxBriefFiles = 4

    private var accentColor: Color {
        if card.outcome == "failed" { return Theme.danger }
        switch card.kind {
        case .task: return Theme.brand
        case .report, .done: return Theme.nexAgentAccent
        case .review: return Color(hex: 0x7C3AED)
        case .followup: return Color(hex: 0x0284C7)
        case .question, .nudge: return Theme.approval
        case .answer: return Theme.nexAgentAccent
        case .escalation: return Theme.danger
        }
    }

    private var symbol: String {
        if card.outcome == "failed" { return "xmark.circle.fill" }
        switch card.kind {
        case .task: return "paperplane.fill"
        case .report, .done: return "checkmark.circle.fill"
        case .review: return "checklist"
        case .followup: return "wrench.and.screwdriver.fill"
        case .question: return "questionmark.circle.fill"
        case .answer: return "arrowshape.turn.up.left.fill"
        case .nudge: return "bell.fill"
        case .escalation: return "exclamationmark.triangle.fill"
        }
    }

    private func severityStyle(_ severity: String) -> (fg: Color, bg: Color) {
        let dark = scheme == .dark
        switch severity.lowercased() {
        case "p0", "p1", "critical", "high":
            return (Color(hex: dark ? 0xF38A84 : 0xB8322B), Color(hex: 0xC93B34).opacity(dark ? 0.22 : 0.11))
        case "p2", "medium":
            return (Color(hex: dark ? 0xF2BE63 : 0xA66208), Color(hex: 0xD68A12).opacity(dark ? 0.22 : 0.13))
        case "clean":
            return (Color(hex: dark ? 0x74D9AD : 0x1C6B49), Color(hex: 0x2C8F68).opacity(dark ? 0.22 : 0.12))
        default:
            return (Color(hex: dark ? 0x8CB9F7 : 0x2F5C8F), Color(hex: 0x3B82F6).opacity(dark ? 0.20 : 0.11))
        }
    }

    private func severityPill(_ text: String, severity: String) -> some View {
        let style = severityStyle(severity)
        return HStack(spacing: 5) {
            Circle().fill(style.fg).frame(width: 6, height: 6)
            Text(text).font(.system(size: 11.5, weight: .semibold)).monospacedDigit()
        }
        .foregroundStyle(style.fg)
        .padding(.horizontal, 8).frame(height: 22)
        .background(style.bg, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    var body: some View {
        let badge = card.outcome == "failed" ? "失败" : card.kind.badge
        let isBriefing = card.kind == .report || card.kind == .review
        let displayText = isBriefing ? (card.brief ?? card.body) : card.body
        let findingCounts = card.findingCounts
        let totalFindings = findingCounts.reduce(0) { $0 + $1.count }
        let showReviewStrip = card.kind == .review && (!findingCounts.isEmpty || card.outcome != "failed")
        let visibleFiles = Array(card.files.prefix(Self.maxBriefFiles))
        let hiddenFiles = max(0, card.files.count - visibleFiles.count)
        let hasContent = (displayText?.isEmpty == false) || showReviewStrip || !visibleFiles.isEmpty
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                if let engine = card.actorEngine {
                    AgentEngineIcon(engine: engine, tone: .idle, size: 18)
                } else {
                    Image(systemName: symbol).font(.system(size: 12.5)).foregroundStyle(accentColor).frame(width: 18, height: 18)
                }
                Text(badge)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(accentColor)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(accentColor.opacity(0.13), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                HStack(spacing: 4) {
                    Text(card.heading).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.nexAgentInk).lineLimit(1)
                    if let sub = card.subtitle, !sub.isEmpty {
                        Text("· \(sub)").font(.system(size: 12)).foregroundStyle(Theme.nexAgentMuted).lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                if let outcome = card.outcome {
                    teamStatusPill(outcome == "failed" ? "失败" : "已完成", tone: outcome == "failed" ? .failed : .reported)
                }
                if let jumpKey = card.jumpKey, let onSelectSession {
                    Button { onSelectSession(jumpKey) } label: {
                        HStack(spacing: 2) {
                            Text("查看").font(.system(size: 11.5, weight: .medium))
                            Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
                        }
                        .foregroundStyle(Theme.nexAgentAccent)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 9)

            if hasContent {
                Divider().overlay(Theme.nexAgentBorder)
                VStack(alignment: .leading, spacing: 8) {
                    if showReviewStrip {
                        OutlineFlow(spacing: 6) {
                            if !findingCounts.isEmpty {
                                Text("发现 \(totalFindings) 个问题")
                                    .font(.system(size: 12.5, weight: .semibold))
                                    .foregroundStyle(Theme.nexAgentInk)
                                    .frame(height: 22)
                                ForEach(findingCounts) { entry in
                                    let isP = entry.label.range(of: #"^P\d$"#, options: [.regularExpression, .caseInsensitive]) != nil
                                    let text = isP ? "\(entry.count) 个 \(entry.label)" : "\(entry.count) 个\(entry.label)优先级"
                                    severityPill(text, severity: entry.severity)
                                }
                            } else {
                                severityPill("未发现问题", severity: "clean")
                            }
                        }
                        .accessibilityLabel("审查问题简报")
                    }
                    if let text = displayText, !text.isEmpty {
                        MarkdownText(source: text, fontSize: 13.5)
                    }
                    if !visibleFiles.isEmpty {
                        OutlineFlow(spacing: 6) {
                            ForEach(visibleFiles, id: \.self) { file in
                                HStack(spacing: 4) {
                                    Image(systemName: "doc.text").font(.system(size: 10.5))
                                    Text(file).font(.system(size: 11.5, design: .monospaced)).lineLimit(1)
                                }
                                .foregroundStyle(Theme.nexAgentMuted)
                                .padding(.horizontal, 8).padding(.vertical, 3)
                                .background(Theme.nexAgentInset, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Theme.nexAgentBorder))
                            }
                            if hiddenFiles > 0 {
                                Text("+\(hiddenFiles) 个文件")
                                    .font(.system(size: 11.5, design: .monospaced))
                                    .foregroundStyle(Theme.nexAgentMuted)
                                    .padding(.horizontal, 8).padding(.vertical, 3)
                                    .background(Theme.nexAgentInset, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                                    .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Theme.nexAgentBorder))
                            }
                        }
                    }
                }
                .padding(12)
            }
        }
        .background(Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(accentColor.opacity(0.32), lineWidth: 1))
        .overlay(alignment: .leading) {
            UnevenRoundedRectangle(topLeadingRadius: 12, bottomLeadingRadius: 12, bottomTrailingRadius: 0, topTrailingRadius: 0)
                .fill(accentColor)
                .frame(width: 3)
        }
    }
}

// MARK: - Settings › 协作

struct AgentTeamSettingsView: View {
    let workspace: WorkspaceStore
    var active = true
    @State private var settings = CliTeamSettings.defaults
    @State private var loaded = false
    @State private var saving = false
    @State private var saved = false
    @State private var error = ""

    private let workerCounts = Array(1...10)
    private let supportedEngines: [CliEngine] = [.claude, .codex, .agy]

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            #if os(macOS)
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("协作").font(.system(size: 20, weight: .bold))
                    Spacer()
                    if saved {
                        Label("已保存", systemImage: "checkmark").font(.caption.weight(.medium)).foregroundStyle(Theme.success)
                    } else if !loaded {
                        Text("加载中…").font(.caption).foregroundStyle(Theme.muted)
                    }
                }
                Divider().overlay(Theme.border).padding(.top, 10)
            }
            #else
            HStack {
                Text("派活方式").font(.subheadline.weight(.semibold))
                Spacer()
                if saved {
                    Label("已保存", systemImage: "checkmark").font(.caption.weight(.medium)).foregroundStyle(Theme.success)
                } else if !loaded {
                    Text("加载中…").font(.caption).foregroundStyle(Theme.muted)
                }
            }
            #endif

            // Section 1: Dispatch mode + max workers + allowNexInAsk
            VStack(alignment: .leading, spacing: 14) {
                #if os(macOS)
                Text("派活方式").font(.system(size: 13.5, weight: .semibold))
                #endif

                VStack(spacing: 8) {
                    ForEach(CliTeamDispatchMode.allCases, id: \.self) { mode in
                        let on = settings.dispatchMode == mode
                        Button {
                            update(CliTeamSettingsPatch(dispatchMode: mode))
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: on ? "largecircle.fill.circle" : "circle")
                                    .font(.system(size: 15))
                                    .foregroundStyle(on ? Theme.brand : Theme.muted)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(mode.label).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.foreground)
                                    Text(mode.hint).font(.caption).foregroundStyle(Theme.muted)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 10)
                            .background(on ? Theme.brandSoft : Theme.secondary.opacity(0.45), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(on ? Theme.brand : Theme.border))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(saving)
                    }
                }

                Divider().overlay(Theme.border)

                HStack {
                    Text("单个主会话工人上限").font(.system(size: 13, weight: .medium))
                    Spacer()
                    Picker("单个主会话工人上限", selection: Binding(
                        get: { settings.maxWorkers },
                        set: { update(CliTeamSettingsPatch(maxWorkers: $0)) }
                    )) {
                        ForEach(workerCounts, id: \.self) { n in
                            Text("\(n) 个工人").tag(n)
                        }
                    }
                    .labelsHidden()
                    .disabled(saving)
                }

                Divider().overlay(Theme.border)

                Toggle(isOn: Binding(
                    get: { settings.allowNexInAsk },
                    set: { update(CliTeamSettingsPatch(allowNexInAsk: $0)) }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("询问模式下默认放行 nex 命令").font(.system(size: 13, weight: .medium))
                        Text("仅放行单条 nex 命令，不含管道、重定向或拼接语句。").font(.caption).foregroundStyle(Theme.muted)
                    }
                }
                .tint(Theme.brand)
                .disabled(saving)
            }
            .padding(16)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border))

            // Section 2: Available Agents
            VStack(alignment: .leading, spacing: 12) {
                Text("可用 Agent").font(.system(size: 13.5, weight: .semibold))
                VStack(spacing: 0) {
                    ForEach(Array(supportedEngines.enumerated()), id: \.element) { idx, engine in
                        let installed = settings.installedEngines.contains(engine)
                        let enabled = settings.enabledEngines.contains(engine)
                        HStack(spacing: 10) {
                            AgentEngineIcon(engine: engine, tone: installed ? .idle : .offline, size: 22)
                            Text(agentName(engine)).font(.system(size: 13, weight: .semibold))
                            Text(installed ? "已安装" : "未检测到")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(installed ? Theme.success : Theme.muted)
                                .padding(.horizontal, 7).padding(.vertical, 2)
                                .background(installed ? Theme.successSoft : Theme.wash, in: Capsule())
                            Spacer()
                            Toggle("", isOn: Binding(
                                get: { enabled },
                                set: { next in
                                    var list = settings.enabledEngines
                                    if next { if !list.contains(engine) { list.append(engine) } }
                                    else { list.removeAll { $0 == engine } }
                                    update(CliTeamSettingsPatch(enabledEngines: list))
                                }
                            ))
                            .labelsHidden()
                            .tint(Theme.brand)
                            .disabled(saving || !installed)
                        }
                        .padding(.vertical, 10)
                        if idx < supportedEngines.count - 1 { Divider().overlay(Theme.border) }
                    }
                }
            }
            .padding(16)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border))

            // Section 3: Safety Limits
            VStack(alignment: .leading, spacing: 10) {
                Text("安全上限").font(.system(size: 13.5, weight: .semibold))
                factRow("派活层级", "单层（工人不能再派活，可使用自身子代理）")
                Divider().overlay(Theme.border)
                factRow("协作消息上限", "每小时 \(settings.limits.mailPerHour) 条")
                Divider().overlay(Theme.border)
                factRow("空闲自动暂停", "\(settings.limits.idlePauseHours) 小时")
                Divider().overlay(Theme.border)
                factRow("启动失败熔断", "同一任务连续失败 \(settings.limits.circuitBreakerFailures) 次")
            }
            .padding(16)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border))

            if !error.isEmpty {
                Text(error).font(.caption).foregroundStyle(Theme.danger)
            }
        }
        .task(id: active) {
            guard active else { return }
            await load()
        }
    }

    private func factRow(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.system(size: 12.5)).foregroundStyle(Theme.muted)
            Spacer(minLength: 12)
            Text(value).font(.system(size: 12.5)).foregroundStyle(Theme.foreground).multilineTextAlignment(.trailing)
        }
    }

    private func load() async {
        do {
            settings = try await workspace.client.cliTeamSettings()
            error = ""
        } catch {
            // Older Cores without /api/cli-agents/team-settings keep defaults silently.
        }
        loaded = true
    }

    private func update(_ patch: CliTeamSettingsPatch) {
        if let m = patch.dispatchMode { settings.dispatchMode = m }
        if let w = patch.maxWorkers { settings.maxWorkers = w }
        if let a = patch.allowNexInAsk { settings.allowNexInAsk = a }
        if let e = patch.enabledEngines { settings.enabledEngines = e }
        saving = true; saved = false; error = ""
        Task {
            defer { saving = false }
            do {
                settings = try await workspace.client.cliSaveTeamSettings(patch)
                saved = true
            } catch {
                self.error = CliErrorText.text(for: error, fallback: "保存失败")
            }
        }
    }
}

// MARK: - Helpers

enum TeamStatusTone { case running, waiting, reported, paused, failed, stopped }

private func workerTone(_ status: CliTeamWorkerStatus) -> TeamStatusTone {
    switch status {
    case .starting, .running: .running
    case .waiting: .waiting
    case .reported: .reported
    case .failed: .failed
    case .stopped: .stopped
    }
}

private func cliTone(for status: CliTeamWorkerStatus) -> CliTone {
    switch status {
    case .starting, .running: .running
    case .waiting: .waiting
    case .reported: .idle
    case .stopped, .failed: .stopped
    }
}

func teamStatusPill(_ label: String, tone: TeamStatusTone) -> some View {
    let fg: Color = switch tone {
    case .running, .reported: Theme.nexAgentAccent
    case .waiting, .paused: Theme.approval
    case .failed: Theme.danger
    case .stopped: Theme.nexAgentMuted
    }
    return Text(label)
        .font(.system(size: 10.5, weight: .semibold))
        .foregroundStyle(fg)
        .padding(.horizontal, 7).padding(.vertical, 2)
        .background(fg.opacity(0.14), in: Capsule())
}

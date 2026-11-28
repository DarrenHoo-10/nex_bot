import SwiftUI
import NexClientKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

extension CliTone {
    var color: Color {
        switch self {
        case .running: Theme.nexAgentAccent
        case .waiting: Theme.approval
        case .idle: Theme.nexAgentAccent
        case .stopped, .offline: Theme.offline
        }
    }
}

/// A short status label in the colour of its tone.
struct CliChip: View {
    let text: String
    let tone: CliTone
    var customColor: Color? = nil

    var body: some View {
        let fg = customColor ?? tone.color
        Text(text).font(.system(size: 11, weight: .medium)).foregroundStyle(fg)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(fg.opacity(0.14), in: Capsule())
    }
}

/// "NexAgent": the coding-agent workbench of the person's computers.
/// On macOS the session list lives directly in the left sidebar (`ContactsList`) so this view renders the right-hand
/// opaque Emerald-Teal Studio stage; on iOS it renders the list and pushes sessions or the new-session composer.
struct AgentSessionsView: View {
    let model: CliAgentsModel
    let workspace: WorkspaceStore
    /// After 交给助手: show the assistant's conversation.
    let openAssistant: (String) -> Void
    @Environment(\.scenePhase) private var scenePhase
    @State private var errorText = ""
    #if os(macOS)
    @Binding var composing: AgentNewTarget?
    init(model: CliAgentsModel, workspace: WorkspaceStore, composing: Binding<AgentNewTarget?>, openAssistant: @escaping (String) -> Void) {
        self.model = model
        self.workspace = workspace
        self._composing = composing
        self.openAssistant = openAssistant
    }
    #else
    /// the new-session page, while it is open
    @State private var composing: AgentNewTarget?
    @State private var pushed: CliSessionKey?
    init(model: CliAgentsModel, workspace: WorkspaceStore, openAssistant: @escaping (String) -> Void) {
        self.model = model
        self.workspace = workspace
        self.openAssistant = openAssistant
    }
    #endif

    var body: some View {
        layout
            .task { model.start() }
            #if os(macOS)
            // Leaving the section ends the live link unless notifications keep it open.
            .onDisappear { if !model.notificationsOn { model.stop() } }
            #endif
            .onChange(of: scenePhase) { _, phase in sceneChanged(phase) }
    }

    private func sceneChanged(_ phase: ScenePhase) {
        if phase == .active { model.reconnect(); return }
        // Pushing a session also hides this view on the iPhone, so the link closes when the app leaves the screen instead.
        #if os(iOS)
        if phase == .background, !model.notificationsOn { model.stop() }
        #endif
    }

    private var linkText: String {
        switch model.link {
        case .connecting: "正在连接"
        case .reconnecting: "正在重新连接"
        case .closed: "连接已断开"
        case .idle, .open: ""
        }
    }

    private var banner: some View {
        let text = !errorText.isEmpty ? errorText : (model.loadError ?? "")
        return Group {
            if !text.isEmpty || !linkText.isEmpty {
                HStack(spacing: 8) {
                    if !linkText.isEmpty {
                        ProgressView().controlSize(.small)
                        Text(linkText).font(.caption).foregroundStyle(Theme.nexAgentMuted)
                    }
                    if !text.isEmpty {
                        Text(text).font(.caption).foregroundStyle(Theme.danger)
                        Button("重新加载") { errorText = ""; Task { await model.refresh() } }
                            .font(.caption.weight(.medium)).buttonStyle(.plain).foregroundStyle(Theme.nexAgentAccent)
                    }
                    Spacer()
                }
                .padding(.horizontal, 16).padding(.vertical, 6)
                .background(Theme.nexAgentInset)
                .overlay(alignment: .bottom) { Rectangle().fill(Theme.nexAgentBorder).frame(height: 1) }
            }
        }
    }

    private func list(onSelect: @escaping (CliSessionKey) -> Void) -> some View {
        AgentSessionList(
            model: model,
            selected: composing == nil ? model.selectedKey : nil,
            onSelect: { key in composing = nil; onSelect(key) },
            onCreate: { composing = AgentNewTarget(deviceId: model.selected?.deviceId, cwd: model.selected?.cwd) },
            onNew: { composing = AgentNewTarget(deviceId: $0, cwd: $1) }
        )
    }

    #if os(macOS)
    private var layout: some View {
        VStack(spacing: 0) {
            banner
            Group {
                if let target = composing {
                    AgentNewSessionPage(model: model, target: target) { _ in composing = nil }.id(target.id)
                } else if let launch = model.selectedLaunch {
                    AgentLaunchDetail(model: model, launch: launch).id(launch.id)
                } else if let key = model.selectedKey, model.selected != nil {
                    AgentSessionDetail(
                        model: model,
                        workspace: workspace,
                        key: key,
                        openAssistant: openAssistant
                    ) { model.select($0) }
                        .id(key)
                } else {
                    VStack(spacing: 12) {
                        BrandMark(size: 40, agent: true)
                        Text("NexAgent").font(.system(size: 18, weight: .bold)).foregroundStyle(Theme.nexAgentInk)
                        Text("选择一个会话或新建会话").font(.system(size: 13.5)).foregroundStyle(Theme.nexAgentMuted)
                        Button {
                            composing = AgentNewTarget(deviceId: model.devices.first(where: \.online)?.id ?? model.devices.first?.id, cwd: nil)
                        } label: {
                            Label("新建会话", systemImage: "plus")
                                .font(.system(size: 13, weight: .semibold))
                                .padding(.horizontal, 16).padding(.vertical, 8)
                                .background(Theme.nexAgentSolid, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .foregroundStyle(.white)
                        }
                        .buttonStyle(.plain)
                        .disabled(model.devices.isEmpty)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Theme.nexAgentCanvas)
    }
    #else
    private var layout: some View {
        VStack(spacing: 0) {
            banner
            list { key in model.select(key); pushed = key }
        }
        .background { WorkspaceSurface(kind: .nexAgent) }
        .navigationDestination(item: $pushed) { key in
            Group {
                if let launch = model.launches.first(where: { $0.key == key }) {
                    AgentLaunchDetail(model: model, launch: launch).id(launch.id)
                } else {
                    AgentSessionDetail(model: model, workspace: workspace, key: key, openAssistant: openAssistant) { next in
                        guard pushed == key else { return }
                        model.select(next); pushed = next
                    }
                    .id(key)
                }
            }
            .background { WorkspaceSurface(kind: .nexAgent) }
            .toolbar(.visible, for: .navigationBar)
        }
        .navigationDestination(item: $composing) { target in
            AgentNewSessionPage(model: model, target: target) { key in
                composing = nil
                DispatchQueue.main.async { pushed = key }
            }
            .background { WorkspaceSurface(kind: .nexAgent) }
            .toolbar(.visible, for: .navigationBar)
        }
        .onAppear {
            if let pending = model.pendingNavigationKey {
                model.pendingNavigationKey = nil
                pushed = pending
            }
        }
        .onChange(of: model.pendingNavigationKey) { _, pending in
            if let pending {
                model.pendingNavigationKey = nil
                pushed = pending
            }
        }
        .onChange(of: model.selectedKey) { previous, next in
            if CliLaunches.isLaunchKey(previous), pushed == previous { pushed = next }
        }
    }
    #endif
}

/// A new-session button, toolbar (timeline toggle + notification bell + full-text search), what is running pinned on top,
/// then computers (only when there are several), draggable projects, 7-day history folding, and team worker trees.
struct AgentSessionList: View {
    let model: CliAgentsModel
    let selected: CliSessionKey?
    let onSelect: (CliSessionKey) -> Void
    let onCreate: () -> Void
    let onNew: (String, String?) -> Void

    @AppStorage("nexagent.activeFolded") private var activeFolded = false
    @AppStorage("nexagent.timeSort") private var byTime = false
    @AppStorage("nexagent.projectOrder") private var projectOrderJSON = "{}"

    @State private var searchOpen = false
    @State private var filter = ""
    @State private var contentHits: [CliSessionKey: String] = [:]
    @State private var searchError = ""
    @State private var closedNodes: Set<String> = []
    @State private var earlierOpen: Set<String> = []
    @State private var teamHistoryOpen: Set<CliSessionKey> = []
    @State private var draggingProject: String?
    @State private var dropTarget: (id: String, after: Bool)?
    @State private var archivedMode = false
    @State private var renaming: (session: CliSession, id: String?, version: Int?)?
    @State private var renameText = ""
    @State private var confirmingArchive: CliSession?
    @State private var confirmingDelete: (session: CliSession, id: String?, version: Int?)?
    @State private var showingID: CliSession?
    @State private var pendingFork: (parentKey: CliSessionKey, title: String)?
    @State private var pendingForkRequestId: [CliSessionKey: String] = [:]
    @State private var actionBusy = false
    @State private var actionError = ""
    #if os(macOS)
    @State private var hoveredSession: CliSessionKey?
    @State private var hoveredFolder: String?
    #endif
    @FocusState private var searchFocused: Bool

    private static let recentMs = 7 * 24 * 3600 * 1000
    private static let foldMin = 2

    private var query: String { filter.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var projectOrder: [String: [String]] {
        guard let data = projectOrderJSON.data(using: .utf8),
              let map = try? JSONDecoder().decode([String: [String]].self, from: data) else { return [:] }
        return map
    }

    private func saveOrder(_ next: [String: [String]]) {
        guard let data = try? JSONEncoder().encode(next), let json = String(data: data, encoding: .utf8) else { return }
        projectOrderJSON = json
    }

    private func rememberVisibleProjects(_ groups: [CliDeviceGroup]) {
        guard !archivedMode else { return }
        var map = projectOrder
        var changed = false
        for group in groups {
            let current = map[group.device.id] ?? []
            let nonScratch = group.folders.filter { !$0.scratch }
            let remembered = CliSessions.rememberProjects(nonScratch, saved: current)
            if remembered != current {
                map[group.device.id] = remembered
                changed = true
            }
        }
        if changed { saveOrder(map) }
    }

    private func moveProject(deviceId: String, folders: [CliFolderGroup], moving: String, target: String, after: Bool) {
        guard moving != target else { return }
        var map = projectOrder
        let nonScratch = folders.filter { !$0.scratch }
        let current = CliSessions.rememberProjects(nonScratch, saved: map[deviceId] ?? [])
        map[deviceId] = CliSessions.moveProject(current, moving: moving, target: target, after: after)
        saveOrder(map)
    }

    private func matches(_ session: CliSession, folderLabel: String = "", root: String = "") -> Bool {
        guard !query.isEmpty else { return true }
        if contentHits[session.key] != nil { return true }
        let binding = model.teamIndex.workerBySession[session.key]
        let hay = [
            model.displayTitle(for: session),
            folderLabel,
            root,
            session.cwd,
            agentName(session.engine),
            session.gitBranch ?? "",
            binding?.worker.role ?? "",
            binding?.worker.name ?? "",
            binding?.run.title ?? "",
        ].joined(separator: " ")
        return CliSessions.matchesTerms(hay, query: query)
    }

    private func isFailedWorker(_ session: CliSession) -> Bool {
        guard let binding = model.teamIndex.workerBySession[session.key] else { return false }
        return !binding.worker.isVisible
    }

    private func listed(_ sessions: [CliSession]) -> [CliSession] {
        sessions.filter { !model.isDeleted($0) && !model.isSideSession($0) && !isFailedWorker($0) && model.isArchived($0) == archivedMode }
    }

    private func isClosed(_ id: String) -> Bool {
        query.isEmpty && closedNodes.contains(id)
    }

    private func toggleNode(_ id: String) {
        if closedNodes.contains(id) { closedNodes.remove(id) } else { closedNodes.insert(id) }
    }

    private func copyToPasteboard(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }

    private func canFork(_ session: CliSession) -> (allowed: Bool, reason: String?) {
        if model.isTeamWorker(session) { return (false, "协作工人会话暂不支持分支") }
        if let blocker = CliSessions.deviceBlocker(model.device(session.deviceId), engine: session.engine) {
            return (false, blocker)
        }
        let meta = model.workbenchMeta
        if let parent = model.parentKey(of: session), meta[parent]?.parent != nil {
            return (false, "已达两级分支上限")
        }
        guard let forkEngines = model.device(session.deviceId)?.cliAgents?.forkEngines else {
            return (false, "电脑端版本过旧，升级后可分叉会话")
        }
        guard forkEngines.contains(session.engine) else {
            return (false, "该运行工具暂不支持分支")
        }
        return (true, nil)
    }

    private enum TreeEntry: Identifiable {
        case session(CliSession, depth: Int, hasChildren: Bool, historyStyle: Bool)
        case pendingFork(parentKey: CliSessionKey, title: String, depth: Int)
        case teamHistoryToggle(leadKey: CliSessionKey, count: Int, expanded: Bool, depth: Int)
        case teamHistoryHeader(runId: String, title: String, status: String, depth: Int)

        var id: String {
            switch self {
            case .session(let s, _, _, _): "s:\(s.key)"
            case .pendingFork(let p, _, _): "fork:\(p)"
            case .teamHistoryToggle(let l, _, _, _): "th-toggle:\(l)"
            case .teamHistoryHeader(let r, _, _, _): "th-head:\(r)"
            }
        }
    }

    /// Re-groups a device's sessions so team workers always sit in their lead's project folder.
    private func projectFoldersForDevice(_ group: CliDeviceGroup) -> [CliFolderGroup] {
        let all = listed(group.folders.flatMap(\.sessions))
        let byKey = Dictionary(all.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        var folders: [String: CliFolderGroup] = [:]
        var folderOrder: [String] = []
        for s in all.sorted(by: { $0.lastActivityAt > $1.lastActivityAt }) {
            let anchor: CliSession
            if model.isTeamWorker(s), let leadKey = model.parentKey(of: s), let lead = byKey[leadKey] {
                anchor = lead
            } else {
                anchor = s
            }
            let explicit = anchor.repoRoot?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let candidate = explicit.isEmpty ? anchor.cwd : explicit
            let scratch = CliSessions.isScratchCwd(candidate)
            let root = scratch ? "" : (explicit.isEmpty ? CliSessions.worktreeRoot(anchor.cwd) : CliSessions.stripLongPath(explicit))
            let label = scratch ? CliSessions.scratchLabel : CliSessions.folderLabel(root)
            let name = scratch ? CliSessions.scratchKey : label.lowercased()
            if folders[name] == nil {
                folders[name] = CliFolderGroup(cwd: root, label: label, sessions: [], scratch: scratch)
                folderOrder.append(name)
            }
            if !scratch, folders[name]?.roots.contains(root) == false { folders[name]?.roots.append(root) }
            folders[name]?.sessions.append(s)
        }
        let sorted = folderOrder.compactMap { folders[$0] }.sorted {
            if $0.scratch != $1.scratch { return !$0.scratch }
            return ($0.sessions.first?.lastActivityAt ?? 0) > ($1.sessions.first?.lastActivityAt ?? 0)
        }
        return CliSessions.orderProjects(sorted, saved: projectOrder[group.device.id] ?? [])
    }

    private func workerLiveNow(_ s: CliSession, binding: CliTeamWorkerBinding?, pending: [CliSessionKey: Int]) -> Bool {
        let asked = pending[s.key] ?? 0
        let shown = CliSessions.asked(s, pending: asked)
        return asked > 0 || (shown.online && (shown.state == .running || shown.state == .waiting)) || binding?.worker.status == .waiting
    }

    private func isRecentOrLive(_ s: CliSession, pending: [CliSessionKey: Int], nowMs: Int) -> Bool {
        let shown = CliSessions.asked(s, pending: pending[s.key] ?? 0)
        return s.key == selected
            || (shown.online && (shown.state == .running || shown.state == .waiting))
            || (nowMs - s.lastActivityAt) <= Self.recentMs
    }

    /// Builds the visible hierarchical tree for a folder, folding >7d history (`更早 N`) and historical team runs (`历史协作 N`).
    private func buildFolderTree(
        allEntries: [CliSession],
        folderNodeId: String,
        folderLabel: String,
        root: String,
        pending: [CliSessionKey: Int]
    ) -> (rows: [TreeEntry], totalVisible: Int, olderCount: Int) {
        let allKeys = Set(allEntries.map(\.key))
        var fullParentOf: [CliSessionKey: CliSessionKey] = [:]
        for s in allEntries {
            if let p = model.parentKey(of: s), p != s.key, allKeys.contains(p) {
                fullParentOf[s.key] = p
            }
        }
        // Break any cycles
        for s in allEntries {
            var seen: Set<CliSessionKey> = [s.key]
            var cur = fullParentOf[s.key]
            while let p = cur {
                if p == s.key { fullParentOf[s.key] = nil; break }
                if !seen.insert(p).inserted { break }
                cur = fullParentOf[p]
            }
        }

        let visible: [CliSession]
        if query.isEmpty {
            visible = allEntries
        } else {
            let hits = allEntries.filter { matches($0, folderLabel: folderLabel, root: root) }
            var matched = Set(hits.map(\.key))
            for hit in hits {
                var cur = fullParentOf[hit.key]
                var steps = 0
                while let p = cur, !matched.contains(p), steps < 32 {
                    matched.insert(p)
                    cur = fullParentOf[p]
                    steps += 1
                }
            }
            visible = allEntries.filter { matched.contains($0.key) }
        }
        guard !visible.isEmpty else { return ([], 0, 0) }

        // 7-day history folding (when not searching or viewing archive)
        var olderCount = 0
        let shownSessions: [CliSession]
        if query.isEmpty && !archivedMode {
            let nowMs = model.now
            var keep = Set<CliSessionKey>()
            for s in visible where isRecentOrLive(s, pending: pending, nowMs: nowMs) {
                var cur: CliSessionKey? = s.key
                while let k = cur, !keep.contains(k) {
                    keep.insert(k)
                    cur = fullParentOf[k]
                }
            }
            let folded = visible.count - keep.count
            if folded >= Self.foldMin {
                olderCount = folded
                shownSessions = earlierOpen.contains(folderNodeId) ? visible : visible.filter { keep.contains($0.key) }
            } else {
                shownSessions = visible
            }
        } else {
            shownSessions = visible
        }

        let keys = Set(shownSessions.map(\.key))
        var childrenOf: [CliSessionKey: [CliSession]] = [:]
        var roots: [CliSession] = []
        for s in shownSessions {
            if let p = fullParentOf[s.key], keys.contains(p) {
                childrenOf[p, default: []].append(s)
            } else {
                roots.append(s)
            }
        }

        var out: [TreeEntry] = []
        var reachable = Set<CliSessionKey>()

        func markSubtreeReachable(_ key: CliSessionKey) {
            for kid in childrenOf[key] ?? [] where !reachable.contains(kid.key) {
                reachable.insert(kid.key)
                markSubtreeReachable(kid.key)
            }
        }

        func visit(_ list: [CliSession], parent: CliSessionKey?, depth: Int) {
            var primary: [CliSession] = []
            var historical: [(session: CliSession, binding: CliTeamWorkerBinding)] = []
            for s in list {
                let binding = model.teamIndex.workerBySession[s.key]
                if parent != nil, let binding, !binding.inPrimaryGroup, query.isEmpty, !archivedMode,
                   s.key != selected, !workerLiveNow(s, binding: binding, pending: pending) {
                    historical.append((s, binding))
                } else {
                    primary.append(s)
                }
            }
            primary.sort { $0.lastActivityAt > $1.lastActivityAt }

            for s in primary where !reachable.contains(s.key) {
                reachable.insert(s.key)
                let kids = childrenOf[s.key] ?? []
                let creatingChild = pendingFork?.parentKey == s.key
                let hasKids = !kids.isEmpty || creatingChild
                let binding = model.teamIndex.workerBySession[s.key]
                let historyStyle = parent != nil && binding != nil && binding?.isActiveRun == false
                out.append(.session(s, depth: depth, hasChildren: hasKids, historyStyle: historyStyle))
                if hasKids {
                    if depth < 24 && !isClosed("branch:\(s.key)") {
                        if let pf = pendingFork, pf.parentKey == s.key {
                            out.append(.pendingFork(parentKey: s.key, title: pf.title, depth: depth + 1))
                        }
                        if !kids.isEmpty { visit(kids, parent: s.key, depth: depth + 1) }
                    } else {
                        markSubtreeReachable(s.key)
                    }
                }
            }

            if let parent, !historical.isEmpty {
                let expanded = teamHistoryOpen.contains(parent)
                out.append(.teamHistoryToggle(leadKey: parent, count: historical.count, expanded: expanded, depth: depth))
                if expanded {
                    var byRun: [String: (run: CliTeamRunView, items: [CliSession])] = [:]
                    for entry in historical {
                        if byRun[entry.binding.run.id] == nil {
                            byRun[entry.binding.run.id] = (entry.binding.run, [])
                        }
                        byRun[entry.binding.run.id]?.items.append(entry.session)
                    }
                    let sortedRuns = byRun.values.sorted {
                        ($0.run.finishedAt ?? $0.run.updatedAt) > ($1.run.finishedAt ?? $1.run.updatedAt)
                    }
                    for bucket in sortedRuns {
                        out.append(.teamHistoryHeader(runId: bucket.run.id, title: bucket.run.title, status: bucket.run.status.label, depth: depth))
                        for item in bucket.items.sorted(by: { $0.lastActivityAt > $1.lastActivityAt }) where !reachable.contains(item.key) {
                            reachable.insert(item.key)
                            out.append(.session(item, depth: depth, hasChildren: false, historyStyle: true))
                        }
                    }
                } else {
                    for entry in historical { reachable.insert(entry.session.key) }
                }
            }
        }

        visit(roots, parent: nil, depth: 0)
        let cycleNodes = shownSessions.filter { !reachable.contains($0.key) }
        if !cycleNodes.isEmpty { visit(cycleNodes, parent: nil, depth: 0) }
        return (out, visible.count, olderCount)
    }

    var body: some View {
        let groups = model.allGroups
        let pending = model.pendingCounts
        let allListed = groups.flatMap { listed($0.folders.flatMap(\.sessions)) }
        let sessionsByKey = Dictionary(allListed.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })

        // Pinned "进行中": fold normal working workers into their lead row; keep waiting workers pinned.
        let active: [CliSession] = (byTime || archivedMode || !query.isEmpty) ? [] : allListed.filter { s in
            let asked = pending[s.key] ?? 0
            let shown = CliSessions.asked(s, pending: asked)
            if let binding = model.teamIndex.workerBySession[s.key] {
                return asked > 0 || (shown.online && shown.state == .waiting) || binding.worker.status == .waiting
            }
            if shown.online && (shown.state == .running || shown.state == .waiting) { return true }
            if let activeRun = model.teamIndex.activeRunByLead[s.key], activeRun.status.isLive {
                let counts = model.teamIndex.activeWorkingWorkers(for: s.key, sessionsByKey: sessionsByKey, pending: pending)
                return counts.working > 0 || activeRun.status == .paused
            }
            return false
        }.sorted { $0.lastActivityAt > $1.lastActivityAt }

        let single = groups.count == 1 && groups.first?.device.online == true
        let flat: [CliSession] = byTime
            ? allListed
                .filter { matches($0, folderLabel: CliSessions.projectLabel($0), root: $0.repoRoot ?? $0.cwd) }
                .sorted { $0.lastActivityAt > $1.lastActivityAt }
            : []
        let archivedCount = model.displaySessions.filter { !model.isDeleted($0) && !model.isSideSession($0) && !isFailedWorker($0) && model.isArchived($0) }.count
        let projectSignature = groups.map { "\($0.device.id):\($0.folders.map(\.id).joined(separator: ","))" }

        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if !archivedMode {
                    Button(action: onCreate) {
                        Label("新建会话", systemImage: "plus").font(.system(size: 13, weight: .semibold))
                            .frame(maxWidth: .infinity).frame(height: 36)
                            .background(Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.nexAgentBorderStrong))
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.nexAgentInk)
                    .disabled(model.devices.isEmpty)
                }

                // Toolbar: title + timeline toggle + notification bell + search toggle
                HStack(spacing: 4) {
                    Text(archivedMode ? "已归档" : byTime ? "按时间" : "会话目录")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(Theme.nexAgentMuted)
                    Spacer()
                    toolbarIcon("clock", label: byTime ? "恢复项目目录" : "按时间排序", active: byTime) {
                        byTime.toggle()
                    }
                    toolbarIcon(model.notificationsOn ? "bell.fill" : "bell.slash", label: model.notificationsOn ? "关闭通知" : "开启通知", active: model.notificationsOn) {
                        Task {
                            if model.notificationsOn { model.setNotifications(false) }
                            else { model.setNotifications(await AgentNotifier.requestAuthorization()) }
                        }
                    }
                    toolbarIcon("magnifyingglass", label: "搜索会话", active: searchOpen) {
                        if searchOpen { searchOpen = false; filter = "" }
                        else { searchOpen = true; searchFocused = true }
                    }
                }
                .padding(.horizontal, 4)

                if searchOpen {
                    HStack(spacing: 6) {
                        Image(systemName: "magnifyingglass").font(.system(size: 11.5)).foregroundStyle(Theme.nexAgentMuted)
                        searchFieldInput
                        if !filter.isEmpty {
                            Button { filter = ""; searchFocused = true } label: {
                                Image(systemName: "xmark.circle.fill").font(.system(size: 12)).foregroundStyle(Theme.nexAgentMuted)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("清除搜索")
                        }
                    }
                    .padding(.horizontal, 9).frame(height: 32)
                    .background(Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(searchFocused ? Theme.nexAgentAccent : Theme.nexAgentBorder, lineWidth: searchFocused ? 1.5 : 1))
                }

                if !searchError.isEmpty {
                    Text(searchError).font(.caption2).foregroundStyle(Theme.nexAgentMuted).padding(.horizontal, 6)
                }

                if !actionError.isEmpty {
                    HStack(spacing: 6) {
                        Text(actionError).font(.caption).foregroundStyle(Theme.danger)
                        Spacer()
                        Button { actionError = "" } label: { Image(systemName: "xmark").font(.system(size: 10)).foregroundStyle(Theme.nexAgentMuted) }.buttonStyle(.plain)
                    }
                    .padding(.horizontal, 6)
                }

                if !model.loaded {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 24)
                } else if groups.isEmpty {
                    Text("还没有电脑接入").font(.footnote).foregroundStyle(Theme.nexAgentMuted).frame(maxWidth: .infinity).padding(.top, 24)
                }

                if !active.isEmpty { pinned(active, sessionsByKey: sessionsByKey, pending: pending) }

                if byTime {
                    if flat.isEmpty && model.loaded {
                        Text(archivedMode ? "没有已归档的会话" : query.isEmpty ? "暂无会话" : "没有匹配的会话")
                            .font(.caption).foregroundStyle(Theme.nexAgentMuted)
                            .frame(maxWidth: .infinity).padding(.top, 16)
                    } else {
                        ForEach(flat) { session in
                            let binding = model.teamIndex.workerBySession[session.key]
                            let ctx = binding.map { b in b.worker.role.map { "协作 · \($0)" } ?? "协作" } ?? CliSessions.projectLabel(session)
                            row(session, asked: pending[session.key] ?? 0, context: ctx, snippet: contentHits[session.key], depth: 0, hasChildren: false)
                        }
                    }
                } else {
                    ForEach(groups) { group in device(group, pending: pending, single: single) }
                    if archivedMode && archivedCount == 0 {
                        Text("没有已归档的会话")
                            .font(.caption).foregroundStyle(Theme.nexAgentMuted)
                            .frame(maxWidth: .infinity).padding(.top, 16)
                    }
                }

                Button { archivedMode.toggle() } label: {
                    HStack(spacing: 6) {
                        Image(systemName: archivedMode ? "arrow.uturn.backward" : "archivebox").font(.system(size: 12))
                        Text(archivedMode ? "返回会话目录" : archivedCount > 0 ? "已归档 (\(archivedCount))" : "已归档").font(.system(size: 12))
                    }
                    .foregroundStyle(Theme.nexAgentMuted)
                    .padding(.horizontal, 6).padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(10)
        }
        .scrollIndicators(.never)
        .onChange(of: projectSignature, initial: true) { _, _ in
            rememberVisibleProjects(groups)
        }
        .task(id: query) {
            contentHits = [:]
            searchError = ""
            guard !query.isEmpty else { return }
            let bounded = query.utf16.count > 200 ? String(query.prefix(200)) : query
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            do {
                let hits = try await model.searchSessions(bounded)
                guard !Task.isCancelled else { return }
                var map: [CliSessionKey: String] = [:]
                for hit in hits where map[hit.key] == nil { map[hit.key] = hit.snippet }
                contentHits = map
            } catch {
                if !Task.isCancelled { searchError = "正文搜索失败，仅显示标题匹配" }
            }
        }
        .alert("重命名会话", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("会话名称", text: $renameText)
            Button("取消", role: .cancel) { renaming = nil }
            Button("保存") {
                guard let target = renaming else { return }
                let nextTitle = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                renaming = nil
                guard !nextTitle.isEmpty else { return }
                Task {
                    actionBusy = true; defer { actionBusy = false }
                    do { try await model.renameWorkbenchSession(target.session, title: nextTitle, expectedId: target.id, expectedVersion: target.version) }
                    catch { actionError = CliErrorText.text(for: error) }
                }
            }
        }
        .alert("归档会话？", isPresented: Binding(get: { confirmingArchive != nil }, set: { if !$0 { confirmingArchive = nil } }), presenting: confirmingArchive) { target in
            Button("取消", role: .cancel) { confirmingArchive = nil }
            Button("归档会话") {
                confirmingArchive = nil
                Task {
                    actionBusy = true; defer { actionBusy = false }
                    do { try await model.archiveWorkbenchSession(target, archived: true) }
                    catch { actionError = CliErrorText.text(for: error) }
                }
            }
        } message: { target in
            let hasWorkers = !(model.teamIndex.workerKeysByLead[target.key]?.isEmpty ?? true)
            Text(hasWorkers ? "归档后会同步归档其协作工人会话，可在「已归档」中一起恢复。" : "归档后会同步隐藏电脑上的原生会话，可在「已归档」中恢复。")
        }
        .alert("删除会话？", isPresented: Binding(get: { confirmingDelete != nil }, set: { if !$0 { confirmingDelete = nil } })) {
            Button("取消", role: .cancel) { confirmingDelete = nil }
            Button("删除", role: .destructive) {
                guard let target = confirmingDelete else { return }
                confirmingDelete = nil
                Task {
                    actionBusy = true; defer { actionBusy = false }
                    do { try await model.deleteWorkbenchSession(target.session, expectedId: target.id, expectedVersion: target.version) }
                    catch { actionError = CliErrorText.text(for: error) }
                }
            }
        } message: {
            Text("将永久删除「\(confirmingDelete.map { model.displayTitle(for: $0.session) } ?? "")」在电脑上的原生会话记录，无法恢复。")
        }
        .alert("会话 ID", isPresented: Binding(get: { showingID != nil }, set: { if !$0 { showingID = nil } })) {
            Button("复制 ID") {
                if let id = showingID?.nativeId { copyToPasteboard(id) }
                showingID = nil
            }
            Button("关闭", role: .cancel) { showingID = nil }
        } message: {
            Text(showingID?.nativeId ?? "")
        }
    }

    private func toolbarIcon(_ symbol: String, label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 13))
                .foregroundStyle(active ? Theme.nexAgentAccent : Theme.nexAgentMuted)
                .frame(width: 26, height: 26)
                .background(active ? Theme.nexAgentSoft : .clear, in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
    }

    @ViewBuilder private var searchFieldInput: some View {
        let field = TextField("搜索会话标题或内容", text: $filter)
            .textFieldStyle(.plain)
            .font(.system(size: 12.5))
            .focused($searchFocused)
        #if os(macOS)
        field.onExitCommand { searchOpen = false; filter = "" }
        #else
        field
        #endif
    }

    private func pinned(_ active: [CliSession], sessionsByKey: [CliSessionKey: CliSession], pending: [CliSessionKey: Int]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Button { activeFolded.toggle() } label: {
                HStack(spacing: 5) {
                    Image(systemName: activeFolded ? "chevron.right" : "chevron.down").font(.system(size: 9, weight: .semibold))
                    Text("进行中").font(.system(size: 11, weight: .semibold))
                    if activeFolded, active.contains(where: { s in
                        CliSessions.asked(s, pending: pending[s.key] ?? 0).state == .waiting
                            || model.teamIndex.workerBySession[s.key]?.worker.status == .waiting
                    }) {
                        Circle().fill(Theme.approval).frame(width: 6, height: 6).accessibilityLabel("有会话等你处理")
                    }
                    Spacer()
                    Text("\(active.count)").font(.system(size: 11))
                }
                .foregroundStyle(Theme.nexAgentMuted).padding(.horizontal, 6).padding(.vertical, 3).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(activeFolded ? "展开进行中" : "收起进行中")

            if !activeFolded {
                ForEach(active) { session in
                    let binding = model.teamIndex.workerBySession[session.key]
                    let leadSession = binding.flatMap { sessionsByKey[$0.run.leadKey] }
                    let activeRun = model.teamIndex.activeRunByLead[session.key]
                    let counts = model.teamIndex.activeWorkingWorkers(for: session.key, sessionsByKey: sessionsByKey, pending: pending)
                    let teamSummary: (working: Int, paused: Bool)? = activeRun.flatMap { run in
                        run.status.isLive && (counts.working > 0 || run.status == .paused) ? (counts.working, run.status == .paused) : nil
                    }
                    let workerSub: String? = binding.map { b in
                        "协作 · 来自 \(leadSession.map { model.displayTitle(for: $0) } ?? b.run.title)"
                    }
                    let ctx = (binding != nil || teamSummary != nil) ? nil : CliSessions.projectLabel(session)
                    VStack(alignment: .leading, spacing: 1) {
                        row(session, asked: pending[session.key] ?? 0, context: ctx, snippet: nil, depth: 0, hasChildren: false, activeSection: true, teamSummary: teamSummary)
                        if let workerSub {
                            Text(workerSub).font(.system(size: 11)).foregroundStyle(Theme.nexAgentMuted).lineLimit(1).padding(.leading, 44).padding(.bottom, 2)
                        }
                    }
                }
            }
            Divider().overlay(Theme.nexAgentBorder).padding(.top, 4)
        }
    }

    private func device(_ group: CliDeviceGroup, pending: [CliSessionKey: Int], single: Bool) -> some View {
        let deviceNodeId = "dev:\(group.device.id)"
        let orderedFolders = projectFoldersForDevice(group)
        return VStack(alignment: .leading, spacing: 4) {
            if !single {
                HStack(spacing: 6) {
                    Button { toggleNode(deviceNodeId) } label: {
                        Image(systemName: isClosed(deviceNodeId) ? "chevron.right" : "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Theme.nexAgentMuted)
                            .frame(width: 14, height: 14)
                    }
                    .buttonStyle(.plain)
                    Circle().fill(group.device.online ? Theme.success : Theme.offline).frame(width: 7, height: 7)
                    Text(group.device.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.nexAgentInk).lineLimit(1)
                    Text(group.device.online ? "\(group.count)" : "离线").font(.caption).foregroundStyle(Theme.nexAgentMuted)
                    Spacer()
                    if !archivedMode {
                        Button { onNew(group.device.id, nil) } label: { Image(systemName: "plus") }
                            .buttonStyle(.plain).foregroundStyle(Theme.nexAgentMuted)
                            .accessibilityLabel("在 \(group.device.name) 上新建会话")
                    }
                }
            }
            if single || !isClosed(deviceNodeId) {
                ForEach(orderedFolders) { folder in
                    let folderId = folder.id
                    let folderNodeId = "proj:\(group.device.id):\(folderId)"
                    let tree = buildFolderTree(allEntries: folder.sessions, folderNodeId: folderNodeId, folderLabel: folder.label, root: folder.cwd, pending: pending)
                    if !tree.rows.isEmpty {
                        let dragPayload = "\(group.device.id)\n\(folderId)"
                        let movable = !folder.scratch && query.isEmpty && !archivedMode
                        let dropHere = dropTarget?.id == folderNodeId
                        VStack(alignment: .leading, spacing: 2) {
                            if dropHere && dropTarget?.after == false {
                                Rectangle().fill(Theme.nexAgentAccent).frame(height: 2).padding(.horizontal, 4)
                            }
                            folderHeader(group: group, folder: folder, folderNodeId: folderNodeId, count: tree.totalVisible, dragPayload: dragPayload, movable: movable)
                            if dropHere && dropTarget?.after == true {
                                Rectangle().fill(Theme.nexAgentAccent).frame(height: 2).padding(.horizontal, 4)
                            }

                            if !isClosed(folderNodeId) {
                                ForEach(tree.rows) { entry in
                                    switch entry {
                                    case .session(let s, let depth, let hasChildren, let historyStyle):
                                        row(s, asked: pending[s.key] ?? 0, context: nil, snippet: contentHits[s.key], depth: depth, hasChildren: hasChildren, historyStyle: historyStyle)
                                    case .pendingFork(_, let title, let depth):
                                        HStack(spacing: 7) {
                                            Color.clear.frame(width: 16, height: 14)
                                            ProgressView().controlSize(.mini)
                                            Text(title).font(.system(size: 12.5)).foregroundStyle(Theme.nexAgentMuted).lineLimit(1)
                                            Spacer()
                                        }
                                        .padding(.leading, CGFloat(min(depth, 6) * 14) + 6)
                                        .padding(.vertical, 6)
                                    case .teamHistoryToggle(let leadKey, let count, let expanded, let depth):
                                        Button {
                                            if expanded { teamHistoryOpen.remove(leadKey) } else { teamHistoryOpen.insert(leadKey) }
                                        } label: {
                                            HStack(spacing: 5) {
                                                Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .semibold))
                                                Text("历史协作 \(count)").font(.system(size: 11.5, weight: .medium))
                                                Spacer()
                                            }
                                            .foregroundStyle(Theme.nexAgentMuted)
                                            .padding(.leading, CGFloat(min(depth, 6) * 14) + 22)
                                            .padding(.vertical, 4)
                                            .contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain)
                                    case .teamHistoryHeader(_, let title, let status, let depth):
                                        HStack(spacing: 6) {
                                            Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.nexAgentMuted).lineLimit(1)
                                            Spacer()
                                            Text(status).font(.system(size: 10.5)).foregroundStyle(Theme.nexAgentMuted)
                                        }
                                        .padding(.leading, CGFloat(min(depth, 6) * 14) + 24)
                                        .padding(.trailing, 8).padding(.top, 4).padding(.bottom, 1)
                                    }
                                }

                                if tree.olderCount > 0 {
                                    let open = earlierOpen.contains(folderNodeId)
                                    Button {
                                        if open { earlierOpen.remove(folderNodeId) } else { earlierOpen.insert(folderNodeId) }
                                    } label: {
                                        HStack(spacing: 5) {
                                            Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .semibold))
                                            Text("更早 \(tree.olderCount)").font(.system(size: 11.5))
                                            Spacer()
                                        }
                                        .foregroundStyle(Theme.nexAgentMuted)
                                        .padding(.leading, 22).padding(.vertical, 4)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }
            }
            if group.count == 0 && !archivedMode { Text("暂无会话").font(.caption).foregroundStyle(Theme.nexAgentMuted) }
        }
    }

    @ViewBuilder
    private func folderHeader(group: CliDeviceGroup, folder: CliFolderGroup, folderNodeId: String, count: Int, dragPayload: String, movable: Bool) -> some View {
        let header = HStack(spacing: 5) {
            Button { toggleNode(folderNodeId) } label: {
                Image(systemName: isClosed(folderNodeId) ? "chevron.right" : "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Theme.nexAgentMuted)
                    .frame(width: 14, height: 14)
            }
            .buttonStyle(.plain)
            Text(folder.label).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.nexAgentInk).lineLimit(1)
            Spacer()
            if !archivedMode && !folder.scratch && !folder.cwd.isEmpty {
                #if os(macOS)
                let showFolderAdd = hoveredFolder == folderNodeId
                Button { onNew(group.device.id, folder.cwd) } label: {
                    Image(systemName: "plus").font(.system(size: 11.5)).frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(Theme.nexAgentMuted)
                .opacity(showFolderAdd ? 1 : 0)
                .allowsHitTesting(showFolderAdd)
                .help("新建会话")
                .accessibilityLabel("在 \(folder.label) 中新建会话")
                #else
                Button { onNew(group.device.id, folder.cwd) } label: {
                    Image(systemName: "plus").font(.system(size: 12.5)).frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(Theme.nexAgentMuted)
                .help("新建会话")
                .accessibilityLabel("在 \(folder.label) 中新建会话")
                #endif
            }
            Text("\(count)").font(.system(size: 11)).foregroundStyle(Theme.nexAgentMuted)
        }
        .padding(.horizontal, 4).padding(.top, 6).padding(.bottom, 2)
        .contentShape(Rectangle())
        #if os(macOS)
        .onHover { inside in
            if inside { hoveredFolder = folderNodeId }
            else if hoveredFolder == folderNodeId { hoveredFolder = nil }
        }
        #endif
        .opacity(draggingProject == dragPayload ? 0.45 : 1)
        .help(folder.roots.count > 1 ? folder.roots.joined(separator: "\n") : folder.cwd)

        if movable {
            header
                .draggable(dragPayload) {
                    Text(folder.label).font(.system(size: 12, weight: .semibold))
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 8))
                        .onAppear { draggingProject = dragPayload }
                        .onDisappear { if draggingProject == dragPayload { draggingProject = nil } }
                }
                .dropDestination(for: String.self) { items, location in
                    dropTarget = nil
                    draggingProject = nil
                    guard let payload = items.first else { return false }
                    let parts = payload.split(separator: "\n", maxSplits: 1).map(String.init)
                    guard parts.count == 2, parts[0] == group.device.id else { return false }
                    moveProject(deviceId: group.device.id, folders: group.folders, moving: parts[1], target: folder.id, after: location.y > 16)
                    return true
                } isTargeted: { targeted in
                    if targeted { dropTarget = (folderNodeId, true) }
                    else if dropTarget?.id == folderNodeId { dropTarget = nil }
                }
        } else {
            header
        }
    }

    @ViewBuilder
    private func sessionMenuItems(for session: CliSession) -> some View {
        let forkCheck = canFork(session)
        let isWorker = model.isTeamWorker(session)
        let dev = model.device(session.deviceId)
        let manageBlocked = dev.map { !$0.online || !($0.cliAgents?.features.contains("sessionManage") ?? false) } ?? !session.online
        let legacyHiddenOnly = session.hidden && !session.archived && model.workbenchMeta[session.key]?.archived != true
        if archivedMode {
            Button {
                Task {
                    actionBusy = true; defer { actionBusy = false }
                    do { try await model.archiveWorkbenchSession(session, archived: false); archivedMode = false }
                    catch { actionError = CliErrorText.text(for: error) }
                }
            } label: { Label("恢复会话", systemImage: "arrow.uturn.backward") }
            .disabled(manageBlocked && !legacyHiddenOnly)

            Divider()

            Button(role: .destructive) {
                let frozen = model.workbenchMeta[session.key]
                confirmingDelete = (session, frozen?.id, frozen?.version)
            } label: { Label("删除会话", systemImage: "trash") }
            .disabled(manageBlocked)
        } else {
            Button {
                let frozen = model.workbenchMeta[session.key]
                renameText = model.displayTitle(for: session)
                renaming = (session, frozen?.id, frozen?.version)
            } label: { Label("重命名", systemImage: "pencil") }

            if !isWorker {
                Button {
                    let reqId = pendingForkRequestId[session.key] ?? UUID().uuidString
                    pendingForkRequestId[session.key] = reqId
                    let originSelected = model.selectedKey
                    let forkTitle = model.displayTitle(for: session) + "（fork）"
                    closedNodes.remove("branch:\(session.key)")
                    pendingFork = (session.key, forkTitle)
                    Task {
                        actionBusy = true; defer { actionBusy = false; pendingFork = nil }
                        do {
                            let key = try await model.forkWorkbenchSession(session, title: forkTitle, kind: .fork, requestId: reqId)
                            pendingForkRequestId[session.key] = nil
                            if model.selectedKey == originSelected && model.displaySessions.contains(where: { $0.key == key }) {
                                onSelect(key)
                            }
                        } catch {
                            if let status = CoreError.wrap(error).status, (400..<500).contains(status) {
                                pendingForkRequestId[session.key] = nil
                            }
                            actionError = CliErrorText.text(for: error)
                        }
                    }
                } label: { Label(forkCheck.allowed ? "创建分支" : (forkCheck.reason ?? "暂不支持分支"), systemImage: "arrow.triangle.branch") }
                .disabled(!forkCheck.allowed || actionBusy)
            }

            Button {
                confirmingArchive = session
            } label: { Label("归档会话", systemImage: "archivebox") }
            .disabled(manageBlocked)

            Divider()

            Button(role: .destructive) {
                let frozen = model.workbenchMeta[session.key]
                confirmingDelete = (session, frozen?.id, frozen?.version)
            } label: { Label("删除会话", systemImage: "trash") }
            .disabled(manageBlocked)
        }

        Divider()

        Button {
            showingID = session
        } label: { Label("查看会话 ID", systemImage: "number") }
    }

    private func row(
        _ session: CliSession,
        asked: Int,
        context: String?,
        snippet: String?,
        depth: Int,
        hasChildren: Bool,
        historyStyle: Bool = false,
        activeSection: Bool = false,
        teamSummary: (working: Int, paused: Bool)? = nil
    ) -> some View {
        let binding = model.teamIndex.workerBySession[session.key]
        let baseTone = CliSessions.tone(session)
        let workerState = binding?.worker.status
        let waiting = asked > 0 || baseTone == .waiting || workerState == .waiting
        let failedWorker = binding != nil && workerState == .failed
        let effectiveTone: CliTone = waiting ? .waiting
            : (baseTone == .running || (binding != nil && workerState == .starting && session.online)) ? .running
            : baseTone
        let waitingLabel = asked > 1 ? "等你处理 \(asked)" : "等你处理"
        let title = model.displayTitle(for: session)
        let branchNodeId = "branch:\(session.key)"
        let isSelected = selected == session.key
        #if os(macOS)
        let isHovered = hoveredSession == session.key
        let showMenu = isHovered || isSelected
        #endif
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                if hasChildren {
                    Button { toggleNode(branchNodeId) } label: {
                        Image(systemName: isClosed(branchNodeId) ? "chevron.right" : "chevron.down")
                            .font(.system(size: 8.5, weight: .semibold))
                            .foregroundStyle(Theme.nexAgentMuted)
                            .frame(width: 16, height: 16)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                } else {
                    Color.clear.frame(width: 16, height: 16)
                }

                Button { onSelect(session.key) } label: {
                    HStack(spacing: 7) {
                        AgentEngineIcon(engine: session.engine, tone: effectiveTone, size: 18, failed: failedWorker)
                        Text(title).font(.system(size: 13, weight: isSelected ? .semibold : .regular))
                            .foregroundStyle(historyStyle ? Theme.nexAgentMuted : Theme.nexAgentInk).lineLimit(1)
                        if let role = binding?.worker.role, !role.isEmpty, !activeSection, !waiting, !failedWorker {
                            Text(role)
                                .font(.system(size: 10.5))
                                .foregroundStyle(Theme.nexAgentMuted)
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Theme.nexAgentInset, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                                .lineLimit(1)
                        }
                        Spacer(minLength: 4)
                        if let context { Text(context).font(.system(size: 11)).foregroundStyle(Theme.nexAgentMuted).lineLimit(1) }
                        if let ts = teamSummary, ts.working > 0 {
                            CliChip(text: "\(ts.working) 个工人工作中", tone: .running).fixedSize()
                        } else if let ts = teamSummary, ts.paused {
                            CliChip(text: "协作已暂停", tone: .waiting).fixedSize()
                        } else if waiting {
                            CliChip(text: waitingLabel, tone: .waiting).fixedSize()
                        } else if failedWorker {
                            CliChip(text: "失败", tone: .stopped, customColor: Theme.danger).fixedSize()
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(title)，\(agentName(session.engine))，\(waiting ? waitingLabel : CliSessions.statusLabel(session))")

                if !CliLaunches.isLaunchKey(session.key) {
                    #if os(macOS)
                    Menu {
                        sessionMenuItems(for: session)
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.nexAgentMuted.opacity(0.85))
                            .frame(width: 22, height: 22)
                            .contentShape(Rectangle())
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .opacity(showMenu ? 1 : 0)
                    .allowsHitTesting(showMenu)
                    .accessibilityLabel("\(title) 的操作")
                    #else
                    Menu {
                        sessionMenuItems(for: session)
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.nexAgentMuted.opacity(0.8))
                            .frame(width: 34, height: 36)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("\(title) 的操作")
                    #endif
                }
            }
            if let snippet, !snippet.isEmpty {
                Text(snippet)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.nexAgentMuted)
                    .lineLimit(2)
                    .padding(.leading, 40)
            }
        }
        .padding(.leading, CGFloat(min(depth, 6) * 14) + 6)
        .padding(.trailing, 6)
        #if os(iOS)
        .frame(minHeight: 42)
        .padding(.vertical, 3)
        #else
        .padding(.vertical, 5.5)
        #endif
        .background {
            #if os(macOS)
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(isSelected ? Theme.nexAgentSoft : isHovered ? Theme.nexAgentInset : .clear)
            #else
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(isSelected ? Theme.nexAgentSoft : .clear)
            #endif
        }
        .overlay(alignment: .leading) {
            if isSelected {
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(Theme.nexAgentAccent)
                    .frame(width: 2.5)
                    .padding(.vertical, 5)
            } else if depth > 0 {
                Rectangle()
                    .fill(Theme.nexAgentBorderStrong.opacity(0.75))
                    .frame(width: 1)
                    .padding(.leading, CGFloat(min(depth, 6) * 14) - 2)
            }
        }
        #if os(macOS)
        .onHover { inside in
            if inside { hoveredSession = session.key }
            else if hoveredSession == session.key { hoveredSession = nil }
        }
        #endif
        .opacity(model.isArchived(session) ? 0.65 : historyStyle ? 0.78 : 1)
        .contextMenu { if !CliLaunches.isLaunchKey(session.key) { sessionMenuItems(for: session) } }
        .help("\(agentName(session.engine)) · \(CliSessions.statusLabel(session))")
    }
}

/// Official brand Harness mark tile matching `HarnessMark.tsx` & `harnessBrand.ts`,
/// with a live status indicator dot when running, waiting, or failed.
struct AgentEngineIcon: View {
    let engine: CliEngine
    var tone: CliTone = .idle
    var size: CGFloat = 18
    var failed: Bool = false
    @State private var breathing = false

    private var assetName: String {
        switch engine {
        case .claude: "HarnessClaude"
        case .codex: "HarnessCodex"
        case .agy: "HarnessAgy"
        case .zcode: "HarnessZCode"
        }
    }

    private var tileBackground: Color {
        switch engine {
        case .claude: Color(hex: 0xFAF9F5)
        case .codex: Color(hex: 0x3941FF)
        case .agy: Color.white
        case .zcode: Color(hex: 0x171717)
        }
    }

    private var tileBorder: Color {
        switch engine {
        case .claude: Color(hex: 0xE8E0D6)
        case .agy: Color(hex: 0xDCE4F2)
        case .codex, .zcode: Color.clear
        }
    }

    var body: some View {
        let radius = max(4, size * 0.28)
        let glyphSize = size * 0.68
        ZStack(alignment: .bottomTrailing) {
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(tileBackground)
                .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(tileBorder, lineWidth: 0.75))
                .overlay {
                    Image(assetName)
                        .resizable()
                        .scaledToFit()
                        .frame(width: glyphSize, height: glyphSize)
                }
                .frame(width: size, height: size)
                .opacity(tone == .offline ? 0.45 : 1)

            if failed {
                Circle()
                    .fill(Theme.danger)
                    .frame(width: 6.5, height: 6.5)
                    .overlay(Circle().stroke(Theme.nexAgentSurface, lineWidth: 1.2))
                    .offset(x: 2, y: 2)
            } else if tone == .running || tone == .waiting {
                Circle()
                    .fill(tone == .running ? Theme.nexAgentAccent : Theme.approval)
                    .frame(width: 6.5, height: 6.5)
                    .overlay(Circle().stroke(Theme.nexAgentSurface, lineWidth: 1.2))
                    .overlay(Circle().stroke(tone == .running ? Theme.nexAgentAccent.opacity(breathing ? 0 : 0.45) : .clear, lineWidth: breathing ? 4 : 1))
                    .offset(x: 2, y: 2)
                    .onAppear {
                        if tone == .running {
                            withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: false)) { breathing = true }
                        }
                    }
            }
        }
        .accessibilityHidden(true)
    }
}

/// A session's state as a dot; idle and stopped show none (a clear dot keeps titles aligned).
struct AgentStateDot: View {
    let tone: CliTone
    @State private var breathing = false
    var body: some View {
        Circle()
            .fill(tone == .running ? Theme.nexAgentAccent : tone == .waiting ? Theme.approval : .clear)
            .frame(width: 8, height: 8)
            .overlay(Circle().stroke(tone == .running ? Theme.nexAgentAccent.opacity(breathing ? 0 : 0.35) : .clear, lineWidth: breathing ? 6 : 1))
            .onAppear { if tone == .running { withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: false)) { breathing = true } } }
            .accessibilityHidden(true)
    }
}

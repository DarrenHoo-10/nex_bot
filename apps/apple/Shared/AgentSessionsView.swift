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

    var body: some View {
        Text(text).font(.system(size: 11, weight: .medium)).foregroundStyle(tone.color)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(tone.color.opacity(0.14), in: Capsule())
    }
}

private enum AgentSheet: Identifiable {
    case supervision
    var id: String { "supervision" }
}

/// "NexAgent": the coding-agent workbench of the person's computers.
/// On macOS the session list lives directly in the left sidebar (`ContactsList`) so this view renders the right-hand
/// workbench stage; on iOS it renders the list and pushes sessions or the new-session composer.
struct AgentSessionsView: View {
    let model: CliAgentsModel
    let workspace: WorkspaceStore
    /// After 交给助手: show the assistant's conversation.
    let openAssistant: (String) -> Void
    @Environment(\.scenePhase) private var scenePhase
    @State private var sheet: AgentSheet?
    @State private var errorText = ""
    @State private var deleting: CliSession?
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
            .sheet(item: $sheet) { _ in AgentSupervisionSheet(model: model) }
            .alert("删除会话？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { session in
                Button("取消", role: .cancel) { deleting = nil }
                Button("删除会话", role: .destructive) {
                    let target = session
                    deleting = nil
                    Task {
                        do { try await model.deleteSession(target.key) } catch { errorText = CliErrorText.text(for: error) }
                    }
                }
            } message: { session in
                Text("将永久删除「\(CliSessions.title(session))」在电脑上的原生会话记录，无法恢复。")
            }
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

    private var header: some View {
        HStack(spacing: 10) {
            BrandMark(size: 20, agent: true)
            Text("NexAgent").font(.system(size: 16, weight: .bold))
            if !linkText.isEmpty { Text(linkText).font(.caption).foregroundStyle(Theme.muted) }
            Spacer()
            headerActions
        }
        .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 6)
    }

    @ViewBuilder private var headerActions: some View {
        Button { Task { await toggleBell() } } label: {
            Image(systemName: model.notificationsOn ? "bell.fill" : "bell.slash")
        }
        .buttonStyle(.plain).foregroundStyle(model.notificationsOn ? Theme.nexAgentAccent : Theme.muted)
        .help(model.notificationsOn ? "关闭通知" : "开启通知").accessibilityLabel(model.notificationsOn ? "关闭通知" : "开启通知")
        Button { sheet = .supervision } label: { Image(systemName: "gearshape") }
            .buttonStyle(.plain).foregroundStyle(Theme.muted)
            .help("自动处理设置").accessibilityLabel("自动处理设置")
    }

    private var banner: some View {
        let text = !errorText.isEmpty ? errorText : (model.loadError ?? "")
        return Group {
            if !text.isEmpty {
                HStack {
                    Text(text).font(.caption).foregroundStyle(Theme.danger)
                    Button("重新加载") { errorText = ""; Task { await model.refresh() } }.font(.caption).buttonStyle(.plain).foregroundStyle(Theme.nexAgentAccent)
                }
            }
        }
    }

    private func list(onSelect: @escaping (CliSessionKey) -> Void) -> some View {
        AgentSessionList(
            model: model,
            selected: composing == nil ? model.selectedKey : nil,
            onSelect: { key in composing = nil; onSelect(key) },
            onCreate: { composing = AgentNewTarget(deviceId: model.selected?.deviceId, cwd: model.selected?.cwd) },
            onNew: { composing = AgentNewTarget(deviceId: $0, cwd: $1) },
            onArchive: { session, archived in
                Task {
                    do { try await model.archiveSession(session.key, archived: archived) } catch { errorText = CliErrorText.text(for: error) }
                }
            },
            onDelete: { session in deleting = session })
    }

    private func toggleBell() async {
        if model.notificationsOn { model.setNotifications(false); return }
        model.setNotifications(await AgentNotifier.requestAuthorization())
    }

    #if os(macOS)
    private var layout: some View {
        VStack(spacing: 0) {
            header
            banner.padding(.horizontal, 16).padding(.bottom, 6)
            Group {
                if let target = composing {
                    AgentNewSessionPage(model: model, target: target) { _ in composing = nil }.id(target.id)
                } else if let launch = model.selectedLaunch {
                    AgentLaunchDetail(model: model, launch: launch).id(launch.id)
                } else if let key = model.selectedKey, model.selected != nil {
                    AgentSessionDetail(model: model, workspace: workspace, key: key, openAssistant: openAssistant) { model.select($0) }
                        .id(key)
                } else {
                    VStack(spacing: 10) {
                        BrandMark(size: 36, agent: true)
                        Text("选择一个会话或新建会话").font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.muted)
                        Button {
                            composing = AgentNewTarget(deviceId: model.devices.first(where: \.online)?.id ?? model.devices.first?.id, cwd: nil)
                        } label: {
                            Label("新建会话", systemImage: "plus")
                                .font(.system(size: 13, weight: .semibold))
                                .padding(.horizontal, 14).padding(.vertical, 7)
                                .background(Theme.nexAgentAccent, in: Capsule())
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
        .glass(RoundedRectangle(cornerRadius: 22, style: .continuous), strong: true, lift: .card)
    }
    #else
    private var layout: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                if !linkText.isEmpty { Text(linkText).font(.caption).foregroundStyle(Theme.muted) }
                Spacer()
                headerActions
            }
            .padding(.horizontal, 4)
            banner
            list { key in model.select(key); pushed = key }
        }
        .padding(.horizontal, 12).padding(.top, 4)
        .background { WorkspaceSurface(kind: .stage) }
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
            .background { WorkspaceSurface(kind: .stage) }
            .toolbar(.visible, for: .navigationBar)
        }
        .navigationDestination(item: $composing) { target in
            AgentNewSessionPage(model: model, target: target) { key in
                composing = nil
                // the page leaves first, then the new session is pushed in its place
                DispatchQueue.main.async { pushed = key }
            }
            .background { WorkspaceSurface(kind: .stage) }
            .toolbar(.visible, for: .navigationBar)
        }
        .onChange(of: model.selectedKey) { previous, next in
            if CliLaunches.isLaunchKey(previous), pushed == previous { pushed = next }
        }
    }
    #endif
}

/// A new-session button, toolbar (timeline toggle + full-text search), what is running pinned on top,
/// then computers (only when there are several), draggable projects and sessions.
struct AgentSessionList: View {
    let model: CliAgentsModel
    let selected: CliSessionKey?
    let onSelect: (CliSessionKey) -> Void
    let onCreate: () -> Void
    let onNew: (String, String?) -> Void
    var onArchive: ((CliSession, Bool) -> Void)? = nil
    var onDelete: ((CliSession) -> Void)? = nil
    var onHide: ((CliSession, Bool) -> Void)? = nil
    @AppStorage("nexagent.activeFolded") private var activeFolded = false
    @AppStorage("nexagent.timeSort") private var byTime = false
    @AppStorage("nexagent.projectOrder") private var projectOrderJSON = "{}"

    @State private var searchOpen = false
    @State private var filter = ""
    @State private var contentHits: [CliSessionKey: String] = [:]
    @State private var searchError = ""
    @State private var closedNodes: Set<String> = []
    @State private var draggingProject: String?
    @State private var archivedMode = false
    @State private var renaming: (session: CliSession, id: String?, version: Int?)?
    @State private var renameText = ""
    @State private var confirmingDelete: (session: CliSession, id: String?, version: Int?)?
    @State private var showingID: CliSession?
    @State private var pendingForkRequestId: [CliSessionKey: String] = [:]
    @State private var actionBusy = false
    @State private var actionError = ""
    @FocusState private var searchFocused: Bool

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
            let remembered = CliSessions.rememberProjects(group.folders, saved: current)
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
        let current = CliSessions.rememberProjects(folders, saved: map[deviceId] ?? [])
        map[deviceId] = CliSessions.moveProject(current, moving: moving, target: target, after: after)
        saveOrder(map)
    }

    private func matches(_ session: CliSession, folderLabel: String = "", root: String = "") -> Bool {
        guard !query.isEmpty else { return true }
        if contentHits[session.key] != nil { return true }
        let hay = [
            model.displayTitle(for: session),
            folderLabel,
            root,
            session.cwd,
            agentName(session.engine),
            session.gitBranch ?? "",
        ].joined(separator: " ")
        return CliSessions.matchesTerms(hay, query: query)
    }

    private func listed(_ sessions: [CliSession]) -> [CliSession] {
        sessions.filter { !model.isDeleted($0) && !model.isSideSession($0) && model.isArchived($0) == archivedMode }
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

    /// Builds the visible hierarchical tree for a folder, preserving ancestor chains on search matches
    /// and never promoting collapsed descendants to top-level roots.
    private func treeRows(allEntries: [CliSession], folderLabel: String, root: String) -> [(session: CliSession, depth: Int, hasChildren: Bool)] {
        let allKeys = Set(allEntries.map(\.key))
        var fullParentOf: [CliSessionKey: CliSessionKey] = [:]
        for s in allEntries {
            if let p = model.parentKey(of: s), p != s.key, allKeys.contains(p) {
                fullParentOf[s.key] = p
            }
        }
        let entries: [CliSession]
        if query.isEmpty {
            entries = allEntries
        } else {
            let hits = allEntries.filter { matches($0, folderLabel: folderLabel, root: root) }
            var matched = Set(hits.map(\.key))
            for hit in hits {
                var cur = fullParentOf[hit.key]
                var guardSteps = 0
                while let p = cur, !matched.contains(p), guardSteps < 32 {
                    matched.insert(p)
                    cur = fullParentOf[p]
                    guardSteps += 1
                }
            }
            entries = allEntries.filter { matched.contains($0.key) }
        }
        guard !entries.isEmpty else { return [] }

        let keys = Set(entries.map(\.key))
        var childrenOf: [CliSessionKey: [CliSession]] = [:]
        var roots: [CliSession] = []
        for s in entries {
            if let p = fullParentOf[s.key], keys.contains(p) {
                childrenOf[p, default: []].append(s)
            } else {
                roots.append(s)
            }
        }

        var out: [(CliSession, Int, Bool)] = []
        var reachable = Set<CliSessionKey>()

        func markSubtreeReachable(_ key: CliSessionKey) {
            for kid in childrenOf[key] ?? [] where !reachable.contains(kid.key) {
                reachable.insert(kid.key)
                markSubtreeReachable(kid.key)
            }
        }

        func visit(_ list: [CliSession], depth: Int) {
            let sorted = list.sorted { $0.lastActivityAt > $1.lastActivityAt }
            for s in sorted where !reachable.contains(s.key) {
                reachable.insert(s.key)
                let kids = childrenOf[s.key] ?? []
                out.append((s, depth, !kids.isEmpty))
                if !kids.isEmpty {
                    if depth < 24 && !isClosed("branch:\(s.key)") {
                        visit(kids, depth: depth + 1)
                    } else {
                        markSubtreeReachable(s.key)
                    }
                }
            }
        }

        visit(roots, depth: 0)
        // Only genuinely unreachable cycles (no root in the component) fall back to depth 0.
        let cycleNodes = entries.filter { !reachable.contains($0.key) }
        if !cycleNodes.isEmpty { visit(cycleNodes, depth: 0) }
        return out
    }

    var body: some View {
        let groups = model.allGroups
        let pending = model.pendingCounts
        let active = (byTime || archivedMode || !query.isEmpty) ? [] : model.activeSessions.filter { !model.isDeleted($0) && !model.isSideSession($0) && !model.isArchived($0) }
        // one computer that is online needs no computer row: its projects are the list
        let single = groups.count == 1 && groups.first?.device.online == true
        let flat: [CliSession] = byTime
            ? groups.flatMap { listed($0.folders.flatMap(\.sessions)) }
                .filter { matches($0, folderLabel: CliSessions.folderLabel($0.repoRoot ?? $0.cwd), root: $0.repoRoot ?? $0.cwd) }
                .sorted { $0.lastActivityAt > $1.lastActivityAt }
            : []
        let archivedCount = model.displaySessions.filter { !model.isDeleted($0) && !model.isSideSession($0) && model.isArchived($0) }.count
        let projectSignature = groups.map { "\($0.device.id):\($0.folders.map(\.id).joined(separator: ","))" }

        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if !archivedMode {
                    Button(action: onCreate) {
                        Label("新建会话", systemImage: "plus").font(.system(size: 13, weight: .semibold))
                            .frame(maxWidth: .infinity).frame(height: 34)
                            .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border))
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.foreground)
                    .disabled(model.devices.isEmpty)
                }

                // Toolbar: title + timeline toggle + search toggle
                HStack(spacing: 6) {
                    Text(archivedMode ? "已归档" : byTime ? "按时间" : "会话目录")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(Theme.muted)
                    Spacer()
                    Button { byTime.toggle() } label: {
                        Image(systemName: "clock")
                            .font(.system(size: 13))
                            .foregroundStyle(byTime ? Theme.nexAgentAccent : Theme.muted)
                            .frame(width: 24, height: 24)
                            .background(byTime ? Theme.nexAgentSoft : .clear, in: RoundedRectangle(cornerRadius: 6))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(byTime ? "恢复项目目录" : "按时间排序")
                    .accessibilityLabel("按时间排序")

                    Button {
                        if searchOpen { searchOpen = false; filter = "" }
                        else { searchOpen = true; searchFocused = true }
                    } label: {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 13))
                            .foregroundStyle(searchOpen ? Theme.nexAgentAccent : Theme.muted)
                            .frame(width: 24, height: 24)
                            .background(searchOpen ? Theme.nexAgentSoft : .clear, in: RoundedRectangle(cornerRadius: 6))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("搜索会话")
                    .accessibilityLabel("搜索会话")
                }
                .padding(.horizontal, 4)

                if searchOpen {
                    HStack(spacing: 6) {
                        Image(systemName: "magnifyingglass").font(.system(size: 11.5)).foregroundStyle(Theme.muted)
                        searchFieldInput
                        if !filter.isEmpty {
                            Button { filter = ""; searchFocused = true } label: {
                                Image(systemName: "xmark.circle.fill").font(.system(size: 12)).foregroundStyle(Theme.muted)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("清除搜索")
                        }
                    }
                    .padding(.horizontal, 9).frame(height: 30)
                    .background(Theme.wash, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Theme.nexAgentAccent.opacity(searchFocused ? 0.5 : 0), lineWidth: 1.5))
                }

                if !searchError.isEmpty {
                    Text(searchError).font(.caption2).foregroundStyle(Theme.muted).padding(.horizontal, 6)
                }

                if !actionError.isEmpty {
                    HStack(spacing: 6) {
                        Text(actionError).font(.caption).foregroundStyle(Theme.danger)
                        Spacer()
                        Button { actionError = "" } label: { Image(systemName: "xmark").font(.system(size: 10)).foregroundStyle(Theme.muted) }.buttonStyle(.plain)
                    }
                    .padding(.horizontal, 6)
                }

                if !model.loaded {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 24)
                } else if groups.isEmpty {
                    Text("还没有电脑接入").font(.footnote).foregroundStyle(Theme.muted).frame(maxWidth: .infinity).padding(.top, 24)
                }

                if !active.isEmpty { pinned(active, pending: pending) }

                if byTime {
                    if flat.isEmpty && model.loaded {
                        Text(archivedMode ? "没有已归档的会话" : query.isEmpty ? "暂无会话" : "没有匹配的会话")
                            .font(.caption).foregroundStyle(Theme.muted)
                            .frame(maxWidth: .infinity).padding(.top, 16)
                    } else {
                        ForEach(flat) { session in
                            row(session, asked: pending[session.key] ?? 0, context: CliSessions.projectLabel(session), snippet: contentHits[session.key], depth: 0, hasChildren: false)
                        }
                    }
                } else {
                    ForEach(groups) { group in device(group, pending: pending, single: single) }
                    if archivedMode && archivedCount == 0 {
                        Text("没有已归档的会话")
                            .font(.caption).foregroundStyle(Theme.muted)
                            .frame(maxWidth: .infinity).padding(.top, 16)
                    }
                }

                Button { archivedMode.toggle() } label: {
                    HStack(spacing: 6) {
                        Image(systemName: archivedMode ? "arrow.uturn.backward" : "archivebox").font(.system(size: 12))
                        Text(archivedMode ? "返回会话目录" : archivedCount > 0 ? "已归档 (\(archivedCount))" : "已归档").font(.system(size: 12))
                    }
                    .foregroundStyle(Theme.muted)
                    .padding(.horizontal, 6).padding(.vertical, 4)
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

    /// Running or waiting sessions on every computer; folds to its heading, which still counts them and says when one waits.
    private func pinned(_ active: [CliSession], pending: [CliSessionKey: Int]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Button { activeFolded.toggle() } label: {
                HStack(spacing: 5) {
                    Image(systemName: activeFolded ? "chevron.right" : "chevron.down").font(.system(size: 9, weight: .semibold))
                    Text("进行中").font(.system(size: 11, weight: .semibold))
                    if activeFolded, active.contains(where: { $0.state == .waiting }) {
                        Circle().fill(Theme.approval).frame(width: 6, height: 6).accessibilityLabel("有会话等你处理")
                    }
                    Spacer()
                    Text("\(active.count)").font(.system(size: 11))
                }
                .foregroundStyle(Theme.muted).padding(.horizontal, 6).padding(.vertical, 3).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(activeFolded ? "展开进行中" : "收起进行中")
            if !activeFolded {
                ForEach(active) { session in row(session, asked: pending[session.key] ?? 0, context: CliSessions.projectLabel(session), snippet: nil, depth: 0, hasChildren: false) }
            }
            Divider().padding(.top, 4)
        }
    }

    private func device(_ group: CliDeviceGroup, pending: [CliSessionKey: Int], single: Bool) -> some View {
        let deviceNodeId = "dev:\(group.device.id)"
        let orderedFolders = CliSessions.orderProjects(group.folders, saved: projectOrder[group.device.id] ?? [])
        return VStack(alignment: .leading, spacing: 4) {
            if !single {
                HStack(spacing: 6) {
                    Button { toggleNode(deviceNodeId) } label: {
                        Image(systemName: isClosed(deviceNodeId) ? "chevron.right" : "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Theme.muted)
                            .frame(width: 14, height: 14)
                    }
                    .buttonStyle(.plain)
                    Circle().fill(group.device.online ? Theme.success : Theme.offline).frame(width: 7, height: 7)
                    Text(group.device.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Text(group.device.online ? "\(group.count)" : "离线").font(.caption).foregroundStyle(Theme.muted)
                    Spacer()
                    if !archivedMode {
                        Button { onNew(group.device.id, nil) } label: { Image(systemName: "plus") }
                            .buttonStyle(.plain).foregroundStyle(Theme.muted)
                            .accessibilityLabel("在 \(group.device.name) 上新建会话")
                    }
                }
            }
            if single || !isClosed(deviceNodeId) {
                ForEach(orderedFolders) { folder in
                    let folderSessions = listed(folder.sessions)
                    let rows = treeRows(allEntries: folderSessions, folderLabel: folder.label, root: folder.cwd)
                    if !rows.isEmpty {
                        let folderId = folder.id
                        let folderNodeId = "proj:\(group.device.id):\(folderId)"
                        let dragPayload = "\(group.device.id)\n\(folderId)"
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 5) {
                                Button { toggleNode(folderNodeId) } label: {
                                    Image(systemName: isClosed(folderNodeId) ? "chevron.right" : "chevron.down")
                                        .font(.system(size: 9, weight: .semibold))
                                        .foregroundStyle(Theme.muted)
                                        .frame(width: 14, height: 14)
                                }
                                .buttonStyle(.plain)
                                Text(folder.label).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.foreground).lineLimit(1)
                                Spacer()
                                if !archivedMode {
                                    Button { onNew(group.device.id, folder.cwd) } label: {
                                        Image(systemName: "plus").font(.system(size: 12)).frame(width: 24, height: 24)
                                            .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain).foregroundStyle(Theme.muted)
                                    .help("新建会话")
                                    .accessibilityLabel("在 \(folder.label) 中新建会话")
                                }
                                Text("\(rows.count)").font(.system(size: 11)).foregroundStyle(Theme.muted)
                            }
                            .padding(.horizontal, 4).padding(.top, 6).padding(.bottom, 2)
                            .contentShape(Rectangle())
                            .opacity(draggingProject == dragPayload ? 0.5 : 1)
                            .help(folder.roots.count > 1 ? folder.roots.joined(separator: "\n") : folder.cwd)
                            .draggable(dragPayload) {
                                Text(folder.label).font(.system(size: 12, weight: .semibold))
                                    .padding(.horizontal, 10).padding(.vertical, 5)
                                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 8))
                            }
                            .dropDestination(for: String.self) { items, location in
                                guard let payload = items.first else { return false }
                                let parts = payload.split(separator: "\n", maxSplits: 1).map(String.init)
                                guard parts.count == 2, parts[0] == group.device.id else { return false }
                                moveProject(deviceId: group.device.id, folders: group.folders, moving: parts[1], target: folder.id, after: location.y > 16)
                                return true
                            }
                            if !isClosed(folderNodeId) {
                                ForEach(rows, id: \.session.key) { entry in
                                    row(entry.session, asked: pending[entry.session.key] ?? 0, context: nil, snippet: contentHits[entry.session.key], depth: entry.depth, hasChildren: entry.hasChildren)
                                }
                            }
                        }
                    }
                }
            }
            if group.count == 0 && !archivedMode { Text("暂无会话").font(.caption).foregroundStyle(Theme.muted) }
        }
    }

    @ViewBuilder
    private func sessionMenuItems(for session: CliSession) -> some View {
        let forkCheck = canFork(session)
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

            Button {
                let reqId = pendingForkRequestId[session.key] ?? UUID().uuidString
                pendingForkRequestId[session.key] = reqId
                let originSelected = model.selectedKey
                Task {
                    actionBusy = true; defer { actionBusy = false }
                    do {
                        let key = try await model.forkWorkbenchSession(session, title: "", kind: .fork, requestId: reqId)
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

            Button {
                Task {
                    actionBusy = true; defer { actionBusy = false }
                    do { try await model.archiveWorkbenchSession(session, archived: true) }
                    catch { actionError = CliErrorText.text(for: error) }
                }
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

    private func row(_ session: CliSession, asked: Int, context: String?, snippet: String?, depth: Int, hasChildren: Bool) -> some View {
        let tone = CliSessions.tone(session)
        let waiting = asked > 0 || tone == .waiting
        let waitingLabel = asked > 1 ? "等你处理 \(asked)" : "等你处理"
        let title = model.displayTitle(for: session)
        let branchNodeId = "branch:\(session.key)"
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                if hasChildren {
                    Button { toggleNode(branchNodeId) } label: {
                        Image(systemName: isClosed(branchNodeId) ? "chevron.right" : "chevron.down")
                            .font(.system(size: 8.5, weight: .semibold))
                            .foregroundStyle(Theme.muted)
                            .frame(width: 12, height: 14)
                    }
                    .buttonStyle(.plain)
                }
                Button { onSelect(session.key) } label: {
                    HStack(spacing: 7) {
                        // the dot is the state: green breathing while it runs, amber while it waits for you
                        AgentStateDot(tone: tone)
                        Text(title).font(.system(size: 13, weight: selected == session.key ? .semibold : .regular))
                            .foregroundStyle(Theme.foreground).lineLimit(1)
                        Spacer(minLength: 4)
                        if let context { Text(context).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1) }
                        if waiting { CliChip(text: waitingLabel, tone: .waiting).fixedSize() }
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
                            .foregroundStyle(Theme.muted.opacity(0.75))
                            .frame(width: 20, height: 20)
                            .contentShape(Rectangle())
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .accessibilityLabel("\(title) 的操作")
                    #else
                    Menu {
                        sessionMenuItems(for: session)
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.muted.opacity(0.75))
                            .frame(width: 24, height: 24)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("\(title) 的操作")
                    #endif
                }
            }
            if let snippet, !snippet.isEmpty {
                Text(snippet)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.muted)
                    .lineLimit(2)
                    .padding(.leading, 16)
            }
        }
        .padding(.leading, CGFloat(min(depth, 6) * 14) + 8)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .background(selected == session.key ? Theme.nexAgentSoft : .clear, in: RoundedRectangle(cornerRadius: 8))
        .overlay(alignment: .leading) { if selected == session.key { Rectangle().fill(Theme.nexAgentAccent).frame(width: 2.5).padding(.vertical, 4) } }
        .opacity(model.isArchived(session) ? 0.65 : 1)
        .contextMenu { if !CliLaunches.isLaunchKey(session.key) { sessionMenuItems(for: session) } }
        .help("\(agentName(session.engine)) · \(CliSessions.statusLabel(session))")
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

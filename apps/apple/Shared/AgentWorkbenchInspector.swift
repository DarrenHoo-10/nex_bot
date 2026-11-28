import SwiftUI
import NexClientKit

/// Right-hand inspector tabs of the NexAgent workbench: Git workspace info, session notes/annotations, and side chats.
enum AgentWorkbenchTab: String, CaseIterable, Identifiable {
    case git = "信息"
    case notes = "笔记"
    case sideChats = "侧聊"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .git: "arrow.triangle.branch"
        case .notes: "note.text"
        case .sideChats: "bubble.left.and.bubble.right"
        }
    }
}

/// Draft pre-filled when the user clicks "记笔记" on a reply in the transcript.
struct AgentNoteDraft: Equatable {
    var messageId: String
    var quote: String
}

/// Collapsible right-hand inspector for a NexAgent session (Git status & live activity, notes/annotations, and side chats).
struct AgentWorkbenchInspector: View {
    let model: CliAgentsModel
    let session: CliSession
    @Binding var tab: AgentWorkbenchTab
    @Binding var noteDraft: AgentNoteDraft?
    @Binding var notes: [CliNote]
    var onOpenTerminal: (() -> Void)? = nil
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                ForEach(AgentWorkbenchTab.allCases) { item in
                    Button { tab = item } label: {
                        HStack(spacing: 4) {
                            Image(systemName: item.icon).font(.system(size: 11))
                            Text(item.rawValue).font(.system(size: 12, weight: tab == item ? .semibold : .regular))
                            if item == .notes && !notes.isEmpty {
                                Text("\(notes.count)").font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(Theme.nexAgentAccent)
                            }
                        }
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .foregroundStyle(tab == item ? Theme.nexAgentAccent : Theme.nexAgentMuted)
                        .background(tab == item ? Theme.nexAgentSoft : .clear, in: RoundedRectangle(cornerRadius: 7))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.nexAgentMuted)
                        .frame(width: 24, height: 24).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("关闭面板")
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Theme.nexAgentSurface)
            Divider().overlay(Theme.nexAgentBorder)

            Group {
                switch tab {
                case .git:
                    AgentGitInfoPane(model: model, session: session, onOpenTerminal: onOpenTerminal)
                case .notes:
                    AgentNotesPane(model: model, session: session, draft: $noteDraft, notes: $notes)
                case .sideChats:
                    AgentSideChatsPane(model: model, session: session)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.nexAgentNav)
        }
    }
}

// MARK: - Git Info & Live Activity Pane

private struct AgentGitInfoPane: View {
    let model: CliAgentsModel
    let session: CliSession
    var onOpenTerminal: (() -> Void)? = nil
    @State private var git: CliGitInfo?
    @State private var loading = false
    @State private var error = ""
    @State private var filesExpanded = true

    private var activity: CliSessionActivity {
        CliSessionActivity.extract(items: model.transcript(session.key).items, state: session.state, online: session.online)
    }

    private var branchName: String {
        let b = (git?.branch ?? session.gitBranch ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return b.isEmpty ? "—" : b
    }

    private func normalizedPath(_ path: String) -> String {
        CliSessions.normalizePath(path)
    }

    /// Compares the actual working tree (`git.worktree ?? session.cwd`) against the main repo root (`session.repoRoot`).
    private var worktreeLabel: String {
        let currentTree = git?.worktree ?? session.cwd
        if let mainRoot = session.repoRoot, !mainRoot.isEmpty, !currentTree.isEmpty {
            if normalizedPath(mainRoot) == normalizedPath(currentTree) {
                return "主工作树"
            }
            return CliSessions.worktreeName(currentTree) ?? CliSessions.folderLabel(currentTree)
        }
        if let wtName = CliSessions.worktreeName(currentTree) { return wtName }
        return currentTree.isEmpty ? "—" : CliSessions.folderLabel(currentTree)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if CliSessions.canAttach(session), let onOpenTerminal {
                    Button(action: onOpenTerminal) {
                        HStack(spacing: 7) {
                            Image(systemName: "terminal").font(.system(size: 13, weight: .semibold))
                            Text("打开远程终端").font(.system(size: 13, weight: .semibold))
                            Spacer()
                            Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).opacity(0.7)
                        }
                        .foregroundStyle(Theme.nexAgentAccent)
                        .padding(.horizontal, 12).padding(.vertical, 9)
                        .background(Theme.nexAgentSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.nexAgentAccent.opacity(0.32)))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }

                HStack {
                    Label("Git 工作区", systemImage: "arrow.triangle.branch")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.nexAgentInk)
                    Spacer()
                    Button { Task { await load() } } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.nexAgentMuted)
                    }
                    .buttonStyle(.plain)
                    .disabled(loading)
                    .help("刷新 Git 状态")
                }

                VStack(alignment: .leading, spacing: 8) {
                    infoRow(label: "运行工具", value: agentName(session.engine))
                    infoRow(label: "目录", value: CliSessions.folderLabel(session.cwd), help: session.cwd)
                    HStack(spacing: 6) {
                        Text("分支").font(.caption).foregroundStyle(Theme.nexAgentMuted).frame(width: 56, alignment: .leading)
                        Text(branchName).font(.system(size: 12.5, weight: .medium)).foregroundStyle(Theme.nexAgentInk).lineLimit(1)
                        if let head = git?.head, !head.isEmpty {
                            Text(head).font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(Theme.nexAgentMuted)
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Theme.nexAgentInset, in: RoundedRectangle(cornerRadius: 4))
                        }
                    }
                    infoRow(label: "工作树", value: worktreeLabel, help: git?.worktree ?? session.cwd)
                }
                .padding(10)
                .background(Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.nexAgentBorder))

                if loading {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("正在读取 Git 状态…").font(.caption).foregroundStyle(Theme.nexAgentMuted)
                    }
                } else if !error.isEmpty {
                    Text(error).font(.caption).foregroundStyle(Theme.nexAgentMuted)
                } else if let git {
                    VStack(alignment: .leading, spacing: 6) {
                        Button { filesExpanded.toggle() } label: {
                            HStack(spacing: 6) {
                                Image(systemName: filesExpanded ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .semibold))
                                Text("更改").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.nexAgentInk)
                                Text("\(git.files.count) 个文件").font(.caption).foregroundStyle(Theme.nexAgentMuted)
                                Spacer()
                                if let added = git.added { Text("+\(added)").font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.success) }
                                if let removed = git.removed { Text("−\(removed)").font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.danger) }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)

                        if filesExpanded {
                            if git.files.isEmpty {
                                Text("工作树干净").font(.caption).foregroundStyle(Theme.nexAgentMuted).padding(.top, 2)
                            } else {
                                VStack(alignment: .leading, spacing: 4) {
                                    ForEach(git.files, id: \.self) { file in
                                        Text(file)
                                            .font(.system(size: 11.5, design: .monospaced))
                                            .foregroundStyle(Theme.nexAgentInk)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                            .help(file)
                                    }
                                }
                                .padding(.top, 4)
                            }
                        }
                    }
                    .padding(10)
                    .background(Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.nexAgentBorder))
                }

                if !activity.todos.isEmpty {
                    activityCard(title: "待办", symbol: "checklist", entries: activity.todos)
                }
                if !activity.agents.isEmpty {
                    activityCard(title: "子代理", symbol: "person.2", entries: activity.agents)
                }
                if !activity.jobs.isEmpty {
                    activityCard(title: "后台任务", symbol: "bolt.horizontal", entries: activity.jobs)
                }
            }
            .padding(12)
        }
        .task(id: session.key) { await load() }
    }

    private func activityCard(title: String, symbol: String, entries: [CliSessionActivity.Entry]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("\(title) (\(entries.count))", systemImage: symbol)
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(Theme.nexAgentInk)
            ForEach(entries) { entry in
                HStack(alignment: .top, spacing: 6) {
                    Text(entry.title)
                        .font(.caption)
                        .foregroundStyle(entry.state == "已完成" ? Theme.nexAgentMuted : Theme.nexAgentInk)
                        .strikethrough(entry.state == "已完成")
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    Text(entry.state)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(entry.state == "失败" ? Theme.danger : entry.state == "已完成" ? Theme.nexAgentMuted : Theme.nexAgentAccent)
                        .padding(.horizontal, 6).padding(.vertical, 1.5)
                        .background((entry.state == "失败" ? Theme.danger : entry.state == "已完成" ? Theme.nexAgentMuted : Theme.nexAgentAccent).opacity(0.12), in: Capsule())
                }
            }
        }
        .padding(10)
        .background(Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.nexAgentBorder))
    }

    private func infoRow(label: String, value: String, help: String? = nil) -> some View {
        HStack(spacing: 6) {
            Text(label).font(.caption).foregroundStyle(Theme.nexAgentMuted).frame(width: 56, alignment: .leading)
            Text(value).font(.system(size: 12.5, weight: .medium)).foregroundStyle(Theme.nexAgentInk).lineLimit(1).truncationMode(.middle)
                .help(help ?? value)
            Spacer(minLength: 0)
        }
    }

    private func load() async {
        loading = true; error = ""
        defer { loading = false }
        do {
            let result = try await model.gitInfo(for: session.key)
            if result.source == "none" {
                git = nil; error = "当前目录没有 Git 信息"
            } else if result.source == "failed" {
                git = nil; error = result.error ?? "Git 状态读取失败"
            } else {
                git = result
            }
        } catch {
            git = nil; self.error = CliErrorText.text(for: error, fallback: "Git 状态读取失败")
        }
    }
}

// MARK: - Notes / Annotations Pane

private struct AgentNotesPane: View {
    let model: CliAgentsModel
    let session: CliSession
    @Binding var draft: AgentNoteDraft?
    @Binding var notes: [CliNote]

    @State private var loading = false
    @State private var error = ""
    @State private var newQuote = ""
    @State private var newBody = ""
    @State private var newMessageId = ""
    @State private var pendingNote: (id: String, messageId: String, quote: String, body: String)?
    @State private var saving = false
    @State private var editing: CliNote?
    @State private var editBody = ""
    @State private var conflictRemoteBody: String?

    private var latestRealMessage: CliItem? {
        model.transcript(session.key).items.last { ($0.kind == .assistant || $0.kind == .user) && !$0.id.isEmpty }
    }

    private var effectiveMessageId: String {
        if !newMessageId.isEmpty { return newMessageId }
        return latestRealMessage?.id ?? ""
    }

    private var canSaveNew: Bool {
        !saving
            && !effectiveMessageId.isEmpty
            && !newQuote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !newBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if !error.isEmpty {
                        Text(error).font(.caption).foregroundStyle(Theme.danger)
                    }
                    if loading && notes.isEmpty {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 20)
                    } else if notes.isEmpty {
                        Text("还没有会话笔记，请在回复下方点击「记笔记」或填写引用内容后保存；保存的笔记会自动附带在下次发送中。")
                            .font(.caption).foregroundStyle(Theme.nexAgentMuted)
                            .padding(.top, 12)
                    } else {
                        ForEach(notes) { note in
                            noteCard(note)
                        }
                    }
                }
                .padding(12)
            }

            Divider().overlay(Theme.nexAgentBorder)

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    TextField("引用片段（必填，或在消息上点「记笔记」自动带入）", text: $newQuote)
                        .textFieldStyle(.plain)
                        .font(.caption)
                    if !newQuote.isEmpty {
                        Button { newQuote = ""; newMessageId = "" } label: {
                            Image(systemName: "xmark.circle.fill").font(.caption).foregroundStyle(Theme.nexAgentMuted)
                        }.buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(Theme.nexAgentInset, in: RoundedRectangle(cornerRadius: 6))

                TextField("添加批注或笔记…", text: $newBody, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12.5))
                    .lineLimit(2...5)
                    .padding(8)
                    .background(Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.nexAgentBorder))

                HStack {
                    if effectiveMessageId.isEmpty {
                        Text("暂无可批注的对话消息").font(.caption2).foregroundStyle(Theme.nexAgentMuted)
                    }
                    Spacer()
                    Button(saving ? "保存中…" : "保存笔记") { Task { await saveNew() } }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.nexAgentSolid)
                        .controlSize(.small)
                        .disabled(!canSaveNew)
                }
            }
            .padding(12)
            .background(Theme.nexAgentSurface)
        }
        .task(id: session.key) { await load() }
        .onChange(of: draft, initial: true) { _, next in
            guard let next else { return }
            newMessageId = next.messageId
            let clean = next.quote.trimmingCharacters(in: .whitespacesAndNewlines)
            newQuote = String(clean.prefix(180))
            draft = nil
        }
    }

    private func noteCard(_ note: CliNote) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("#\(note.num)")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundStyle(Theme.nexAgentAccent)
                Spacer()
                Button {
                    editing = note; editBody = note.body
                } label: { Image(systemName: "pencil").font(.system(size: 11)).foregroundStyle(Theme.nexAgentMuted) }
                .buttonStyle(.plain)
                Button {
                    Task { await remove(note) }
                } label: { Image(systemName: "trash").font(.system(size: 11)).foregroundStyle(Theme.danger.opacity(0.8)) }
                .buttonStyle(.plain)
            }
            if !note.quote.isEmpty {
                Text(note.quote)
                    .font(.caption)
                    .foregroundStyle(Theme.nexAgentMuted)
                    .lineLimit(3)
                    .padding(.leading, 8)
                    .overlay(alignment: .leading) { Rectangle().fill(Theme.nexAgentAccent.opacity(0.55)).frame(width: 2) }
            }
            if editing?.id == note.id {
                if let remote = conflictRemoteBody {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("远端最新版本：").font(.caption2.weight(.semibold)).foregroundStyle(Theme.approval)
                        Text(remote).font(.caption).foregroundStyle(Theme.nexAgentMuted)
                    }
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.approvalSoft, in: RoundedRectangle(cornerRadius: 6))
                }
                TextField("编辑笔记", text: $editBody, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12.5))
                    .padding(6)
                    .background(Theme.nexAgentInset, in: RoundedRectangle(cornerRadius: 6))
                HStack {
                    Spacer()
                    Button("取消") { editing = nil; conflictRemoteBody = nil }.buttonStyle(.plain).font(.caption).foregroundStyle(Theme.nexAgentMuted)
                    Button("保存") { Task { await saveEdit(note) } }
                        .buttonStyle(.borderedProminent).tint(Theme.nexAgentSolid).controlSize(.mini)
                        .disabled(editBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            } else {
                Text(note.body).font(.system(size: 12.5)).foregroundStyle(Theme.nexAgentInk)
            }
        }
        .padding(10)
        .background(Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.nexAgentBorder))
    }

    private func load() async {
        loading = true; error = ""
        defer { loading = false }
        do { notes = try await model.notes(for: session.key) }
        catch { self.error = CliErrorText.text(for: error, fallback: "笔记读取失败") }
    }

    private func saveNew() async {
        let rawQuote = newQuote
        let rawBody = newBody
        let quote = rawQuote.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = rawBody.trimmingCharacters(in: .whitespacesAndNewlines)
        let msgId = effectiveMessageId
        guard !quote.isEmpty, !body.isEmpty, !msgId.isEmpty else { return }
        saving = true; error = ""
        let noteId: String
        if let existing = pendingNote, existing.messageId == msgId, existing.quote == quote, existing.body == body {
            noteId = existing.id
        } else {
            noteId = UUID().uuidString
            pendingNote = (noteId, msgId, quote, body)
        }
        defer { saving = false }
        let nextNum = (notes.map(\.num).max() ?? 0) + 1
        do {
            let saved = try await model.createNote(key: session.key, id: noteId, message: msgId, quote: quote, body: body, num: nextNum)
            if let idx = notes.firstIndex(where: { $0.id == saved.id }) { notes[idx] = saved } else { notes.append(saved) }
            pendingNote = nil
            if saved.quote == quote && saved.body == body {
                if newBody == rawBody { newBody = "" }
                if newQuote == rawQuote { newQuote = ""; newMessageId = "" }
            }
        } catch {
            self.error = CliErrorText.text(for: error, fallback: "笔记保存失败")
        }
    }

    private func isConflict(_ error: Error) -> Bool {
        let wrapped = CoreError.wrap(error)
        return wrapped.status == 409 || wrapped.code == "conflict"
    }

    private func saveEdit(_ note: CliNote) async {
        let body = editBody.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        error = ""
        do {
            let updated = try await model.updateNote(id: note.id, expectedVersion: note.version, body: body)
            if let idx = notes.firstIndex(where: { $0.id == note.id }) { notes[idx] = updated }
            editing = nil
            conflictRemoteBody = nil
        } catch {
            if isConflict(error) {
                if let latest = try? await model.notes(for: session.key) {
                    notes = latest
                    if let remote = latest.first(where: { $0.id == note.id }) {
                        editing = remote
                        conflictRemoteBody = remote.body
                    }
                }
                self.error = "笔记已在其他端更新，请对照上方远端内容后再次保存"
            } else {
                self.error = CliErrorText.text(for: error, fallback: "笔记更新失败")
            }
        }
    }

    private func remove(_ note: CliNote) async {
        error = ""
        do {
            try await model.deleteNote(id: note.id, expectedVersion: note.version)
            notes.removeAll { $0.id == note.id }
            if editing?.id == note.id { editing = nil }
        } catch {
            if isConflict(error) {
                if let latest = try? await model.notes(for: session.key) { notes = latest }
                self.error = "笔记已在其他端更新，已刷新列表，请再次确认删除"
            } else {
                self.error = CliErrorText.text(for: error, fallback: "笔记删除失败")
            }
        }
    }
}

// MARK: - Side Chats Pane

private struct AgentSideChatsPane: View {
    let model: CliAgentsModel
    let session: CliSession

    @State private var selectedSideKey: CliSessionKey?
    @State private var awaitingNewSideKey: CliSessionKey?
    @State private var pendingCreateRequestId: String?
    @State private var creating = false
    @State private var drafts: [CliSessionKey: String] = [:]
    @State private var pendingSendIds: [CliSessionKey: (text: String, clientMessageId: String, requestId: String)] = [:]
    @State private var sendingKey: CliSessionKey?
    @State private var error = ""

    private var sides: [CliSession] { model.sideSessions(of: session.key) }

    private var activeSide: CliSession? {
        guard let selectedSideKey else { return nil }
        return sides.first { $0.key == selectedSideKey }
    }

    private var sideBlocker: String? {
        CliSessions.deviceBlocker(model.device(session.deviceId), engine: session.engine)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                if sides.count > 1, let key = selectedSideKey {
                    Picker("侧聊", selection: Binding(get: { key }, set: { selectedSideKey = $0 })) {
                        ForEach(sides) { s in Text(model.displayTitle(for: s)).tag(s.key) }
                    }
                    .labelsHidden()
                } else {
                    Text(activeSide.map { model.displayTitle(for: $0) } ?? "侧边私聊")
                        .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.nexAgentInk).lineLimit(1)
                }
                Spacer()
                Button { Task { await createSide() } } label: {
                    Label(creating ? "创建中…" : "新建侧聊", systemImage: "plus")
                        .font(.system(size: 11.5, weight: .medium))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(creating || sideBlocker != nil)
                .help(sideBlocker ?? "基于当前会话开启独立侧边私聊")
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Theme.nexAgentSurface)
            Divider().overlay(Theme.nexAgentBorder)

            if !error.isEmpty {
                Text(error).font(.caption).foregroundStyle(Theme.danger).padding(.horizontal, 12).padding(.top, 6)
            }

            if let side = activeSide {
                let draftBinding = Binding<String>(
                    get: { drafts[side.key] ?? "" },
                    set: { drafts[side.key] = $0 }
                )
                AgentSideChatBody(
                    model: model,
                    side: side,
                    draft: draftBinding,
                    sending: sendingKey == side.key,
                    onSend: { Task { await sendSide(side) } }
                )
                .id(side.key)
            } else if selectedSideKey != nil {
                VStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("正在启动侧聊…").font(.caption).foregroundStyle(Theme.nexAgentMuted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(16)
            } else {
                VStack(spacing: 8) {
                    Text("还没有侧边私聊").font(.caption).foregroundStyle(Theme.nexAgentMuted)
                    if let blocker = sideBlocker {
                        Text(blocker).font(.caption2).foregroundStyle(Theme.nexAgentMuted)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(16)
            }
        }
        .onAppear {
            if selectedSideKey == nil { selectedSideKey = sides.first?.key }
        }
        .onChange(of: session.key) { _, _ in
            selectedSideKey = sides.first?.key
            awaitingNewSideKey = nil
            pendingCreateRequestId = nil
            error = ""
        }
        .onChange(of: sides.map(\.key)) { _, keys in
            if let awaiting = awaitingNewSideKey, keys.contains(awaiting) {
                awaitingNewSideKey = nil
            }
            if selectedSideKey == nil {
                selectedSideKey = keys.first
            } else if let current = selectedSideKey, current != awaitingNewSideKey, !keys.contains(current) {
                selectedSideKey = keys.first
            }
        }
    }

    private func createSide() async {
        creating = true; error = ""
        let reqId = pendingCreateRequestId ?? UUID().uuidString
        pendingCreateRequestId = reqId
        defer { creating = false }
        do {
            let key = try await model.forkWorkbenchSession(session, title: "侧聊", kind: .side, requestId: reqId)
            pendingCreateRequestId = nil
            awaitingNewSideKey = key
            selectedSideKey = key
        } catch {
            if let status = CoreError.wrap(error).status, (400..<500).contains(status) {
                pendingCreateRequestId = nil
            }
            self.error = CliErrorText.text(for: error, fallback: "创建侧聊失败")
        }
    }

    private func sendSide(_ side: CliSession) async {
        let targetKey = side.key
        let raw = drafts[targetKey] ?? ""
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, sendingKey == nil else { return }
        let ids: (text: String, clientMessageId: String, requestId: String)
        if let existing = pendingSendIds[targetKey], existing.text == text {
            ids = existing
        } else {
            ids = (text, UUID().uuidString, UUID().uuidString)
            pendingSendIds[targetKey] = ids
        }
        sendingKey = targetKey; error = ""
        defer { sendingKey = nil }
        do {
            let result = try await model.sendIdempotent(targetKey, text: text, clientMessageId: ids.clientMessageId, requestId: ids.requestId)
            if result.dispatched {
                pendingSendIds[targetKey] = nil
                if drafts[targetKey] == raw { drafts[targetKey] = "" }
            } else {
                pendingSendIds[targetKey] = nil
                self.error = "发送结果待确认，可重试发送"
            }
        } catch {
            if let status = CoreError.wrap(error).status, (400..<500).contains(status) {
                pendingSendIds[targetKey] = nil
            }
            self.error = CliErrorText.text(for: error, fallback: "发送失败")
        }
    }
}

/// Dedicated per-side-chat view keyed with `.id(side.key)` so `openSession` / `closeSession` always pair cleanly.
private struct AgentSideChatBody: View {
    let model: CliAgentsModel
    let side: CliSession
    @Binding var draft: String
    let sending: Bool
    let onSend: () -> Void

    var body: some View {
        let items = model.transcript(side.key).items.filter { $0.kind == .user || $0.kind == .assistant }
        let cards = model.shownCards(side.key)
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if items.isEmpty {
                        Text("侧聊已就绪，在这里提问不会干扰主会话。")
                            .font(.caption).foregroundStyle(Theme.nexAgentMuted).padding(.top, 12)
                    } else {
                        ForEach(items) { item in
                            if item.kind == .user {
                                HStack {
                                    Spacer(minLength: 28)
                                    Text(item.text)
                                        .font(.system(size: 13))
                                        .foregroundStyle(.white)
                                        .textSelection(.enabled)
                                        .padding(.horizontal, 12).padding(.vertical, 8)
                                        .background(
                                            LinearGradient(colors: [Theme.nexAgentBubbleTop, Theme.nexAgentBubbleBottom], startPoint: .topLeading, endPoint: .bottomTrailing),
                                            in: Bubble.user
                                        )
                                }
                            } else {
                                VStack(alignment: .leading, spacing: 4) {
                                    AgentByline(engine: side.engine, ts: item.ts)
                                    MarkdownText(source: item.text, fontSize: 13)
                                }
                                .padding(10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.nexAgentBorder))
                            }
                        }
                    }
                }
                .padding(12)
            }

            if !cards.isEmpty {
                Divider().overlay(Theme.nexAgentBorder)
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(cards) { record in
                            AgentRequestCard(model: model, record: record)
                        }
                    }
                    .padding(10)
                }
                .frame(maxHeight: 220)
            }

            Divider().overlay(Theme.nexAgentBorder)
            HStack(spacing: 6) {
                TextField("在侧聊中提问…", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12.5))
                    .lineLimit(1...4)
                    .padding(8)
                    .background(Theme.nexAgentSurface, in: RoundedRectangle(cornerRadius: 9))
                    .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Theme.nexAgentBorder))
                    .onSubmit { if !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { onSend() } }
                Button(action: onSend) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 22))
                        .foregroundStyle(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending ? Theme.offline : Theme.nexAgentSolid)
                }
                .buttonStyle(.plain)
                .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(10)
            .background(Theme.nexAgentSurface)
        }
        .onAppear { model.openSession(side.key) }
        .onDisappear { model.closeSession(side.key) }
    }
}

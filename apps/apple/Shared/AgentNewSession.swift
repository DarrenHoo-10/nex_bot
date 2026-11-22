import SwiftUI
import NexClientKit

// 新建会话 as a page, not a sheet: the message box with the folder, the CLI and a worktree in a row above it. A folder that
// does not exist yet is created by the computer when the session starts. Mirrors `NewSessionComposer.tsx`.

/// Where a new session runs; `create` asks the computer to make the folder first.
struct AgentDirChoice: Hashable {
    var path: String
    var create: Bool
}

/// What opens the page: a computer and folder to start from (a project's or computer's +), or nothing.
struct AgentNewTarget: Hashable, Identifiable {
    var deviceId: String?
    var cwd: String?
    let id = UUID()
}

private let startable: [CliEngine] = [.claude, .codex]
func agentName(_ engine: CliEngine) -> String { engine == .claude ? "Claude Code" : "Codex" }

/// A rounded chip in the row above the box.
private struct AgentPickChip<Label: View>: View {
    var active = false
    var dashed = false
    @ViewBuilder let label: () -> Label
    var body: some View {
        HStack(spacing: 5) { label() }
            .font(.system(size: 12.5, weight: .medium))
            .foregroundStyle(dashed ? Theme.muted : Theme.foreground)
            .lineLimit(1)
            .padding(.horizontal, 10).frame(height: 28)
            .background(active ? Theme.successSoft : Theme.card, in: Capsule())
            .overlay(Capsule().strokeBorder(active ? Theme.success : Theme.border, style: StrokeStyle(lineWidth: 1, dash: dashed ? [3, 2] : [])))
    }
}

struct AgentNewSessionPage: View {
    let model: CliAgentsModel
    let target: AgentNewTarget
    let started: (CliSessionKey) -> Void
    @State private var deviceId = ""
    @State private var engine: CliEngine = .claude
    @State private var dir: AgentDirChoice?
    @State private var git = false
    @State private var branch: String?
    @State private var message = ""
    @State private var chosenModel = ""
    @State private var effort = ""
    @State private var catalog = CliModelCatalog()
    @State private var browsing = false
    @State private var editingBranch = false
    @FocusState private var focused: Bool

    private var device: CliDevice? { model.device(deviceId) }
    private var engines: [CliEngine] { device?.cliAgents?.engines ?? [] }
    private var blocker: String? { CliSessions.deviceBlocker(device) }
    private var branchError: String? { branch.flatMap { CliLaunches.branchProblem($0) } }
    private var text: String { message.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var tooLong: Bool { text.utf8.count > CoreClient.cliMaxSendBytes }
    private var canChoose: Bool { device?.cliAgents?.features.contains("launchOptions") == true }
    private var fallbackModel: String { catalog.current ?? "" }
    private var offered: [String] { CliLaunches.efforts(engine: engine, models: catalog.models, model: chosenModel.isEmpty ? fallbackModel : chosenModel) }
    private var ready: Bool { blocker == nil && device != nil && engines.contains(engine) && dir != nil && branchError == nil && !tooLong }
    private var status: String? { blocker ?? branchError ?? (tooLong ? "内容太长" : nil) ?? (dir == nil ? "先选择工作目录" : nil) }

    var body: some View {
        VStack(spacing: 0) {
            #if os(macOS)
            HStack { Text("新建会话").font(.system(size: 15, weight: .semibold)); Spacer() }.padding(14)
            Divider().opacity(0.4)
            #endif
            Spacer(minLength: 20)
            VStack(alignment: .leading, spacing: 8) {
                options
                box
            }
            .frame(maxWidth: 780)
            .padding(.horizontal, 20)
            Spacer(minLength: 20)
            Spacer(minLength: 20)
        }
        #if os(iOS)
        .navigationTitle("新建会话")
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .onAppear(perform: setUp)
        .onChange(of: deviceId) { _, _ in if !engines.contains(engine), let first = engines.first { engine = first } }
        .task(id: "\(deviceId)\n\(engine.rawValue)") {
            chosenModel = ""; effort = ""
            catalog = await model.models(deviceId: deviceId, engine: engine)
        }
        .task(id: dir) { await checkGit() }
        .onChange(of: chosenModel) { _, _ in if !effort.isEmpty, !offered.contains(effort) { effort = "" } }
    }

    private func setUp() {
        guard deviceId.isEmpty else { return }
        deviceId = target.deviceId.flatMap { model.device($0) }?.id
            ?? model.devices.first { CliSessions.deviceBlocker($0) == nil }?.id ?? model.devices.first?.id ?? ""
        if let first = engines.first, !engines.contains(engine) { engine = first }
        let start = target.cwd ?? CliSessions.recentCwds(model.sessions, deviceId: deviceId).first
        dir = start.map { AgentDirChoice(path: $0, create: false) }
        focused = true
    }

    /// A worktree needs a Git folder that exists.
    private func checkGit() async {
        guard let dir, !dir.create else { git = false; branch = nil; return }
        let listing = try? await model.dirs(deviceId: deviceId, path: dir.path)
        git = listing?.git ?? false
        if !git { branch = nil }
    }

    private var options: some View {
        HStack(spacing: 6) {
            Button { browsing = true } label: {
                AgentPickChip(active: browsing, dashed: dir == nil) {
                    Image(systemName: "folder").foregroundStyle(Theme.muted)
                    Text(dir.map { CliPaths.name($0.path) } ?? "选择目录")
                    if dir?.create == true { Text("新建").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(Theme.success).padding(.horizontal, 5).padding(.vertical, 1).background(Theme.successSoft, in: RoundedRectangle(cornerRadius: 5)) }
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.muted)
                }
            }
            .buttonStyle(.plain)
            .help(dir.map { ($0.create ? "将新建 " : "") + $0.path } ?? "选择工作目录")
            .accessibilityLabel("工作目录")
            .popover(isPresented: $browsing, arrowEdge: .bottom) {
                AgentDirectoryBrowser(model: model, deviceId: $deviceId, start: dir) { choice in
                    dir = choice; browsing = false
                }
                #if os(iOS)
                .presentationDetents([.medium, .large])
                #endif
            }

            Menu {
                ForEach(startable, id: \.self) { e in
                    let installed = engines.contains(e)
                    Button { engine = e } label: {
                        if e == engine { Label(agentName(e), systemImage: "checkmark") } else { Text(installed ? agentName(e) : agentName(e) + " · 未安装") }
                    }
                    .disabled(!installed)
                }
            } label: {
                AgentPickChip {
                    Image(systemName: "terminal").foregroundStyle(Theme.muted)
                    Text(agentName(engine))
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.muted)
                }
            }
            .menuStyle(.button).buttonStyle(.plain).fixedSize()
            .accessibilityLabel("运行工具")

            if git {
                // the "Worktree" checkbox: checked, the session starts in a new worktree on nexagent/<random>
                Button { if branch == nil { branch = CliLaunches.randomBranch() } else { branch = nil; editingBranch = false } } label: {
                    AgentPickChip(dashed: branch == nil) {
                        Image(systemName: branch == nil ? "square" : "checkmark.square.fill")
                            .foregroundStyle(branch == nil ? Theme.muted : Theme.identityAccent)
                        Text("Worktree")
                    }
                }
                .buttonStyle(.plain).help("在新的工作树里运行")
                .accessibilityLabel("Worktree").accessibilityValue(branch == nil ? "未选中" : "已选中")
                if let current = branch {
                    Button { editingBranch = true } label: {
                        AgentPickChip(active: true) {
                            Image(systemName: "arrow.triangle.branch").foregroundStyle(Theme.muted)
                            Text(current.isEmpty ? "分支" : current).font(.system(size: 12, design: .monospaced))
                        }
                    }
                    .buttonStyle(.plain).accessibilityLabel("分支名称")
                    .popover(isPresented: $editingBranch, arrowEdge: .bottom) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("新工作树的分支").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                            TextField("分支名称", text: Binding(get: { branch ?? "" }, set: { branch = $0 }))
                                .textFieldStyle(.roundedBorder).font(.system(size: 13, design: .monospaced)).autocorrectionDisabled()
                                #if os(iOS)
                                .textInputAutocapitalization(.never)
                                #endif
                                .onSubmit { editingBranch = false }
                            if let branchError { Text(branchError).font(.caption).foregroundStyle(Theme.danger) }
                        }
                        .padding(14).frame(width: 280)
                        #if os(iOS)
                        .presentationCompactAdaptation(.popover)
                        #endif
                    }
                }
            }
            Spacer(minLength: 6)
            // only what needs attention; the folder's full path is on its chip
            if let status { Text(status).font(.caption).foregroundStyle(Theme.danger).lineLimit(1) }
        }
        .padding(.horizontal, 4)
    }

    private var box: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("要做什么？", text: $message, axis: .vertical)
                .lineLimit(3...8).textFieldStyle(.plain).font(.system(size: 15))
                .focused($focused)
                .disabled(blocker != nil)
                .onSubmit(start)
            HStack(spacing: 8) {
                Spacer()
                if canChoose {
                    // compact like the session's own model button: the name of the choice, the list on click
                    Menu {
                        Button { chosenModel = "" } label: { menuLabel(fallbackModel.isEmpty ? "默认" : "默认（\(label(fallbackModel))）", on: chosenModel.isEmpty) }
                        ForEach(catalog.models) { row in Button { chosenModel = row.id } label: { menuLabel(row.label, on: chosenModel == row.id) } }
                        if !offered.isEmpty {
                            Divider()
                            Menu("推理强度") {
                                ForEach([""] + offered, id: \.self) { level in Button { effort = level } label: { menuLabel(CliLaunches.effortLabel(level), on: effort == level) } }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text(chosenModel.isEmpty ? (fallbackModel.isEmpty ? "默认模型" : label(fallbackModel)) : label(chosenModel)).lineLimit(1)
                            if !effort.isEmpty { Text(CliLaunches.effortLabel(effort)).foregroundStyle(Theme.muted) }
                            Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.muted)
                        }
                        .font(.system(size: 12.5)).foregroundStyle(Theme.foreground)
                        .frame(maxWidth: 220, alignment: .trailing)
                    }
                    .menuStyle(.button).buttonStyle(.plain).fixedSize()
                    .accessibilityLabel("模型设置")
                }
                Button(action: start) { Image(systemName: "arrow.up.circle.fill").font(.system(size: 28)) }
                    .buttonStyle(.plain).foregroundStyle(ready ? Theme.identityAccent : Theme.offline)
                    .disabled(!ready).accessibilityLabel("开始会话")
            }
        }
        .padding(14)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.border))
        .shadow(color: Theme.shadowInk.opacity(0.06), radius: 10, y: 3)
    }

    private func label(_ id: String) -> String { catalog.models.first { $0.id == id }?.label ?? id }

    @ViewBuilder private func menuLabel(_ text: String, on: Bool) -> some View {
        if on { Label(text, systemImage: "checkmark") } else { Text(text) }
    }

    private func start() {
        guard ready, let dir else { return }
        let key = model.launch(CliLaunchRequest(deviceId: deviceId, engine: engine, cwd: dir.path, branch: branch?.trimmingCharacters(in: .whitespacesAndNewlines),
                                                message: text, model: canChoose ? chosenModel : "", effort: canChoose ? effort : "", createDir: dir.create))
        started(key)
    }
}

/// Browse a computer's folders: up, breadcrumbs, into a folder, search, a typed path or a new folder name.
struct AgentDirectoryBrowser: View {
    let model: CliAgentsModel
    @Binding var deviceId: String
    let start: AgentDirChoice?
    let choose: (AgentDirChoice) -> Void
    @State private var current = ""
    @State private var listing: CliDirListing?
    @State private var loading = false
    @State private var query = ""
    @State private var known: [String: Bool] = [:]
    @State private var began = false
    @State private var hovered: String?

    private var recents: [String] { CliSessions.recentCwds(model.sessions, deviceId: deviceId) }
    private var parsed: CliPaths.Query { CliPaths.read(query, current: current) }
    private var missing: Bool { !current.isEmpty && listing?.path == current && listing?.exists == false }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            devices
            HStack(spacing: 6) {
                Button { if let up = CliPaths.parent(current) { go(up) } else { go("") } } label: { Image(systemName: "arrow.up").frame(width: 26, height: 26) }
                    .buttonStyle(.bordered).disabled(current.isEmpty).accessibilityLabel("上一级")
                ScrollViewReader { proxy in
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 2) {
                            Button("全部") { go("") }.buttonStyle(.plain).font(.caption).foregroundStyle(current.isEmpty ? Theme.foreground : Theme.muted)
                            ForEach(Array(CliPaths.crumbs(current).enumerated()), id: \.offset) { index, crumb in
                                Image(systemName: "chevron.right").font(.system(size: 8)).foregroundStyle(Theme.muted)
                                Button(crumb.label) { go(crumb.path) }.buttonStyle(.plain).font(.caption.weight(index == CliPaths.crumbs(current).count - 1 ? .semibold : .regular))
                                    .foregroundStyle(index == CliPaths.crumbs(current).count - 1 ? Theme.foreground : Theme.muted).id(index)
                            }
                        }
                    }
                    // a deep folder keeps its own name in view
                    .onChange(of: current) { _, _ in proxy.scrollTo(CliPaths.crumbs(current).count - 1, anchor: .trailing) }
                }
            }
            TextField(current.isEmpty ? "搜索最近目录，或输入路径" : "搜索，或输入新文件夹名、路径", text: $query)
                .textFieldStyle(.roundedBorder).autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .onSubmit(submit)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    if loading && rows.isEmpty { ProgressView().frame(maxWidth: .infinity).padding(.top, 20) }
                    if missing && query.isEmpty { Text("这个文件夹还不存在，开始会话时会新建").font(.caption).foregroundStyle(Theme.muted).padding(8) }
                    ForEach(rows) { row in rowView(row) }
                    if !loading, rows.isEmpty, !current.isEmpty, !missing {
                        Text(query.isEmpty ? "没有子文件夹" : "没有匹配的文件夹").font(.caption).foregroundStyle(Theme.muted).padding(8)
                    }
                }
            }
            .frame(minHeight: 160)
            Divider()
            HStack(spacing: 10) {
                Text(current.isEmpty ? "选择一个文件夹" : current).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted)
                    .lineLimit(1).truncationMode(.head)
                Spacer()
                Button(missing ? "新建并使用" : "使用此目录") { choose(AgentDirChoice(path: current, create: missing)) }
                    .buttonStyle(.borderedProminent).tint(Theme.identityAccent).disabled(current.isEmpty)
            }
        }
        .padding(14)
        #if os(macOS)
        .frame(width: 440, height: 460)
        #endif
        .onAppear {
            guard !began else { return }
            began = true
            if let start { current = start.create ? (CliPaths.parent(start.path) ?? "") : start.path }
        }
        .task(id: "\(deviceId)\n\(current)") { await load() }
        .task(id: { if case .path(let p) = parsed { return p } else { return "" } }()) { await lookUp() }
    }

    @ViewBuilder private var devices: some View {
        if model.devices.count > 1 {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(model.devices) { d in
                        let usable = CliSessions.deviceBlocker(d) == nil
                        Button { deviceId = d.id; go("") } label: {
                            Label(d.name + (d.online ? "" : "（离线）"), systemImage: "desktopcomputer").font(.caption)
                                .padding(.horizontal, 9).padding(.vertical, 4)
                                .background(d.id == deviceId ? Theme.successSoft : .clear, in: Capsule())
                                .overlay(Capsule().strokeBorder(d.id == deviceId ? Theme.success : Theme.border))
                        }
                        .buttonStyle(.plain).disabled(!usable)
                    }
                }
            }
        } else if let d = model.device(deviceId) {
            Label(d.name, systemImage: "desktopcomputer").font(.caption).foregroundStyle(Theme.muted)
        }
    }

    private struct Row: Identifiable {
        enum Kind { case folder(git: Bool, recent: Bool), go, create }
        let kind: Kind
        let path: String
        let name: String
        var id: String { "\(name)|\(path)" }
    }

    private var rows: [Row] {
        if case .path(let path) = parsed {
            return [Row(kind: known[path] == false ? .create : .go, path: path, name: path)]
        }
        guard case .filter(let raw) = parsed else { return [] }
        let text = raw.lowercased()
        let matches: (String) -> Bool = { text.isEmpty || $0.lowercased().contains(text) }
        var out: [Row] = []
        // the top view leads with recent folders; inside a folder they only show while searching
        if current.isEmpty || !text.isEmpty {
            out += recents.filter { matches(CliPaths.name($0)) }.prefix(current.isEmpty ? 6 : 3).map { Row(kind: .folder(git: false, recent: true), path: $0, name: CliPaths.name($0)) }
        }
        if listing?.path == current {
            out += (listing?.entries ?? []).filter { matches($0.name) }.map { Row(kind: .folder(git: $0.git, recent: false), path: $0.path, name: $0.name) }
        }
        if !current.isEmpty, !raw.isEmpty, CliPaths.validName(raw), !(listing?.entries ?? []).contains(where: { $0.name.lowercased() == text }) {
            out.append(Row(kind: .create, path: CliPaths.join(current, raw), name: raw))
        }
        return out
    }

    @ViewBuilder private func rowView(_ row: Row) -> some View {
        HStack(spacing: 8) {
            Button { act(row) } label: {
                HStack(spacing: 8) {
                    switch row.kind {
                    case .create:
                        Image(systemName: "folder.badge.plus").foregroundStyle(Theme.success)
                        (Text("新建文件夹 ") + Text(row.name).bold()).foregroundStyle(Theme.foreground)
                    case .go:
                        Image(systemName: "arrow.right").foregroundStyle(Theme.muted)
                        (Text("前往 ") + Text(row.path).bold()).lineLimit(1)
                    case .folder(let git, let recent):
                        Image(systemName: recent ? "clock" : git ? "folder.fill.badge.gearshape" : "folder").foregroundStyle(Theme.muted)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(row.name).lineLimit(1)
                            if recent { Text(row.path).font(.caption2).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.head) }
                        }
                        if git { Text("Git").font(.system(size: 10)).foregroundStyle(Theme.muted).padding(.horizontal, 5).background(Theme.wash, in: RoundedRectangle(cornerRadius: 4)) }
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.right").font(.system(size: 10)).foregroundStyle(Theme.muted.opacity(0.6))
                    }
                }
                .font(.system(size: 13))
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if case .folder = row.kind {
                Button { choose(AgentDirChoice(path: row.path, create: false)) } label: { Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold)) }
                    .buttonStyle(.plain).foregroundStyle(Theme.identityAccent).help("使用这个目录").accessibilityLabel("使用 \(row.path)")
                    #if os(macOS)
                    .opacity(hovered == row.id ? 1 : 0)
                    #endif
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 8).fill(hovered == row.id ? Theme.wash : Color.clear))
        .onHover { inside in hovered = inside ? row.id : (hovered == row.id ? nil : hovered) }
    }

    private func act(_ row: Row) {
        switch row.kind {
        case .folder, .go: go(row.path)
        case .create: choose(AgentDirChoice(path: row.path, create: true))
        }
    }

    private func go(_ path: String) { current = path; query = "" }

    private func submit() {
        if let first = rows.first { act(first) } else if !current.isEmpty { choose(AgentDirChoice(path: current, create: missing)) }
    }

    private func load() async {
        loading = true
        let path = current
        let next = (try? await model.dirs(deviceId: deviceId, path: path)) ?? CliDirListing(path: path, parent: CliPaths.parent(path), exists: false)
        if path == current { listing = next; loading = false }
    }

    private func lookUp() async {
        guard case .path(let path) = parsed, known[path] == nil else { return }
        if let found = try? await model.dirs(deviceId: deviceId, path: path) { known[path] = found.exists }
    }
}

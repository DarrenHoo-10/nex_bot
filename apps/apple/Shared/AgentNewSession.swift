import SwiftUI
import NexClientKit

// 新建会话 as a page, not a sheet: the message box with three tabs in a row above it (the folder, the CLI, and the
// session options: worktree, branch, permissions). A folder that
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

private let startable: [CliEngine] = [.claude, .codex, .zcode, .agy]
func agentName(_ engine: CliEngine) -> String { engine == .claude ? "Claude Code" : engine.label }

/// One of the three tabs in the row above the box: project, CLI, session options.
private struct AgentPickChip<Label: View>: View {
    var active = false
    var dashed = false
    @ViewBuilder let label: () -> Label
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        HStack(spacing: 5) { label() }
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(dashed ? Theme.muted : Theme.foreground)
            .lineLimit(1)
            .padding(.horizontal, 10).frame(height: 32)
            .background(active ? Theme.nexAgentSoft : Theme.card, in: shape)
            .overlay(shape.strokeBorder(active ? Theme.nexAgentAccent : Theme.border, style: StrokeStyle(lineWidth: 1, dash: dashed ? [3, 2] : [])))
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
    @State private var branchInfo: CliGitBranches?
    @State private var selectedBranch = ""
    @State private var baseBranch = ""
    @State private var branch: String?
    @State private var message = ""
    @State private var chosenModel = ""
    @State private var effort = ""
    /// each CLI keeps its own choice: full access by default, Antigravity asking (its full access is answered by the executor)
    @State private var modeOf: [CliEngine: CliPermissionMode] = [:]
    @State private var images: [CliImageUpload] = []
    @State private var imageError = ""
    #if os(iOS)
    @Environment(\.dismiss) private var dismiss
    #endif
    @State private var catalog = CliModelCatalog()
    private enum Picker { case directory, options, model, skills }
    @State private var picker: Picker?
    @FocusState private var focused: Bool

    private func presenting(_ target: Picker) -> Binding<Bool> {
        Binding(get: { picker == target }, set: { open in
            if open { picker = target }
            else if picker == target { picker = nil }
        })
    }

    private var device: CliDevice? { model.device(deviceId) }
    private var engines: [CliEngine] { startable.filter { device?.cliAgents?.engines.contains($0) == true && CliSessions.deviceBlocker(device, engine: $0) == nil } }
    private var blocker: String? { CliSessions.deviceBlocker(device, engine: engine) }
    private var permissionModes: [CliPermissionMode] { CliPermissions.modes(engine: engine, features: device?.cliAgents?.features ?? []) }
    private var selectedPermissions: CliPermissionMode {
        let preferred = modeOf[engine] ?? (engine == .agy ? .ask : .full)
        if permissionModes.contains(preferred) { return preferred }
        return permissionModes.contains(.full) ? .full : permissionModes.first ?? .full
    }
    private var canPickBranch: Bool { device?.cliAgents?.features.contains("gitBranch") == true }
    private var switchingInPlace: Bool { branch == nil && !selectedBranch.isEmpty && selectedBranch != branchInfo?.current }
    private var dirtySwitchError: String? { switchingInPlace && branchInfo?.dirty == true ? "当前目录有未提交改动，请先提交或改用 Worktree" : nil }
    private var branchError: String? { branch.flatMap { CliLaunches.branchProblem($0) } ?? dirtySwitchError }
    private var optionsHelp: String {
        if let branch { return baseBranch.isEmpty ? (branch.isEmpty ? "Worktree" : branch) : "Worktree（基于 \(baseBranch)）· \(branch)" }
        return selectedBranch.isEmpty ? "分支、Worktree 与权限" : "分支 · \(selectedBranch)"
    }
    private var text: String { message.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var tooLong: Bool { text.utf8.count > CoreClient.cliMaxSendBytes }
    private var canChoose: Bool { device?.cliAgents?.features.contains("launchOptions") == true }
    private var canChoosePermissions: Bool { !permissionModes.isEmpty }
    private var fallbackModel: String { catalog.current ?? "" }
    private var offered: [String] { CliLaunches.efforts(engine: engine, models: catalog.models, model: chosenModel.isEmpty ? fallbackModel : chosenModel) }
    private var effortLevels: [String] { engine == .agy || engine == .zcode ? offered : CliLaunches.reasoningLevels }
    private var selectedEffort: String { CliLaunches.reasoningChoice(effort.isEmpty && (engine == .agy || engine == .zcode) ? catalog.currentEffort : effort) }
    private var resolvedEffort: String? { CliLaunches.resolveEffort(engine: engine, offered: offered, preferred: selectedEffort) }
    private var ready: Bool { blocker == nil && device != nil && engines.contains(engine) && dir != nil && branchError == nil && !tooLong }
    private var status: String? {
        if deviceId.isEmpty { return "等待电脑连接" }
        return blocker ?? branchError ?? (tooLong ? "内容太长" : nil) ?? (dir == nil ? "先选择工作目录" : nil)
    }

    var body: some View {
        VStack(spacing: 0) {
            #if os(macOS)
            HStack { Text("新建会话").font(.system(size: 15, weight: .semibold)); Spacer() }.padding(14)
            Divider().opacity(0.4)
            #endif
            Spacer(minLength: 20)
            VStack(alignment: .leading, spacing: 8) {
                options
                // only what needs attention; the folder's full path is on its tab
                if let status { Text(status).font(.caption).foregroundStyle(Theme.danger).lineLimit(1).padding(.horizontal, 4) }
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
        .navigationBarBackButtonHidden()
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { dismiss() } label: { Image(systemName: "sidebar.left") }
                    .accessibilityLabel("打开会话目录")
            }
        }
        #endif
        .sheet(isPresented: presenting(.skills)) {
            ChatSkillPicker(load: { try await model.skills(deviceId: deviceId, engine: engine, cwd: dir?.path ?? "") }) {
                message = $0.adding(to: message, engine: engine); focused = true
            }
        }
        #if os(iOS)
        .sheet(isPresented: presenting(.directory)) {
            AgentDirectoryBrowser(model: model, deviceId: $deviceId, start: dir) { choice in
                dir = choice; picker = nil
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        #endif
        .onAppear { setUp(); focused = true }
        .onChange(of: model.devices.map(\.id)) { _, _ in setUp() }
        .onChange(of: deviceId) { previous, _ in if !previous.isEmpty { dir = nil } }
        .onChange(of: engines) { _, available in
            if !available.contains(engine), let first = available.first { engine = first }
        }
        .task(id: "\(deviceId)\n\(engine.rawValue)") {
            chosenModel = ""; effort = ""
            guard !deviceId.isEmpty else { return }
            catalog = await model.models(deviceId: deviceId, engine: engine)
        }
        .task(id: "\(deviceId)\n\(dir?.path ?? "")\n\(dir?.create ?? false)\n\(canPickBranch)") { await checkGit() }
    }

    private func setUp() {
        guard deviceId.isEmpty else { return }
        let preferred = target.deviceId.flatMap { model.device($0) }
            ?? model.devices.first { CliSessions.deviceBlocker($0) == nil }
            ?? model.devices.first { $0.online }
            ?? model.devices.first
        guard let preferred else { return }
        deviceId = preferred.id
        if let first = engines.first, !engines.contains(engine) { engine = first }
        let matchingCwd = target.deviceId == nil || target.deviceId == deviceId ? target.cwd : nil
        let start = matchingCwd ?? CliSessions.recentCwds(model.sessions, deviceId: deviceId).first
        dir = start.map { AgentDirChoice(path: $0, create: false) }
    }

    /// A worktree or branch switch needs a Git folder that exists.
    private func checkGit() async {
        branchInfo = nil
        selectedBranch = ""
        baseBranch = ""
        guard let dir, !dir.create else { git = false; branch = nil; return }
        let listing = try? await model.dirs(deviceId: deviceId, path: dir.path)
        guard !Task.isCancelled else { return }
        if listing?.git == true { git = true }
        else if !canPickBranch { git = false; branch = nil }
        guard canPickBranch else { return }
        if let info = await model.branches(deviceId: deviceId, cwd: dir.path) {
            guard !Task.isCancelled else { return }
            branchInfo = info
            if info.git {
                git = true
                let initial = info.current.flatMap { info.branches.contains($0) ? $0 : nil } ?? ""
                selectedBranch = initial
                baseBranch = initial
            } else {
                git = false
                branch = nil
            }
        } else if !Task.isCancelled, listing?.git != true {
            git = false
            branch = nil
        }
    }

    private var options: some View {
        HStack(spacing: 8) {
            Button { picker = picker == .directory ? nil : .directory } label: {
                AgentPickChip(active: picker == .directory, dashed: dir == nil) {
                    Image(systemName: "folder").foregroundStyle(Theme.muted)
                    Text(dir.map { CliPaths.name($0.path) } ?? "选择目录")
                    if dir?.create == true { Text("新建").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(Theme.success).padding(.horizontal, 5).padding(.vertical, 1).background(Theme.successSoft, in: RoundedRectangle(cornerRadius: 5)) }
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.muted)
                }
            }
            .buttonStyle(.plain)
            .disabled(deviceId.isEmpty)
            .help(dir.map { ($0.create ? "将新建 " : "") + $0.path } ?? "选择工作目录")
            .accessibilityLabel("工作目录")
            #if os(macOS)
            .popover(isPresented: presenting(.directory), arrowEdge: .bottom) {
                AgentDirectoryBrowser(model: model, deviceId: $deviceId, start: dir) { choice in
                    dir = choice; picker = nil
                }
            }
            #endif

            Menu {
                ForEach(startable, id: \.self) { e in
                    let installed = engines.contains(e)
                    Button { engine = e } label: {
                        if e == engine && installed { Label(agentName(e), systemImage: "checkmark") }
                        else { Text(installed ? agentName(e) : agentName(e) + (e == .agy && device?.cliAgents?.agyNeedsUpdate == true ? " · 需更新" : " · 不可用")) }
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

            // the third tab: branch, worktree and permissions, in one panel
            Button { picker = picker == .options ? nil : .options } label: {
                AgentPickChip(active: picker == .options) {
                    Image(systemName: "arrow.triangle.branch").foregroundStyle(branch != nil || switchingInPlace ? Theme.nexAgentAccent : Theme.muted)
                    if branch != nil {
                        Text("Worktree")
                    } else if !selectedBranch.isEmpty {
                        Text(selectedBranch).truncationMode(.middle)
                    }
                    if canChoosePermissions && selectedPermissions != .full {
                        Image(systemName: "exclamationmark.shield").foregroundStyle(Theme.approval)
                    }
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.muted)
                }
            }
            .buttonStyle(.plain)
            .help(optionsHelp)
            .accessibilityLabel("会话选项")
            .popover(isPresented: presenting(.options), arrowEdge: .bottom) {
                sessionOptions
                    .padding(14).frame(width: 290)
                    #if os(iOS)
                    .presentationCompactAdaptation(.popover)
                    #endif
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
    }

    /// Branch selection (in-place switch when clean, or a new worktree off a chosen base branch) and,
    /// where the CLI supports it, permissions: full access (the default) or the CLI's own prompts, which arrive as cards.
    private var sessionOptions: some View {
        let branches = branchInfo?.branches ?? []
        let current = branchInfo?.current
        let hasCurrentOption = current.map { branches.contains($0) } == true
        return VStack(alignment: .leading, spacing: 14) {
            Toggle(isOn: Binding(get: { branch != nil }, set: { on in
                if on {
                    branch = CliLaunches.randomBranch()
                    baseBranch = !selectedBranch.isEmpty ? selectedBranch : (hasCurrentOption ? (current ?? "") : "")
                } else {
                    branch = nil
                }
            })) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Worktree").font(.system(size: 13, weight: .semibold))
                    if !git { Text("不是 Git 仓库").font(.caption).foregroundStyle(Theme.muted) }
                }
            }
            .toggleStyle(.switch).tint(Theme.nexAgentAccent).disabled(!git)
            if git && branch == nil && !branches.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(branchInfo?.dirty == true ? "分支 · 有未提交改动" : "分支")
                        .font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                    SwiftUI.Picker("选择分支", selection: $selectedBranch) {
                        if !hasCurrentOption { Text("当前 HEAD").tag("") }
                        ForEach(branches, id: \.self) { name in
                            Text(name == current ? "\(name)（当前）" : name).tag(name)
                        }
                    }
                    .pickerStyle(.menu).labelsHidden()
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if branch != nil {
                if !branches.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("基准分支").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                        SwiftUI.Picker("基准分支", selection: $baseBranch) {
                            if !hasCurrentOption { Text("当前 HEAD").tag("") }
                            ForEach(branches, id: \.self) { name in
                                Text(name == current ? "\(name)（当前）" : name).tag(name)
                            }
                        }
                        .pickerStyle(.menu).labelsHidden()
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("新分支").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                    TextField("新分支名称", text: Binding(get: { branch ?? "" }, set: { branch = $0 }))
                        .textFieldStyle(.roundedBorder).font(.system(size: 13, design: .monospaced)).autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .onSubmit { picker = nil }
                }
            }
            if let branchError { Text(branchError).font(.caption).foregroundStyle(Theme.danger) }
            if canChoosePermissions {
                VStack(alignment: .leading, spacing: 6) {
                    Text("权限").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                    SwiftUI.Picker("权限", selection: Binding(get: { selectedPermissions }, set: { modeOf[engine] = $0 })) {
                        ForEach(permissionModes, id: \.self) { mode in Text(CliPermissions.label(engine: engine, mode: mode)).tag(mode) }
                    }
                    .pickerStyle(.inline).labelsHidden()
                }
            }
        }
    }

    private var box: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("要做什么？", text: $message, axis: .vertical)
                .lineLimit(3...8).textFieldStyle(.plain).font(.system(size: 15))
                .focused($focused)
                .disabled(blocker != nil)
                .onSubmit(start)
            AgentImageDrafts(images: $images)
            if !imageError.isEmpty { Text(imageError).font(.caption).foregroundStyle(Theme.danger) }
            #if os(macOS)
            if canChoose && !effortLevels.isEmpty {
                ChatEffortChoices(levels: effortLevels, selection: selectedEffort, label: CliLaunches.effortLabel,
                                  tint: Theme.nexAgentAccent, choose: { effort = $0 })
            }
            #endif
            HStack(spacing: 8) {
                #if os(iOS)
                AgentComposerAdd(images: $images, error: $imageError, openSkills: engine == .claude || engine == .codex || engine == .zcode ? { picker = .skills } : nil, openModels: canChoose ? { picker = .model } : nil)
                    .popover(isPresented: presenting(.model), arrowEdge: .bottom) {
                        AgentComposerModelOptions(catalog: catalog, model: $chosenModel, levels: effortLevels, selection: selectedEffort) { effort = $0 }
                            .frame(width: 310, height: 360)
                            .presentationCompactAdaptation(.popover)
                    }
                #else
                AgentComposerAdd(images: $images, error: $imageError, openSkills: engine == .claude || engine == .codex || engine == .zcode ? { picker = .skills } : nil)
                #endif
                Spacer(minLength: 0)
                #if os(macOS)
                if canChoose {
                    // compact like the session's own model button: the name of the choice, the list on click
                    Menu {
                        Button { chosenModel = "" } label: { menuLabel(fallbackModel.isEmpty ? "默认" : "默认（\(label(fallbackModel))）", on: chosenModel.isEmpty) }
                        ForEach(catalog.models) { row in Button { chosenModel = row.id } label: { menuLabel(row.label, on: chosenModel == row.id) } }
                    } label: {
                        HStack(spacing: 4) {
                            Text(chosenModel.isEmpty ? (fallbackModel.isEmpty ? "默认模型" : label(fallbackModel)) : label(chosenModel)).lineLimit(1)
                            Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.muted).fixedSize()
                        }
                        .font(.system(size: 12.5)).foregroundStyle(Theme.foreground)
                    }
                    .menuStyle(.button).buttonStyle(.plain)
                    .frame(maxWidth: 220, alignment: .trailing)
                    .accessibilityLabel("模型设置")
                }
                #endif
                Button(action: start) { Image(systemName: "arrow.up.circle.fill").font(.system(size: 28)) }
                    .buttonStyle(.plain).foregroundStyle(ready ? Theme.nexAgentSolid : Theme.offline)
                    .fixedSize().disabled(!ready).accessibilityLabel("开始会话")
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
        let wtBranch = branch?.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = model.launch(CliLaunchRequest(deviceId: deviceId, engine: engine, cwd: dir.path,
                                                branch: wtBranch,
                                                message: text, model: canChoose ? chosenModel : "", effort: canChoose ? resolvedEffort ?? "" : "", createDir: dir.create,
                                                permissions: canChoosePermissions ? selectedPermissions : nil, images: images,
                                                baseBranch: wtBranch != nil && !baseBranch.isEmpty ? baseBranch : nil,
                                                switchBranch: wtBranch == nil && switchingInPlace ? selectedBranch : nil))
        started(key)
    }
}

#if os(iOS)
struct AgentComposerModelOptions: View {
    let catalog: CliModelCatalog
    @Binding var model: String
    let levels: [String]
    let selection: String?
    let chooseEffort: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if !levels.isEmpty {
                    ChatEffortChoices(levels: levels, selection: selection, label: CliLaunches.effortLabel,
                                      tint: Theme.nexAgentAccent, choose: chooseEffort)
                }
                row("", title: "默认模型")
                ForEach(catalog.models) { option in row(option.id, title: option.label) }
            }
            .navigationTitle("模型").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ id: String, title: String) -> some View {
        Button { model = id } label: {
            HStack {
                Text(title).foregroundStyle(Theme.foreground)
                Spacer()
                if model == id { Image(systemName: "checkmark").foregroundStyle(Theme.nexAgentAccent) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(model == id ? .isSelected : [])
    }
}
#endif

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
    #if os(iOS)
    @Environment(\.dismiss) private var dismiss
    #endif

    private var recents: [String] { CliSessions.recentCwds(model.sessions, deviceId: deviceId) }
    private var parsed: CliPaths.Query { CliPaths.read(query, current: current) }
    private var missing: Bool { !current.isEmpty && listing?.path == current && listing?.exists == false }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                #if os(iOS)
                HStack(spacing: 8) {
                    Text("选择目录").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.foreground)
                    if model.devices.count == 1, let d = model.device(deviceId) {
                        Label(d.name, systemImage: "desktopcomputer")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(Theme.muted)
                            .lineLimit(1)
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Theme.secondary, in: Capsule())
                    }
                    Spacer(minLength: 4)
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Theme.muted)
                            .frame(width: 28, height: 28)
                            .background(Theme.secondary, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("关闭")
                }
                #endif
                devices
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").font(.system(size: 13)).foregroundStyle(Theme.muted)
                    TextField(current.isEmpty ? "搜索最近目录或输入路径" : "搜索、新建文件夹或输入路径", text: $query)
                        .textFieldStyle(.plain)
                        .font(.system(size: 13.5))
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .onSubmit(submit)
                    if !query.isEmpty {
                        Button { query = "" } label: {
                            Image(systemName: "xmark.circle.fill").font(.system(size: 14)).foregroundStyle(Theme.muted)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("清空搜索")
                    }
                }
                .padding(.horizontal, 11)
                #if os(iOS)
                .frame(height: 40)
                #else
                .frame(height: 36)
                #endif
                .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                HStack(spacing: 6) {
                    Button { if let up = CliPaths.parent(current) { go(up) } else { go("") } } label: {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(current.isEmpty ? Theme.muted.opacity(0.45) : Theme.foreground)
                            .frame(width: 28, height: 28)
                            .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                    .buttonStyle(.plain).disabled(current.isEmpty).accessibilityLabel("上一级")
                    ScrollViewReader { proxy in
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 3) {
                                Button("全部") { go("") }.buttonStyle(.plain)
                                    .font(.system(size: 12.5, weight: current.isEmpty ? .semibold : .medium))
                                    .foregroundStyle(current.isEmpty ? Theme.foreground : Theme.muted)
                                ForEach(Array(CliPaths.crumbs(current).enumerated()), id: \.offset) { index, crumb in
                                    Image(systemName: "chevron.right").font(.system(size: 8.5, weight: .semibold)).foregroundStyle(Theme.muted.opacity(0.5))
                                    Button(crumb.label) { go(crumb.path) }.buttonStyle(.plain)
                                        .font(.system(size: 12.5, weight: index == CliPaths.crumbs(current).count - 1 ? .semibold : .medium))
                                        .foregroundStyle(index == CliPaths.crumbs(current).count - 1 ? Theme.foreground : Theme.muted)
                                        .id(index)
                                }
                            }
                        }
                        // a deep folder keeps its own name in view
                        .onChange(of: current) { _, _ in
                            let last = CliPaths.crumbs(current).count - 1
                            if last >= 0 { proxy.scrollTo(last, anchor: .trailing) }
                        }
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 14)
            .padding(.bottom, 10)
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if loading && rows.isEmpty { ProgressView().frame(maxWidth: .infinity).padding(.top, 24) }
                    if missing && query.isEmpty {
                        Text("这个文件夹还不存在，开始会话时会新建")
                            .font(.caption).foregroundStyle(Theme.muted)
                            .frame(maxWidth: .infinity).padding(.vertical, 20)
                    }
                    ForEach(rows) { row in rowView(row) }
                    if !loading, rows.isEmpty, !current.isEmpty, !missing {
                        Text(query.isEmpty ? "没有子文件夹" : "没有匹配的文件夹")
                            .font(.caption).foregroundStyle(Theme.muted)
                            .frame(maxWidth: .infinity).padding(.vertical, 24)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            }
            .frame(minHeight: 160)
            Divider()
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    if current.isEmpty {
                        Text("选择一个文件夹").font(.system(size: 12.5)).foregroundStyle(Theme.muted)
                    } else {
                        Text(CliPaths.name(current))
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Theme.foreground)
                            .lineLimit(1)
                        if let parent = CliPaths.parent(current) {
                            Text(parent)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(Theme.muted)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                }
                Spacer(minLength: 4)
                Button(missing ? "新建并使用" : "使用此目录") { choose(AgentDirChoice(path: current, create: missing)) }
                    .buttonStyle(.borderedProminent).tint(Theme.nexAgentSolid).disabled(current.isEmpty)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        }
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
                HStack(spacing: 6) {
                    ForEach(model.devices) { d in
                        Button { deviceId = d.id; go("") } label: {
                            Label(d.name + (d.online ? "" : "（离线）"), systemImage: "desktopcomputer").font(.system(size: 12, weight: d.id == deviceId ? .semibold : .medium))
                                .foregroundStyle(d.id == deviceId ? Theme.nexAgentAccent : Theme.foreground)
                                .padding(.horizontal, 10).padding(.vertical, 5)
                                .background(d.id == deviceId ? Theme.nexAgentSoft : .clear, in: Capsule())
                                .overlay(Capsule().strokeBorder(d.id == deviceId ? Theme.nexAgentAccent : Theme.border))
                        }
                        .buttonStyle(.plain).disabled(!d.online)
                    }
                }
            }
        } else {
            #if os(macOS)
            if let d = model.device(deviceId) {
                Label(d.name, systemImage: "desktopcomputer").font(.caption).foregroundStyle(Theme.muted)
            }
            #endif
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
            out += (listing?.entries ?? [])
                .filter { (!$0.name.hasPrefix(".") || text.hasPrefix(".")) && matches($0.name) }
                .map { Row(kind: .folder(git: $0.git, recent: false), path: $0.path, name: $0.name) }
        }
        if !current.isEmpty, !raw.isEmpty, CliPaths.validName(raw), !(listing?.entries ?? []).contains(where: { $0.name.lowercased() == text }) {
            out.append(Row(kind: .create, path: CliPaths.join(current, raw), name: raw))
        }
        return out
    }

    private func iconSymbol(_ kind: Row.Kind) -> (name: String, accent: Bool) {
        switch kind {
        case .create: return ("folder.badge.plus", true)
        case .go: return ("arrow.right", false)
        case .folder(let git, let recent): return (recent ? "clock" : git ? "folder.fill.badge.gearshape" : "folder", git)
        }
    }

    @ViewBuilder private func rowView(_ row: Row) -> some View {
        let icon = iconSymbol(row.kind)
        Button { act(row) } label: {
            HStack(spacing: 10) {
                Image(systemName: icon.name)
                    .font(.system(size: 13))
                    .foregroundStyle(icon.accent ? Theme.nexAgentAccent : Theme.muted)
                    #if os(iOS)
                    .frame(width: 32, height: 32)
                    #else
                    .frame(width: 28, height: 28)
                    #endif
                    .background(icon.accent ? Theme.nexAgentSoft : Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                switch row.kind {
                case .create:
                    (Text("新建文件夹 ") + Text(row.name).bold().foregroundStyle(Theme.nexAgentAccent))
                        .foregroundStyle(Theme.foreground).lineLimit(1)
                    Spacer(minLength: 4)
                case .go:
                    (Text("前往 ") + Text(row.path).bold()).foregroundStyle(Theme.foreground).lineLimit(1)
                    Spacer(minLength: 4)
                case .folder(let git, let recent):
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.name).font(.system(size: 13.5, weight: .medium)).foregroundStyle(Theme.foreground).lineLimit(1)
                        if recent, let parent = CliPaths.parent(row.path) {
                            Text(parent).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                        }
                    }
                    Spacer(minLength: 4)
                    if git {
                        Text("Git")
                            .font(.system(size: 10.5, weight: .semibold))
                            .foregroundStyle(Theme.nexAgentAccent)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Theme.nexAgentSoft, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                    }
                    Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted.opacity(0.45))
                }
            }
            .font(.system(size: 13.5))
            #if os(iOS)
            .padding(.horizontal, 8).padding(.vertical, 7)
            #else
            .padding(.horizontal, 8).padding(.vertical, 5)
            #endif
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(hovered == row.id ? Theme.wash : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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

import SwiftUI
import NexClientKit

private struct AgentSheetFrame<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.title3.bold())
            content()
        }
        .padding(20)
        #if os(macOS)
        .frame(width: 420)
        #else
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .presentationDetents([.medium, .large])
        #endif
        .background { WorkspaceSurface(kind: .reading) }
    }
}

private struct AgentChip: View {
    let text: String
    let on: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(text).font(.system(size: 12)).lineLimit(1)
                .foregroundStyle(on ? Color.white : Theme.foreground)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(on ? Theme.identityAccent : Theme.wash, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// 新建会话: a computer, an engine, an absolute folder (or a new worktree of it), the model and the first message. The sheet
/// closes at once: the session shows in the list with the message while the computer starts it.
struct AgentNewSessionSheet: View {
    let model: CliAgentsModel
    let initialDeviceId: String?
    let started: (CliSessionKey) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var deviceId = ""
    @State private var engine: CliEngine = .claude
    @State private var cwd = ""
    @State private var newTree = false
    @State private var branch = ""
    @State private var message = ""
    @State private var chosenModel = ""
    @State private var effort = ""
    @State private var catalog = CliModelCatalog()

    private var device: CliDevice? { model.device(deviceId) }
    private var engines: [CliEngine] {
        let list = device?.cliAgents?.engines ?? []
        return list.isEmpty ? CliEngine.allCases : list
    }
    private var blocker: String? { CliSessions.deviceBlocker(device) }
    private var trimmed: String { cwd.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var cwdValid: Bool { CliSessions.isAbsoluteCwd(trimmed) }
    private var branchError: String? { newTree ? CliLaunches.branchProblem(branch) : nil }
    private var text: String { message.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var tooLong: Bool { text.utf8.count > CoreClient.cliMaxSendBytes }
    private var canChoose: Bool { device?.cliAgents?.features.contains("launchOptions") == true }
    private var fallbackModel: String { catalog.current ?? "" }
    private var offered: [String] { CliLaunches.efforts(engine: engine, models: catalog.models, model: chosenModel.isEmpty ? fallbackModel : chosenModel) }
    private var canStart: Bool { blocker == nil && device != nil && cwdValid && branchError == nil && !tooLong }

    var body: some View {
        AgentSheetFrame(title: "新建会话") {
            Picker("电脑", selection: $deviceId) {
                ForEach(model.devices) { Text($0.name + ($0.online ? "" : "（离线）")).tag($0.id) }
            }
            if let blocker { Text(blocker).font(.footnote).foregroundStyle(Theme.danger) }
            Picker("引擎", selection: $engine) {
                ForEach(engines, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            VStack(alignment: .leading, spacing: 6) {
                Text("工作目录").font(.caption).foregroundStyle(Theme.muted)
                TextField("绝对路径", text: $cwd)
                    .textFieldStyle(.roundedBorder).autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                if !trimmed.isEmpty, !cwdValid { Text("需要绝对路径").font(.caption).foregroundStyle(Theme.danger) }
                let recents = CliSessions.recentCwds(model.sessions, deviceId: deviceId)
                if !recents.isEmpty {
                    OutlineFlow { ForEach(recents, id: \.self) { path in AgentChip(text: CliSessions.folderLabel(path), on: path == trimmed) { cwd = path } } }
                }
            }
            Toggle("新建独立工作树（worktree）", isOn: $newTree)
                .onChange(of: newTree) { _, on in if on, branch.trimmingCharacters(in: .whitespaces).isEmpty { branch = CliLaunches.randomBranch() } }
            if newTree {
                VStack(alignment: .leading, spacing: 6) {
                    Text("分支名称").font(.caption).foregroundStyle(Theme.muted)
                    TextField("分支名称", text: $branch)
                        .textFieldStyle(.roundedBorder).autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    if let branchError { Text(branchError).font(.caption).foregroundStyle(Theme.danger) }
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("第一条消息").font(.caption).foregroundStyle(Theme.muted)
                TextField("要做什么？", text: $message, axis: .vertical)
                    .lineLimit(2...6).textFieldStyle(.roundedBorder)
                if tooLong { Text("内容太长").font(.caption).foregroundStyle(Theme.danger) }
            }
            if canChoose {
                HStack(spacing: 10) {
                    Picker("模型", selection: $chosenModel) {
                        Text(fallbackModel.isEmpty ? "默认" : "默认（\(label(fallbackModel))）").tag("")
                        ForEach(catalog.models) { row in Text(row.label).tag(row.id) }
                    }
                    .pickerStyle(.menu)
                    if !offered.isEmpty {
                        Picker("推理强度", selection: $effort) {
                            ForEach([""] + offered, id: \.self) { Text(CliLaunches.effortLabel($0)).tag($0) }
                        }
                        .pickerStyle(.menu)
                    }
                }
            }
            HStack {
                Spacer()
                Button("取消") { dismiss() }.buttonStyle(.bordered)
                Button("开始") { start() }
                    .buttonStyle(.borderedProminent).tint(Theme.identityAccent)
                    .disabled(!canStart)
            }
        }
        .onAppear {
            if deviceId.isEmpty { deviceId = initialDeviceId.flatMap { model.device($0) }?.id ?? model.devices.first { $0.online }?.id ?? model.devices.first?.id ?? "" }
        }
        .onChange(of: deviceId) { _, _ in if !engines.contains(engine), let first = engines.first { engine = first } }
        .task(id: "\(deviceId)\n\(engine.rawValue)") {
            chosenModel = ""; effort = ""
            catalog = await model.models(deviceId: deviceId, engine: engine)
        }
        .onChange(of: chosenModel) { _, _ in if !effort.isEmpty, !offered.contains(effort) { effort = "" } }
    }

    private func label(_ id: String) -> String { catalog.models.first { $0.id == id }?.label ?? id }

    private func start() {
        guard canStart else { return }
        let key = model.launch(CliLaunchRequest(deviceId: deviceId, engine: engine, cwd: trimmed, branch: newTree ? branch.trimmingCharacters(in: .whitespacesAndNewlines) : nil,
                                                message: text, model: canChoose ? chosenModel : "", effort: canChoose ? effort : ""))
        started(key)
        dismiss()
    }
}

/// A session being started: the first message and that it is being handled, or why it did not start.
struct AgentLaunchDetail: View {
    let model: CliAgentsModel
    let launch: CliLaunch

    var body: some View {
        let row = CliLaunches.row(launch)
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                    Text([launch.request.engine.label, CliSessions.folderLabel(launch.request.cwd), launch.request.branch ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                }
                Spacer(minLength: 4)
                if case .failed = launch.phase { CliChip(text: "未启动", tone: .stopped) } else { CliChip(text: "运行中", tone: .running) }
            }
            .padding(14)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if !launch.request.message.isEmpty { AgentEchoBubble(text: launch.request.message) }
                }
                .padding(.horizontal, 14).padding(.vertical, 6)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Group {
                if case .failed(let reason) = launch.phase {
                    HStack(spacing: 10) {
                        Text(reason).font(.footnote).foregroundStyle(Theme.danger)
                        Spacer()
                        Button("重试") { model.retryLaunch(launch.id) }.buttonStyle(.bordered)
                        Button("关闭") { model.dismissLaunch(launch.id) }.buttonStyle(.bordered)
                    }
                } else {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("处理中…").font(.footnote).foregroundStyle(Theme.muted)
                        Spacer()
                    }
                }
            }
            .padding(14)
        }
    }
}

/// The user's message, as the transcript shows one.
struct AgentEchoBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 40)
            Text(text).font(.system(size: 14)).textSelection(.enabled)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Theme.chatUser, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }
}

/// 交给助手: hands the session's record to one of the person's assistants.
struct AgentForkSheet: View {
    let model: CliAgentsModel
    let workspace: WorkspaceStore
    let session: CliSession
    let done: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var botId = ""
    @State private var busy = false
    @State private var error = ""

    var body: some View {
        AgentSheetFrame(title: "交给助手") {
            Text(CliSessions.title(session)).font(.system(size: 13)).foregroundStyle(Theme.muted).lineLimit(2)
            OutlineFlow {
                ForEach(workspace.bots, id: \.id) { bot in AgentChip(text: bot.name, on: bot.id == botId) { botId = bot.id } }
            }
            if !error.isEmpty { Text(error).font(.footnote).foregroundStyle(Theme.danger) }
            HStack {
                Spacer()
                Button("取消") { dismiss() }.buttonStyle(.bordered)
                Button(busy ? "正在交接…" : "交给助手") { Task { await fork() } }
                    .buttonStyle(.borderedProminent).tint(Theme.identityAccent).disabled(busy || botId.isEmpty)
            }
        }
        .onAppear {
            if botId.isEmpty { botId = workspace.selectedBotID.flatMap { workspace.bot($0) }?.id ?? workspace.bots.first?.id ?? "" }
        }
    }

    private func fork() async {
        busy = true; error = ""
        do {
            let result = try await model.fork(session.key, botId: botId)
            done(result.botId)
        } catch { self.error = CliAgentsModel.forkErrorText(error) }
        busy = false
    }
}

/// 自动处理设置: what Core does for sessions on its own.
struct AgentSupervisionSheet: View {
    let model: CliAgentsModel
    @Environment(\.dismiss) private var dismiss
    @State private var loading = true
    @State private var error = ""

    var body: some View {
        AgentSheetFrame(title: "自动处理设置") {
            if let value = model.supervision {
                toggle("临时错误后自动继续", value.settings.transientRetry) { try await model.setSupervision(transientRetry: $0) }
                toggle("额度恢复后继续", value.settings.usageLimit) { try await model.setSupervision(usageLimit: $0) }
                toggle("唤醒", value.settings.wakeup) { try await model.setSupervision(wakeup: $0) }
                if value.pending > 0 { Text("\(value.pending) 项待执行").font(.footnote).foregroundStyle(Theme.muted) }
                if value.overrides > 0 { Text("\(value.overrides) 个目录单独设置").font(.footnote).foregroundStyle(Theme.muted) }
            } else if loading {
                Text("正在读取…").font(.footnote).foregroundStyle(Theme.muted)
            } else {
                Button("重试") { Task { await load() } }.buttonStyle(.bordered)
            }
            if !error.isEmpty { Text(error).font(.footnote).foregroundStyle(Theme.danger) }
            HStack { Spacer(); Button("完成") { dismiss() }.buttonStyle(.borderedProminent).tint(Theme.identityAccent) }
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        await model.loadSupervision()
        loading = false
    }

    private func toggle(_ title: String, _ on: Bool, save: @escaping (Bool) async throws -> Void) -> some View {
        Toggle(title, isOn: Binding(get: { on }, set: { next in
            error = ""
            Task { do { try await save(next) } catch { self.error = CliErrorText.text(for: error, fallback: "没能保存") } }
        }))
    }
}

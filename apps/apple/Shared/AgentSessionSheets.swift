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

/// 新建会话: a computer, an engine and an absolute folder on it.
struct AgentNewSessionSheet: View {
    let model: CliAgentsModel
    let initialDeviceId: String?
    let started: (CliSessionKey) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var deviceId = ""
    @State private var engine: CliEngine = .claude
    @State private var cwd = ""
    @State private var busy = false
    @State private var error = ""

    private var device: CliDevice? { model.device(deviceId) }
    private var engines: [CliEngine] {
        let list = device?.cliAgents?.engines ?? []
        return list.isEmpty ? CliEngine.allCases : list
    }
    private var blocker: String? { CliSessions.deviceBlocker(device) }
    private var trimmed: String { cwd.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var cwdValid: Bool { CliSessions.isAbsoluteCwd(trimmed) }

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
            if !error.isEmpty { Text(error).font(.footnote).foregroundStyle(Theme.danger) }
            HStack {
                Spacer()
                Button("取消") { dismiss() }.buttonStyle(.bordered)
                Button(busy ? "正在启动…" : "开始") { Task { await start() } }
                    .buttonStyle(.borderedProminent).tint(Theme.identityAccent)
                    .disabled(busy || blocker != nil || !cwdValid || device == nil)
            }
        }
        .onAppear {
            if deviceId.isEmpty { deviceId = initialDeviceId.flatMap { model.device($0) }?.id ?? model.devices.first { $0.online }?.id ?? model.devices.first?.id ?? "" }
        }
        .onChange(of: deviceId) { _, _ in if !engines.contains(engine), let first = engines.first { engine = first } }
    }

    private func start() async {
        busy = true; error = ""
        do {
            let key = try await model.startSession(deviceId: deviceId, engine: engine, cwd: trimmed)
            started(key)
            dismiss()
        } catch { self.error = CliErrorText.text(for: error, fallback: "没能启动") }
        busy = false
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

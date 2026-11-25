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

/// A session being started: the first message and that it is being handled, or why it did not start.
struct AgentLaunchDetail: View {
    let model: CliAgentsModel
    let launch: CliLaunch

    var body: some View {
        let row = CliLaunches.row(launch)
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(row.title).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                Spacer(minLength: 4)
                if case .failed = launch.phase { CliChip(text: "未启动", tone: .stopped) } else { CliChip(text: "运行中", tone: .running) }
            }
            .padding(14)
            // laid out like any conversation: the message, then the agent's reply slot
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if !launch.request.message.isEmpty { AgentEchoBubble(text: launch.request.message, loadImage: model.downloadImage) }
                    if case .failed(let reason) = launch.phase {
                        VStack(alignment: .leading, spacing: 6) {
                            AgentByline(engine: launch.request.engine)
                            Text(reason).font(.footnote).foregroundStyle(Theme.danger)
                            HStack(spacing: 10) {
                                Button("重试") { model.retryLaunch(launch.id) }.buttonStyle(ConversationActionButtonStyle())
                                Button("关闭") { model.dismissLaunch(launch.id) }.buttonStyle(ConversationActionButtonStyle(tone: .dark))
                            }
                        }
                    } else {
                        AgentWorkingRow(engine: launch.request.engine, label: "执行中", byline: true)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 6)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// The agent's name over the first message of a reply.
struct AgentByline: View {
    let engine: CliEngine
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "sparkle").font(.system(size: 11)).foregroundStyle(engine == .claude ? Color(hex: 0xAB6146) : Theme.muted)
            Text(agentName(engine)).font(.system(size: 12, weight: .semibold))
        }
    }
}

/// The agent is working on the turn: NexBot's three dots in the conversation, with what is happening under them.
struct AgentWorkingRow: View {
    let engine: CliEngine
    let label: String
    var byline = false
    @State private var phase = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if byline { AgentByline(engine: engine) }
            HStack(spacing: 5) {
                ForEach(0..<3) { i in
                    Circle().fill(Theme.muted).frame(width: 5, height: 5)
                        .opacity(phase == i ? 1 : 0.4).offset(y: phase == i ? -2 : 0)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .shadow(color: Theme.shadowInk.opacity(0.06), radius: 2, y: 1)
            .accessibilityLabel(label)
            Text(label).font(.caption2).foregroundStyle(Theme.muted).padding(.leading, 4)
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 400_000_000)
                withAnimation(.easeInOut(duration: 0.25)) { phase = (phase + 1) % 3 }
            }
        }
    }
}

/// The user's message, as the transcript shows one.
struct AgentEchoBubble: View {
    let text: String
    let loadImage: (String) async throws -> Data

    var body: some View {
        HStack {
            Spacer(minLength: 40)
            AgentImageMessage(text: text, load: loadImage)
        }
    }
}

/// 交给助手: hands the session's record to one of the person's assistants.
struct AgentForkSheet: View {
    let model: CliAgentsModel
    let workspace: WorkspaceStore
    let session: CliSession
    var itemId: String? = nil
    let done: (CliForkResult) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var botId = ""
    @State private var busy = false
    @State private var error = ""

    var body: some View {
        let title = itemId == nil ? "交给助手" : "分支到新聊天"
        AgentSheetFrame(title: title) {
            Text(CliSessions.title(session)).font(.system(size: 13)).foregroundStyle(Theme.muted).lineLimit(2)
            OutlineFlow {
                ForEach(workspace.bots, id: \.id) { bot in AgentChip(text: bot.name, on: bot.id == botId) { botId = bot.id } }
            }
            if !error.isEmpty { Text(error).font(.footnote).foregroundStyle(Theme.danger) }
            HStack {
                Spacer()
                Button("取消") { dismiss() }.buttonStyle(.bordered)
                Button(busy ? "正在创建…" : title) { Task { await fork() } }
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
            let result = try await model.fork(session.key, botId: botId, itemId: itemId)
            done(result)
        } catch {
            self.error = itemId == nil ? CliAgentsModel.forkErrorText(error)
                : CoreError.wrap(error).code == "not_found" ? "找不到这条回复" : CliErrorText.text(for: error, fallback: "没能创建分支")
        }
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

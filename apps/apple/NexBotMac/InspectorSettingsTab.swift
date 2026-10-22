import SwiftUI
import NexClientKit

/// Inspector 设置 tab: about (bot身份信息), capabilities, usage, export and archive.
struct InspectorSettingsTab: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(UIState.self) private var ui
    @State private var exported = false
    @State private var confirmArchive = false
    @State private var error: String?
    @State private var modelOpen = false

    private var bot: Bot? { workspace.bot(botID) }

    var body: some View {
        let usage = workspace.state?.usage(botID: botID)
        VStack(alignment: .leading, spacing: 20) {
            Text("助手设置").font(.system(size: 12, weight: .bold))

            group("关于") {
                IdentityField(workspace: workspace, botID: botID)
            }

            group("能力") {
                VStack(spacing: 12) {
                    row(symbol: "bolt", title: "驱动模型") {
                        // Picks the assistant's model in place, like the composer's ＋ › 模型; 设置 only when nothing is connected.
                        pillButton(bot?.selectedModel ?? workspace.state?.config?.defaultModel.nilIfEmpty ?? "未连接模型") {
                            if workspace.state?.config == nil { ui.openSettings(.model) } else { modelOpen = true }
                        }
                        .popover(isPresented: $modelOpen, arrowEdge: .leading) {
                            ModelPickerPopover(label: "选择聊天模型", value: bot?.selectedModel ?? "", emptyLabel: "默认 · \(workspace.state?.config?.defaultModel ?? "")",
                                               models: workspace.state?.modelVisibility.models, source: workspace.savedModelSource(),
                                               onSelect: setModel, close: { modelOpen = false })
                        }
                    }
                    row(symbol: "shield", title: "工具权限") {
                        pillButton(PolicyCatalog.summary(count: bot?.policyTools.count ?? 0)) { AgentUI.shared.editPolicy(botID) }
                    }
                }
                .fieldCard()
            }

            group("用量") {
                HStack {
                    stat("累计调用", "\(usage?.calls ?? 0) 次")
                    stat("输入 Token", (usage?.inputTokens ?? 0).formatted())
                    stat("输出 Token", (usage?.outputTokens ?? 0).formatted())
                }
                .fieldCard(padding: 14)
            }

            if let error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled) }

            Hairline()
            HStack {
                if !workspace.conversation(for: botID).messages.isEmpty {
                    Button(action: export) {
                        Text(exported ? "已复制记录" : "导出记录").font(.system(size: 11)).foregroundStyle(Theme.muted).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
                Button { confirmArchive = true } label: {
                    Text("归档 Agent").font(.system(size: 11)).foregroundStyle(Theme.danger).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .alert("归档这个 Agent？", isPresented: $confirmArchive) {
            Button("取消", role: .cancel) {}.keyboardShortcut(.cancelAction)
            Button("确认", role: .destructive) { archive() }
        } message: { Text("保留消息与记忆，停用例行任务。") }
        #if DEBUG
        // `im model` on `$NEXBOT_DEBUG_COMMAND_FILE.b` opens the 驱动模型 picker; `im close` closes it.
        .task { MBDebug.start() }
        .onReceive(NotificationCenter.default.publisher(for: .mbDebug)) { note in
            guard let cmd = note.mbCommand, cmd.prefix == "im" else { return }
            if cmd.verb == "model" { modelOpen = true } else if cmd.verb == "close" { modelOpen = false }
        }
        #endif
    }

    private func group<C: View>(_ title: String, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 12, weight: .semibold))
            content()
        }
    }

    private func row<C: View>(symbol: String, title: String, @ViewBuilder trailing: () -> C) -> some View {
        HStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 11)).foregroundStyle(Theme.muted).frame(width: 14)
            Text(title).font(.system(size: 12))
            Spacer(minLength: 6)
            trailing()
        }
    }

    private func setModel(_ next: String) {
        modelOpen = false
        guard next != (bot?.selectedModel ?? "") else { return }
        error = nil
        Task {
            do { try await workspace.setAgentModel(botID: botID, model: next) }
            catch { self.error = message(of: error) }
        }
    }

    private func pillButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(size: 11)).foregroundStyle(Theme.foreground).lineLimit(1)
                .padding(.horizontal, 9).padding(.vertical, 4).background(Theme.card, in: Capsule())
                .overlay(Capsule().strokeBorder(Theme.border)).contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(spacing: 6) {
            Text(label).font(.system(size: 10)).foregroundStyle(Theme.muted)
            Text(value).font(.system(size: 13, weight: .semibold))
        }
        .frame(maxWidth: .infinity)
    }

    private func export() {
        guard let text = workspace.exportTranscript(botID: botID) else { return }
        AgentUI.shared.copyToPasteboard(text)
        exported = true
        Task { try? await Task.sleep(for: .seconds(1.8)); exported = false }
    }

    private func archive() {
        error = nil
        Task {
            do { try await workspace.archiveAgent(botID: botID) } catch { self.error = message(of: error) }
        }
    }
}

fileprivate extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// Inline bot identity (web `BotIdentity`): shows the instructions, click to edit in place. ⌘↩ saves, Esc cancels.
private struct IdentityField: View {
    let workspace: WorkspaceStore
    let botID: String
    @State private var editing = false
    @State private var draft = ""
    @State private var pending = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private var bot: Bot? { workspace.bot(botID) }
    private var text: String { bot?.instructions ?? "" }

    var body: some View {
        Group { if editing { editor } else { display } }
        #if DEBUG
        .task { MBDebug.start() }
        .onReceive(NotificationCenter.default.publisher(for: .mbDebug)) { note in
            guard let cmd = note.mbCommand, cmd.prefix == "id" else { return }
            switch cmd.verb {
            case "edit": draft = text; error = nil; editing = true
            case "fill": draft = cmd.arg
            case "save": save()
            case "cancel": editing = false
            default: break
            }
        }
        #endif
    }

    private var display: some View {
        Button { draft = text; error = nil; editing = true } label: {
            Text(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "bot身份信息" : text)
                .font(.system(size: 12)).foregroundStyle(Theme.muted).lineSpacing(3)
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("编辑 bot身份信息")
        .fieldCard()
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextEditor(text: $draft)
                .font(.system(size: 12)).lineSpacing(3).scrollContentBackground(.hidden)
                .focused($focused).disabled(pending)
                .frame(minHeight: 110, maxHeight: 220)
                .padding(.horizontal, 8).padding(.vertical, 6)
                .background(Theme.background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(alignment: .topLeading) {
                    if draft.isEmpty {
                        Text("填写身份、职责与沟通方式").font(.system(size: 12)).foregroundStyle(Theme.muted.opacity(0.7))
                            .padding(.horizontal, 13).padding(.vertical, 7).allowsHitTesting(false)
                    }
                }
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border))
                .accessibilityLabel("bot身份信息")
                .onKeyPress(.escape) { if !pending { editing = false }; return .handled }
                .onKeyPress(.return, phases: .down) { press in
                    guard press.modifiers.contains(.command) else { return .ignored }
                    save(); return .handled
                }
            if let error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled) }
            HStack(spacing: 8) {
                MBButton(title: pending ? "保存中…" : "保存", kind: .primary, busy: pending, action: save)
                MBButton(title: "取消", enabled: !pending) { editing = false }
            }
        }
        .onAppear { focused = true }
    }

    private func save() {
        guard !pending, let bot else { return }
        pending = true; error = nil
        Task {
            defer { pending = false }
            do { try await workspace.updateIdentity(botID: botID, name: bot.name, instructions: draft); editing = false }
            catch { self.error = message(of: error) }
        }
    }
}

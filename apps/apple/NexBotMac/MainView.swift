import SwiftUI
import AppKit
import NexClientKit

struct MainView: View {
    let workspace: WorkspaceStore
    @Environment(UIState.self) private var ui
    @Environment(AppModel.self) private var model
    @Environment(LocalDeviceController.self) private var device
    @Environment(\.colorScheme) private var scheme
    @AppStorage(AppearanceOverride.key) private var appearance = "system"

    var body: some View {
        HStack(spacing: 0) {
            ContactsList(workspace: workspace)
                .frame(width: 260)
            Hairline(vertical: true)
            VStack(spacing: 0) {
                NoticeBanner(workspace: workspace)
                Group {
                    if let id = workspace.selectedBotID, workspace.bot(id) != nil {
                        ConversationView(workspace: workspace, botID: id).id(id)
                    } else {
                        if workspace.bots.isEmpty && workspace.state != nil { NoAgentsWelcome() }
                        else { EmptyChat(noAgents: false) }
                    }
                }
            }
            .frame(minWidth: 380, maxWidth: .infinity)
            if ui.inspectorVisible, let id = workspace.selectedBotID, workspace.bot(id) != nil {
                Hairline(vertical: true)
                InspectorView(workspace: workspace, botID: id)
                    .frame(width: 310)
            }
        }
        .background(Theme.background)
        .ignoresSafeArea(.container, edges: .top)
        .overlay { if ui.accountMenuOpen { accountMenuLayer } }
        .animation(.easeOut(duration: 0.15), value: ui.accountMenuOpen)
        .logoutConfirmation(isPresented: Bindable(ui).logoutConfirmOpen) { await device.stop(revoke: true); await model.logout(); return model.workspace == nil }
        #if DEBUG
        .task { await runDebugCommands(workspace: workspace, ui: ui) }
        #endif
        .onChange(of: workspace.bots.first?.id, initial: true) {
            if workspace.selectedBotID == nil, let first = workspace.bots.first { workspace.select(first.id) }
        }
    }

    /// Click-away layer plus the account menu card above the account button, as in the web sidebar.
    private var accountMenuLayer: some View {
        ZStack(alignment: .bottomLeading) {
            Color.clear.contentShape(Rectangle()).onTapGesture { ui.accountMenuOpen = false }
            AccountMenu(dark: scheme == .dark,
                        openSettings: { ui.openSettings() },
                        toggleDark: { appearance = scheme == .dark ? "light" : "dark"; ui.accountMenuOpen = false },
                        logout: { ui.accountMenuOpen = false; ui.logoutConfirmOpen = true })
                .frame(width: 236)
                .padding(.leading, 12).padding(.bottom, 74)
                .transition(.opacity.combined(with: .offset(y: 6)))
        }
        .onExitCommand { ui.accountMenuOpen = false }
    }
}

private struct EmptyChat: View {
    let noAgents: Bool
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "bubble.left.and.bubble.right").font(.system(size: 28)).foregroundStyle(Theme.muted)
            Text(noAgents ? "还没有 Agent" : "选择一个 Agent").font(.system(size: 15, weight: .semibold))
            Text(noAgents ? "请先在 Core 中创建 Agent。" : "从左侧选择会话。").font(.system(size: 12)).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct NoticeBanner: View {
    let workspace: WorkspaceStore

    var body: some View {
        if let notice = workspace.notice {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(notice).font(.system(size: 12)).foregroundStyle(Theme.muted)
                Spacer()
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
            .background(Theme.secondary)
            .overlay(alignment: .bottom) { Hairline() }
            .accessibilityIdentifier("connection-notice")
        }
    }
}

/// Core's message text for an error.
func message(of error: Error) -> String {
    CoreError.wrap(error).message
}

#if DEBUG
/// DEBUG-only automation: when NEXBOT_DEBUG_COMMAND_FILE is set, the file is polled and consumed line by line.
/// Commands: `select <agent name>`, `send <text>`, `approve`, `deny`, `stop`, `inspector [work|settings]` (no argument toggles the column), `logout` (opens the confirmation), `attach <path>[|<path>...]`, `unattach`, `addmenu`, `permmenu`, `closemenu`, `mode full|standard`, `export <path>`, `download <id>|<path>`, `state` (results in `$NEXBOT_DEBUG_COMMAND_FILE.b.log`; the model pane takes `md limits|setlimits ctx|out|lookup` on `.b`), `accountmenu`, `settings [account|model|memory|connectors|devices]`, `dark`, `light`, `system`.
@MainActor func runDebugCommands(workspace: WorkspaceStore, ui: UIState) async {
    guard let path = ProcessInfo.processInfo.environment["NEXBOT_DEBUG_COMMAND_FILE"] else { return }
    while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(400))
        guard let text = try? String(contentsOfFile: path, encoding: .utf8), !text.isEmpty else { continue }
        try? "".write(toFile: path, atomically: true, encoding: .utf8)
        for line in text.split(separator: "\n") {
            let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
            let arg = parts.count > 1 ? parts[1] : ""
            switch parts.first {
            case "select": if let bot = workspace.bots.first(where: { $0.name == arg }) { workspace.select(bot.id) }
            case "send": if let id = workspace.selectedBotID { await workspace.conversation(for: id).send(text: arg) }
            case "approve", "deny": if let a = workspace.approvals.first { try? await workspace.decide(a, allow: parts.first == "approve") }
            case "stop": if let id = workspace.selectedBotID { await workspace.conversation(for: id).stop() }
            case "inspector":
                switch arg {
                case "work": ui.openInspector(.work)
                case "settings": ui.openInspector(.settings)
                default: ui.inspectorVisible.toggle()
                }
            case "accountmenu": ui.accountMenuOpen.toggle()
            case "logoutcancel": ui.logoutConfirmOpen = false
            case "logout": ui.accountMenuOpen = false; ui.logoutConfirmOpen = true
            case "settings":
                let category: SettingsCategory? = ["account": .account, "model": .model, "memory": .memory, "connectors": .connectors, "devices": .devices][arg]
                ui.openSettings(category)
            case "attach":
                if let id = workspace.selectedBotID { await workspace.conversation(for: id).addFiles(arg.split(separator: "|").map { URL(fileURLWithPath: String($0)) }) }
            case "unattach": if let id = workspace.selectedBotID { let c = workspace.conversation(for: id); c.attachments.last.map(c.removeAttachment) }
            case "addmenu": ui.composerMenu = .add
            case "permmenu": ui.composerMenu = .permissions
            case "closemenu": ui.composerMenu = nil
            case "mode":
                guard let id = workspace.selectedBotID, let mode = ApprovalMode(rawValue: arg) else { break }
                do { try await workspace.setApprovalMode(botID: id, mode: mode); mbLog("mode \(workspace.bot(id)?.approvalMode.rawValue ?? "?")") }
                catch { mbLog("mode ERR \(message(of: error))") }
            case "export":
                guard let id = workspace.selectedBotID else { break }
                do {
                    let r = try await workspace.exportMarkdown(botID: id)
                    try r.content.write(toFile: arg, atomically: true, encoding: .utf8)
                    mbLog("export \(r.filename) \(r.content.count) chars")
                } catch { mbLog("export ERR \(message(of: error))") }
            case "download":
                // download <attachment id>|<path>: the file Core returns, written without a save panel.
                guard let id = workspace.selectedBotID else { break }
                let f = arg.components(separatedBy: "|")
                guard f.count == 2 else { break }
                do { let name = try await AttachmentCard.debugDownload(AttachmentLink(id: f[0], name: ""), conversation: workspace.conversation(for: id), to: f[1]); mbLog("download \(name)") }
                catch { mbLog("download ERR \(message(of: error))") }
            case "state":
                guard let id = workspace.selectedBotID else { break }
                let c = workspace.conversation(for: id)
                mbLog("state mode=\(workspace.bot(id)?.approvalMode.rawValue ?? "?") approvals=\(workspace.approvals.count) attachments=\(c.attachments.map { "\($0.name):\($0.isUploading ? "up" : $0.errorMessage ?? "ok")" }) err=\(c.sendError ?? "") last=\(c.messages.last?.content ?? "")")
            case "dark", "light", "system": UserDefaults.standard.set(parts[0], forKey: AppearanceOverride.key)
            default: break
            }
        }
    }
}
#endif

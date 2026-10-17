import SwiftUI
import AppKit
import NexClientKit

struct MainView: View {
    let workspace: WorkspaceStore
    @Environment(UIState.self) private var ui
    @Environment(AppModel.self) private var model
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
                    switch ui.page {
                    case .agent:
                        if let id = workspace.selectedBotID, workspace.bot(id) != nil {
                            ConversationView(workspace: workspace, botID: id).id(id)
                        } else {
                            EmptyChat(noAgents: workspace.bots.isEmpty && workspace.state != nil)
                        }
                    case .connectors: ConnectorsPage(workspace: workspace)
                    case .devices: DevicesPage(workspace: workspace)
                    }
                }
            }
            .frame(minWidth: 380, maxWidth: .infinity)
            if ui.page == .agent, ui.inspectorVisible, let id = workspace.selectedBotID, workspace.bot(id) != nil {
                Hairline(vertical: true)
                InspectorView(workspace: workspace, botID: id)
                    .frame(width: 310)
            }
        }
        .background(Theme.background)
        .ignoresSafeArea(.container, edges: .top)
        .overlay { if ui.accountMenuOpen { accountMenuLayer } }
        .animation(.easeOut(duration: 0.15), value: ui.accountMenuOpen)
        #if DEBUG
        .task { await runDebugCommands(workspace: workspace, ui: ui) }
        #endif
        .onChange(of: workspace.selectedBotID) { ui.showAgent() }
        .onChange(of: workspace.bots.first?.id, initial: true) {
            if workspace.selectedBotID == nil, let first = workspace.bots.first { workspace.select(first.id) }
        }
    }

    /// Click-away layer plus the account menu card above the account button, as in the web sidebar.
    private var accountMenuLayer: some View {
        ZStack(alignment: .bottomLeading) {
            Color.clear.contentShape(Rectangle()).onTapGesture { ui.accountMenuOpen = false }
            AccountMenu(dark: scheme == .dark,
                        connectorCount: workspace.state?.enabledConnectorCount ?? 0,
                        deviceCount: workspace.state?.onlineDeviceCount ?? 0,
                        openConnectors: { ui.openConnectors() },
                        openDevices: { ui.openDevices() },
                        openSettings: { ui.openSettings() },
                        toggleDark: { appearance = scheme == .dark ? "light" : "dark"; ui.accountMenuOpen = false },
                        logout: { ui.accountMenuOpen = false; Task { await model.logout() } })
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
/// Commands: `select <agent name>`, `send <text>`, `approve`, `deny`, `stop`, `inspector [work|memory|settings]` (no argument toggles the column), `page agent|connectors|devices`, `accountmenu`, `settings [account|model|memory|system]`, `dark`, `light`, `system`.
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
                case "memory": ui.openInspector(.memory)
                case "settings": ui.openInspector(.settings)
                default: ui.inspectorVisible.toggle()
                }
            case "page":
                switch arg {
                case "connectors": ui.openConnectors()
                case "devices": ui.openDevices()
                default: ui.showAgent()
                }
            case "accountmenu": ui.accountMenuOpen.toggle()
            case "settings":
                let category: SettingsCategory? = ["account": .account, "model": .model, "memory": .memory, "system": .system][arg]
                ui.openSettings(category)
            case "dark", "light", "system": UserDefaults.standard.set(parts[0], forKey: AppearanceOverride.key)
            case "settingssystem", "settingsaccount": UserDefaults.standard.set(parts[0] == "settingssystem" ? SettingsCategory.system.rawValue : SettingsCategory.account.rawValue, forKey: SettingsCategory.storageKey)
            default: break
            }
        }
    }
}
#endif

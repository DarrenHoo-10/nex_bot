#if DEBUG
import Foundation
import NexClientKit

/// DEBUG-only automation for simulator fixture runs, where taps cannot be scripted.
/// NEXBOT_FIXTURE_AUTOLOGIN_ACCOUNT / _PASSWORD submit the login form once per launch.
/// NEXBOT_DEBUG_COMMAND_FILE is polled and consumed line by line:
/// `tab chats|approvals|settings` (chats = pop to root), `open <agent name>`, `back`, `menu` (account menu), `dark|light|system`, `route connectors|devices|detail|settings` (detail = the current or first agent), `detailtab work|memory|settings`, `settingscat account|model|memory|system`, `send <text>`, `approve`, `deny`, `stop`, `revoke <session id prefix>`, `logout`.
@MainActor enum DebugHooks {
    static var autoLoginUsed = false

    static func autoLogin(_ model: AppModel) async -> String? {
        let env = ProcessInfo.processInfo.environment
        guard !autoLoginUsed, let account = env["NEXBOT_FIXTURE_AUTOLOGIN_ACCOUNT"], let secret = env["NEXBOT_FIXTURE_AUTOLOGIN_PASSWORD"] else { return nil }
        autoLoginUsed = true
        while model.phase == .launching || model.phase == .resuming { try? await Task.sleep(for: .milliseconds(100)) }
        guard case .loggedOut = model.phase else { return nil }
        await model.login(account: account, password: secret)
        return account
    }

    static func runCommands(model: AppModel, workspace: WorkspaceStore, nav: Navigation) async {
        guard let path = ProcessInfo.processInfo.environment["NEXBOT_DEBUG_COMMAND_FILE"] else { return }
        while !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(400))
            guard let text = try? String(contentsOfFile: path, encoding: .utf8), !text.isEmpty else { continue }
            try? "".write(toFile: path, atomically: true, encoding: .utf8)
            for line in text.split(separator: "\n") {
                let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
                let arg = parts.count > 1 ? parts[1] : ""
                switch parts.first {
                case "tab":
                    nav.showMenu = false
                    nav.path = arg == "approvals" ? [.approvals] : arg == "settings" ? [.settings] : []
                case "open": if let bot = workspace.bots.first(where: { $0.name == arg }) { nav.showMenu = false; nav.path = [.chat(bot.id)] }
                case "route":
                    switch arg {
                    case "connectors": nav.openConnectors()
                    case "devices": nav.openDevices()
                    case "settings": nav.openSettings(nav.settingsCategory)
                    case "detail": if let id = nav.currentBotID ?? workspace.bots.first?.id { nav.openAgentDetail(id, tab: nav.detailTab) }
                    default: break
                    }
                case "detailtab": if let tab = AgentDetailTab.allCases.first(where: { ["work": "工作", "memory": "资料", "settings": "设置"][arg] == $0.rawValue }) { nav.detailTab = tab }
                case "settingscat": if let c = ["account": SettingsCategory.account, "model": .model, "memory": .memory, "system": .system][arg] { nav.settingsCategory = c }
                case "back": nav.showMenu = false; if !nav.path.isEmpty { nav.path.removeLast() }
                case "menu": nav.showMenu = true
                case "dark", "light", "system": UserDefaults.standard.set(parts[0], forKey: AppearanceMode.key)
                case "send": if let id = nav.currentBotID { await workspace.conversation(for: id).send(text: arg) }
                case "approve", "deny": if let a = workspace.approvals.first { try? await workspace.decide(a, allow: parts.first == "approve") }
                case "stop": if let id = nav.currentBotID { await workspace.conversation(for: id).stop() }
                case "revoke":
                    try? await workspace.loadSessions()
                    if let s = workspace.sessions.first(where: { $0.sessionID.hasPrefix(arg) }) { try? await workspace.revokeSession(s.sessionID) }
                case "logout": await model.logout()
                default: break
                }
            }
        }
    }
}
#endif

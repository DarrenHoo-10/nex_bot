#if DEBUG
import Foundation
import NexClientKit

/// DEBUG-only automation for simulator fixture runs, where taps cannot be scripted.
/// NEXBOT_FIXTURE_AUTOLOGIN_ACCOUNT / _PASSWORD submit the login form once per launch.
/// NEXBOT_DEBUG_COMMAND_FILE is polled and consumed line by line:
/// `tab chats|approvals|settings`, `open <agent name>`, `back`, `send <text>`, `approve`, `deny`, `stop`, `revoke <session id prefix>`, `logout`.
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
                case "tab": nav.tab = arg == "approvals" ? .approvals : arg == "settings" ? .settings : .chats
                case "open": if let bot = workspace.bots.first(where: { $0.name == arg }) { nav.tab = .chats; nav.path = [bot.id] }
                case "back": nav.path = []
                case "send": if let id = nav.path.last { await workspace.conversation(for: id).send(text: arg) }
                case "approve", "deny": if let a = workspace.approvals.first { try? await workspace.decide(a, allow: parts.first == "approve") }
                case "stop": if let id = nav.path.last { await workspace.conversation(for: id).stop() }
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

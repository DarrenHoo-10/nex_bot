import Foundation
import UserNotifications
import NexClientKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Local notifications for Agent sessions that wait for the person. Only sent while the app is not in front.
@MainActor
final class AgentNotifier: CliNotifying {
    static let shared = AgentNotifier()

    static func requestAuthorization() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
    }

    static var foreground: Bool {
        #if os(macOS)
        NSApp.isActive
        #else
        UIApplication.shared.applicationState == .active
        #endif
    }

    func notify(title: String, body: String, key: CliSessionKey) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.userInfo = ["cliSessionKey": key]
        let request = UNNotificationRequest(identifier: "cli-agent-" + key, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { _ in }
    }
}

extension CliAgentsModel {
    /// Wires the model to the system: notifications go out only when the app is in the background.
    func installNotifier() {
        notifier = AgentNotifier.shared
        isForeground = { AgentNotifier.foreground }
    }
}

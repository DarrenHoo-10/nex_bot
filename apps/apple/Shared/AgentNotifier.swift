import Foundation
import UserNotifications
import NexClientKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Local notifications for NexAgent CLI sessions and NexBot replies/approvals, with tap/click deep-link routing.
@MainActor
final class AgentNotifier: NSObject, CliNotifying {
    static let shared = AgentNotifier()

    /// Deep-link handlers installed by the connected root view (Mac `MainView` / iOS `ConnectedView`).
    var onOpenCliSession: (@MainActor (CliSessionKey) -> Void)?
    var onOpenBot: (@MainActor (String) -> Void)?
    /// Returns the currently visible bot ID so active-chat replies do not spam banners.
    var activeBotID: (@MainActor () -> String?)?

    private var delegateInstalled = false

    func installDelegate() {
        guard !delegateInstalled else { return }
        delegateInstalled = true
        UNUserNotificationCenter.current().delegate = self
    }

    static func requestAuthorization() async -> Bool {
        shared.installDelegate()
        return (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    static var foreground: Bool {
        #if os(macOS)
        NSApp.isActive
        #else
        UIApplication.shared.applicationState == .active
        #endif
    }

    func notify(title: String, body: String, key: CliSessionKey) {
        installDelegate()
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.userInfo = ["cliSessionKey": key]
        let request = UNNotificationRequest(identifier: "cli-agent-" + key, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { _ in }
    }

    func notifyBot(title: String, body: String, botID: String, kind: String) {
        if Self.foreground && activeBotID?() == botID && kind != "approval" { return }
        installDelegate()
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.userInfo = ["botID": botID, "kind": kind]
        let id = kind == "approval" ? "nexbot-approval-\(botID)-\(Int(Date().timeIntervalSince1970))" : "nexbot-reply-\(botID)"
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { _ in }
    }
}

extension AgentNotifier: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        let cliKey = info["cliSessionKey"] as? String
        let botID = info["botID"] as? String
        await MainActor.run {
            #if os(macOS)
            NSApp.activate()
            #endif
            if let cliKey, !cliKey.isEmpty {
                AgentNotifier.shared.onOpenCliSession?(cliKey)
            } else if let botID, !botID.isEmpty {
                AgentNotifier.shared.onOpenBot?(botID)
            }
        }
    }
}

extension CliAgentsModel {
    /// Wires the model to the system: notifications go out only when the app is in the background.
    func installNotifier() {
        AgentNotifier.shared.installDelegate()
        notifier = AgentNotifier.shared
        isForeground = { AgentNotifier.foreground }
    }
}

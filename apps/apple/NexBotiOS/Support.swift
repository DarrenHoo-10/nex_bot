import SwiftUI
import NexClientKit

/// Shared look of the iOS screens, following the narrow layout of the web UI.
extension WorkspaceStore {
    func appearance(of bot: Bot) -> AgentAppearance { AgentAppearance.of(bot, firstID: bots.first?.id) }

    func companionState(of botID: String) -> CompanionState {
        CompanionState(task: state?.avatarTask(botID: botID), approval: approvals.contains { $0.botID == botID }, connected: connection != .resyncing)
    }

    /// `animated: nil` follows the web sidebar: move only while thinking or working. Chat header and detail pass `true`.
    func avatar(of bot: Bot, size: CGFloat, animated: Bool? = nil) -> some View {
        WorkspaceAgentAvatar(workspace: self, bot: bot, size: size, animated: animated)
    }
}

private struct WorkspaceAgentAvatar: View {
    let workspace: WorkspaceStore, bot: Bot, size: CGFloat, animated: Bool?
    @Environment(ContactPreferences.self) private var preferences
    var body: some View {
        let state = workspace.companionState(of: bot.id)
        AgentAvatar(appearance: workspace.appearance(of: bot), state: state, size: size,
                    animated: preferences.motionEnabled && (animated ?? [.thinking, .working].contains(state)))
    }
}

/// The account avatar: blue circle with the first character of the account name and an online dot.
struct AccountAvatar: View {
    var size: CGFloat = 32
    var initial = "N"
    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Circle().fill(Theme.brand)
                .overlay(Text(initial).font(.system(size: size * 0.45, weight: .semibold)).foregroundStyle(.white))
            Circle().fill(Theme.success).frame(width: max(8, size * 0.28), height: max(8, size * 0.28))
                .overlay(Circle().stroke(Theme.background, lineWidth: 2))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The avatar letter of the signed-in account (`AccountStatus.initial`).
@MainActor func accountInitial(_ workspace: WorkspaceStore?) -> String {
    (workspace?.account ?? AccountStatus(authenticated: false)).initial
}

/// The signed-in account's display name from Core (`/api/auth/status`).
@MainActor func accountName(_ workspace: WorkspaceStore) -> String {
    workspace.account?.displayName ?? "NexorAI 账号"
}

/// Appearance override: system / light / dark.
enum AppearanceMode: String {
    case system, light, dark
    static let key = "nexbot.dark"
    var scheme: ColorScheme? { self == .light ? .light : self == .dark ? .dark : nil }
}

extension View {
    func cardStyle(radius: CGFloat = 14, stroke: Color = Theme.border) -> some View {
        background(Theme.card, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).stroke(stroke))
    }
}

/// Pill button of the web UI: filled primary or secondary.
struct PillButtonStyle: ButtonStyle {
    var primary = false
    var danger = false
    /// With `primary`: the blue brand fill instead of the neutral primary.
    var brand = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.footnote.weight(.semibold))
            .foregroundStyle(primary ? (brand ? Color.white : Theme.primaryForeground) : danger ? Theme.danger : Theme.foreground)
            .padding(.horizontal, 16).padding(.vertical, 8)
            .background(primary ? (brand ? Theme.brand : Theme.primary) : Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

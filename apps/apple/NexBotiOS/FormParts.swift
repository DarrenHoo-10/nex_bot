import SwiftUI
import NexClientKit

/// Small building blocks shared by the connectors, devices and settings screens.

/// Core's Chinese error text, or the web fallback.
func coreMessage(_ error: Error) -> String {
    if let core = error as? CoreError, !core.message.isEmpty { return core.message }
    let text = error.localizedDescription
    return text.isEmpty ? "操作失败，请重试" : text
}

/// Rounded status chip (已配置, 连接测试通过, 在线, ...).
struct StatusChip: View {
    enum Tone { case neutral, good, warn, bad }
    let text: String
    var tone: Tone = .neutral
    private var color: Color { switch tone { case .neutral: Theme.muted; case .good: Theme.success; case .warn: Theme.approval; case .bad: Theme.danger } }
    private var fill: Color { switch tone { case .neutral: Theme.secondary; case .good: Theme.successSoft; case .warn: Theme.approvalSoft; case .bad: Theme.danger.opacity(0.12) } }
    var body: some View {
        Text(text).font(.caption.weight(.medium)).foregroundStyle(color)
            .padding(.horizontal, 10).padding(.vertical, 3).background(fill, in: Capsule())
    }
}

/// Inline banner for an error or a notice.
struct InlineBanner: View {
    let text: String
    var tone: StatusChip.Tone = .bad
    var body: some View {
        let color: Color = tone == .bad ? Theme.danger : tone == .warn ? Theme.approval : tone == .good ? Theme.success : Theme.muted
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: tone == .good ? "checkmark.circle" : "exclamationmark.triangle").foregroundStyle(color)
            Text(text).font(.footnote).foregroundStyle(tone == .bad ? Theme.danger : Theme.foreground).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// A labelled form field with an optional hint underneath.
struct FormField<Content: View>: View {
    let title: String
    var hint: String?
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.footnote.weight(.semibold))
            content
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            if let hint { Text(hint).font(.caption).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
        }
    }
}

/// Full-width primary action button with tactile press feedback.
struct PrimaryButton: View {
    let title: String
    var busy = false
    /// Kept for call-site compatibility; primary actions use NexBot Bright Blue.
    var brand = true
    let action: () -> Void
    @Environment(\.isEnabled) private var enabled
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy { ProgressView().tint(Color.white) }
                Text(title).font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(Color.white)
            .frame(maxWidth: .infinity).padding(.vertical, 13)
            .background(Theme.brand, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .opacity(enabled ? 1 : 0.4)
        }
        .plainActionFeedback()
    }
}

/// Label/value row used in facts cards.
struct FactRow: View {
    let title: String
    let value: String
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.subheadline)
            Spacer(minLength: 16)
            Text(value).font(.subheadline).foregroundStyle(Theme.muted).multilineTextAlignment(.trailing).textSelection(.enabled)
        }
        .padding(.vertical, 12)
    }
}

/// Section subheading used inside iOS detail screens (title already lives in `.navigationTitle`, so omit redundant headings when `detail` is nil).
struct PageHeading: View {
    let title: String
    var detail: String?
    var showTitle = false
    var body: some View {
        if showTitle || (detail != nil && !(detail ?? "").isEmpty) {
            VStack(alignment: .leading, spacing: 4) {
                if showTitle { Text(title).font(.title3.weight(.bold)) }
                if let detail, !detail.isEmpty {
                    Text(detail).font(.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

// MARK: DEBUG UI automation

/// DEBUG-only: commands from `NEXBOT_DEBUG_UI_FILE` (one `name arg` per line), broadcast so the connectors, devices and
/// settings screens can open sheets and fill forms in simulator runs where taps cannot be scripted.
extension Notification.Name { static let nexbotDebugUI = Notification.Name("nexbot.debugui") }

extension View {
    /// Calls `handler(command, argument)` for every DEBUG UI command. A no-op in release builds.
    @ViewBuilder func onDebugUI(_ handler: @escaping @MainActor (String, String) -> Void) -> some View {
        #if DEBUG
        onReceive(NotificationCenter.default.publisher(for: .nexbotDebugUI)) { note in
            handler(note.userInfo?["cmd"] as? String ?? "", note.userInfo?["arg"] as? String ?? "")
        }
        .onAppear { DebugUIPoller.start() }
        #else
        self
        #endif
    }
}

#if DEBUG
/// One poller serves both `.debugCommand` and `.onDebugUI` (two readers of the same file would consume each other's lines).
@MainActor enum DebugUIPoller {
    static func start() { UIDebug.shared.start() }
}
#endif

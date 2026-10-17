import SwiftUI
import NexClientKit

/// UI-only state shared between the window, commands and menu bar.
@MainActor @Observable
final class UIState {
    /// Incremented by ⌘N; the composer focuses itself when it changes.
    var composerFocusTick = 0
}

@main
struct NexBotMacApp: App {
    @State private var model = AppModel()
    @State private var ui = UIState()

    var body: some Scene {
        Window("NexBot", id: "main") {
            RootView()
                .environment(model)
                .environment(ui)
                .task { await model.start() }
        }
        .defaultSize(width: 1180, height: 760)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("新消息") { ui.composerFocusTick += 1 }
                    .keyboardShortcut("n", modifiers: .command)
                    .disabled(model.workspace == nil)
            }
            CommandGroup(after: .toolbar) {
                Button("停止当前任务") { Task { await currentConversation?.stop() } }
                    .keyboardShortcut(".", modifiers: .command)
                    .disabled(currentConversation?.canStop != true)
                Button("刷新") { Task { await model.workspace?.refresh() } }
                    .keyboardShortcut("r", modifiers: .command)
                    .disabled(model.workspace == nil)
            }
        }

        Settings {
            SettingsView()
                .environment(model)
        }

        MenuBarExtra {
            MenuBarContent()
                .environment(model)
                .environment(ui)
        } label: {
            MenuBarLabel(count: model.workspace?.pendingApprovalCount ?? 0)
        }
    }

    private var currentConversation: ConversationStore? {
        guard let ws = model.workspace, let id = ws.selectedBotID else { return nil }
        return ws.conversation(for: id)
    }
}

/// Switches between launch, login and the connected workspace.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            switch model.phase {
            case .launching:
                ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
            case .resuming, .loggedOut:
                LoginView()
            case .connected:
                if let workspace = model.workspace {
                    MainView(workspace: workspace)
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .frame(minWidth: 420, minHeight: 360)
    }
}

/// Initials avatar with a stable per-name color.
struct AvatarView: View {
    let name: String
    var size: CGFloat = 36

    var body: some View {
        let initial = String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased()
        let hue = Double(name.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) % 360 }) / 360
        Text(initial.isEmpty ? "?" : initial)
            .font(.system(size: size * 0.42, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Color(hue: hue, saturation: 0.45, brightness: 0.72), in: Circle())
            .accessibilityHidden(true)
    }
}

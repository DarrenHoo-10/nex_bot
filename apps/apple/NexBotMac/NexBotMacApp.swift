import SwiftUI
import AppKit
import NexClientKit

/// Tabs of the right "助手详情" column. 资料 was removed; its source stays in `InspectorMemoryTab.swift`, unreferenced.
enum InspectorTab: String, CaseIterable { case work = "工作", settings = "设置" }

/// Categories of the Settings window. Raw values double as the `@AppStorage("nexbot.settingsCategory")` value.
enum SettingsCategory: String, CaseIterable {
    case account = "账号与登录设备", model = "模型", memory = "长期记忆", connectors = "连接器", devices = "设备"
    static let storageKey = "nexbot.settingsCategory"
    var icon: String {
        switch self {
        case .account: "person"; case .model: "key"; case .memory: "sparkles"; case .connectors: "powerplug"; case .devices: "cpu"
        }
    }
}

/// UI-only state shared between the window, commands and menu bar. It is also the navigation router: any view can
/// call `openSettings(_:)` or `openInspector(_:)`.
@MainActor @Observable
final class UIState {
    /// Incremented by ⌘N; the composer focuses itself when it changes.
    var composerFocusTick = 0
    var inspectorVisible = true
    var inspectorTab = InspectorTab.work
    var accountMenuOpen = false
    /// The sidebar search text; non-empty replaces the contact list with message hits.
    var contactSearch = ""
    /// The open composer popover (＋ menu, permission or model); DEBUG commands set it for screenshots.
    var composerMenu: ComposerMenuKind?
    /// The in-app 退出当前账号？ dialog of the main window.
    var logoutConfirmOpen = false
    /// Incremented to open the settings window.
    var settingsTick = 0

    /// Opens the Settings window, optionally at a category (e.g. 模型 from the 驱动模型 pill, 连接器 from the composer).
    func openSettings(_ category: SettingsCategory? = nil) {
        accountMenuOpen = false
        if let category { UserDefaults.standard.set(category.rawValue, forKey: SettingsCategory.storageKey) }
        settingsTick += 1
    }
    /// Shows the inspector at a tab (工作 after clicking a preview).
    func openInspector(_ tab: InspectorTab) { inspectorVisible = true; inspectorTab = tab }
}

/// App-wide appearance override stored in `@AppStorage("nexbot.dark")`: "system", "light" or "dark".
enum AppearanceOverride {
    static let key = "nexbot.dark"
    static func scheme(_ raw: String) -> ColorScheme? { raw == "dark" ? .dark : raw == "light" ? .light : nil }
}

/// Quitting stops the bundled executor first (without revoking the device), so no `node` child is left behind.
final class ExecutorAppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard LocalDeviceController.shared.isRunning else { return .terminateNow }
        Task { @MainActor in
            await LocalDeviceController.shared.shutdown()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

@main
struct NexBotMacApp: App {
    @State private var model = NexBotMacApp.makeModel()
    /// DEBUG fixture runs may keep the session in memory (`NEXBOT_FIXTURE_MEMORY_CREDENTIALS=1`):
    /// the Keychain refuses access while the screen is locked (-25308).
    private static func makeModel() -> AppModel {
        #if DEBUG
        if ProcessInfo.processInfo.environment["NEXBOT_FIXTURE_MEMORY_CREDENTIALS"] == "1", LaunchOptions.current.profile?.hasPrefix("fixture-") == true {
            return AppModel(options: .current, store: InMemoryCredentialStore(), deviceName: AppModel.defaultDeviceName())
        }
        #endif
        return AppModel()
    }
    @State private var ui = UIState()
    @State private var preferences = ContactPreferences()
    @NSApplicationDelegateAdaptor(ExecutorAppDelegate.self) private var appDelegate
    @State private var device = LocalDeviceController.shared
    @AppStorage(AppearanceOverride.key) private var appearance = "system"

    var body: some Scene {
        Window("NexBot", id: "main") {
            RootView()
                .environment(model)
                .environment(ui)
                .environment(preferences)
                .environment(device)
                .preferredColorScheme(AppearanceOverride.scheme(appearance))
                .task {
                    device.attach(model)
                    #if DEBUG
                    LocalDeviceDebug.start(device: device, model: model)
                    MBDebug.start()
                    #endif
                    await model.start()
                }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1440, height: 960)
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("设置…") { ui.openSettings() }.keyboardShortcut(",", modifiers: .command)
            }
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

        Window("设置", id: "settings") {
            SettingsView()
                .environment(model)
                .environment(device)
                .preferredColorScheme(AppearanceOverride.scheme(appearance))
        }
        .windowResizability(.contentSize)

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
    @Environment(UIState.self) private var ui
    @Environment(\.openWindow) private var openWindow

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
        .frame(minWidth: 960, idealWidth: 1440, minHeight: 600, idealHeight: 960)
        .background(Theme.background)
        .background(WindowSizer())
        .onChange(of: ui.settingsTick) { NSApp.activate(ignoringOtherApps: true); openWindow(id: "settings") }
    }
}

/// The account avatar of the web sidebar: a blue circle with the user name initial and a green online dot.
struct PersonAvatar: View {
    var initial = "N"
    var size: CGFloat = 34
    var online = true

    var body: some View {
        Circle().fill(Color(hex: 0x3B66E8))
            .frame(width: size, height: size)
            .overlay(Text(initial).font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(.white))
            .overlay(alignment: .bottomTrailing) {
                if online { Circle().fill(Theme.success).frame(width: size * 0.3, height: size * 0.3)
                    .overlay(Circle().stroke(Theme.background, lineWidth: 2)) }
            }
            .accessibilityHidden(true)
    }
}

extension WorkspaceStore {
    /// What an Agent's avatar and status line show.
    func companionState(_ botID: String) -> CompanionState {
        CompanionState(task: state?.unfinishedTask(botID: botID), approval: approvals.contains { $0.botID == botID }, connected: connection == .connected)
    }
    func appearance(_ bot: Bot) -> AgentAppearance { AgentAppearance.of(bot, firstID: bots.first?.id) }
}

/// A 1pt hairline in the web UI's border color.
struct Hairline: View {
    var vertical = false
    var body: some View {
        Theme.border.frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
    }
}

/// Gives the main window the web UI's 1440 x 960 on first launch, then lets AppKit remember the user's size.
struct WindowSizer: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            guard let window = view.window else { return }
            let key = "NSWindow Frame NexBotMain"
            let fresh = UserDefaults.standard.string(forKey: key) == nil
            window.setFrameAutosaveName("NexBotMain")
            if fresh {
                let visible = window.screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 960)
                window.setContentSize(NSSize(width: min(1440, visible.width), height: min(960, visible.height)))
                window.center()
            }
        }
        return view
    }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

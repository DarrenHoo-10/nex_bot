import SwiftUI
import NexClientKit

/// The connected app: contacts list at the root, everything else pushed. No tab bar, as in the web UI.
struct ConnectedView: View {
    let model: AppModel
    let workspace: WorkspaceStore
    @State private var nav = Navigation()
    @State private var preferences = ContactPreferences()
    @State private var updater = IOSAppUpdater()
    @State private var update: ClientUpdateOffer?
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("nexbot.skippedUpdate") private var skipped = ""
    @State private var agents: CliAgentsModel
    @Environment(\.openURL) private var openURL

    init(model: AppModel, workspace: WorkspaceStore) {
        self.model = model
        self.workspace = workspace
        _agents = State(initialValue: CliAgentsModel(client: { workspace.client }, cacheScope: { workspace.contentCacheScope }))
    }

    private var chatVisible: Bool {
        !nav.agentMode && (nav.isSplit ? nav.path.isEmpty : nav.currentBotID != nil)
    }

    var body: some View {
        lifecycleBoundContacts
            .environment(nav)
            .environment(preferences)
            .environment(updater)
            .sheet(isPresented: $nav.showMenu) {
                AccountMenu(model: model, nav: nav)
                    .environment(nav)
                    .environment(preferences)
            }
            // iOS cannot install itself: tell the person once per version and link the installer.
            .task(id: scenePhase) { await pollUpdates() }
            .alert("新版本 \(update?.version ?? "") 可用", isPresented: Binding(get: { update != nil }, set: { if !$0 { update = nil } })) {
                Button("下载") { if let url = update?.url { openURL(url) }; update = nil }
                Button("稍后", role: .cancel) { skipped = update?.version ?? ""; update = nil }
            }
        #if DEBUG
            .task { await DebugHooks.runCommands(model: model, workspace: workspace, nav: nav) }
        #endif
    }

    private var lifecycleBoundContacts: some View {
        sceneBoundContacts
            .onChange(of: model.credential?.token, initial: false, handleTokenChange)
            .onAppear(perform: configureLifecycle)
    }

    private var sceneBoundContacts: some View {
        agentStreamBoundContacts
            .onChange(of: scenePhase, initial: false, handleScenePhaseChange)
            .onChange(of: agents.notificationsOn, initial: false, handleNotificationsChange)
    }

    private var agentStreamBoundContacts: some View {
        workspaceBoundContacts
            .onChange(of: nav.agentMode, initial: false, handleNavAgentModeChange)
            .onChange(of: nav.path, initial: false, handleNavPathChange)
    }

    private var workspaceBoundContacts: some View {
        ContactsView(model: model, workspace: workspace, agents: agents, nav: nav)
            .task(id: workspace.connection) {
                syncAgentStream()
                if workspace.connection == .connected { await workspace.loadFinanceAssistant() }
            }
            .onChange(of: chatVisible, initial: true, handleChatVisibleChange)
            .onChange(of: workspace.contentCacheScope, initial: false, handleCacheScopeChange)
    }

    private func handleScenePhaseChange(_ previous: ScenePhase, _ next: ScenePhase) {
        syncAgentStream(reconnect: previous == .background && next == .active)
    }

    private func handleNotificationsChange(_: Bool, _: Bool) {
        syncAgentStream()
    }

    private func handleTokenChange(_ old: String?, _ new: String?) {
        if old != nil, new != nil, old != new {
            syncAgentStream(reconnect: true, forceReplace: true)
        }
    }

    private func handleNavAgentModeChange(_: Bool, _: Bool) {
        syncAgentStream()
    }

    private func handleNavPathChange(_: [Navigation.Route], _: [Navigation.Route]) {
        syncAgentStream()
    }

    private func handleChatVisibleChange(_: Bool, _ visible: Bool) {
        workspace.setChatVisible(visible)
    }

    private func handleCacheScopeChange(_ old: String?, _ new: String?) {
        if old != nil || new != nil {
            agents.invalidateCachedTranscripts(waitForScope: new == nil)
        }
    }

    private func configureLifecycle() {
        agents.installNotifier()
        agents.onUnauthorized = {
            Task {
                await workspace.refresh()
                if workspace.connection == .connected { agents.reconnect(force: true) }
            }
        }
        nav.onSelectSplitBot = { botID in
            preferences.selectedAgentID = botID
            workspace.select(botID)
        }
        AgentNotifier.shared.activeBotID = { nav.agentMode ? nil : (nav.currentBotID ?? workspace.selectedBotID) }
        AgentNotifier.shared.onOpenBot = { botID in
            nav.agentMode = false
            preferences.selectedAgentID = botID
            workspace.showLatest(botID: botID)
            workspace.select(botID)
            nav.openChat(botID)
        }
        AgentNotifier.shared.onOpenCliSession = { key in
            nav.agentMode = true
            nav.path = []
            agents.start()
            agents.select(key)
            agents.pendingNavigationKey = key
        }
        workspace.onNotify = { title, body, botID, kind in
            AgentNotifier.shared.notifyBot(title: title, body: body, botID: botID, kind: kind)
        }
        Task { _ = await AgentNotifier.requestAuthorization() }
        syncAgentStream()
    }

    private func pollUpdates() async {
        guard scenePhase == .active else { return }
        while !Task.isCancelled {
            if let offer = await updater.checkIfDue(workspace.client), offer.version != skipped {
                update = offer
            }
            try? await Task.sleep(for: .seconds(5 * 60))
        }
    }

    /// Centralizes NexAgent WebSocket lifecycle on the persistent root view so switching back to NexBot
    /// stops the socket when notifications are disabled, while brief `.inactive` transitions keep it alive.
    private func syncAgentStream(reconnect: Bool = false, forceReplace: Bool = false) {
        let inAgentUI = nav.agentMode || nav.path.contains(.agentSessions)
        let shouldRun = workspace.connection == .connected && (agents.notificationsOn || (inAgentUI && scenePhase != .background))
        if shouldRun {
            if reconnect { agents.reconnect(force: forceReplace) } else { agents.start() }
        } else if !agents.notificationsOn && (!inAgentUI || scenePhase == .background) {
            agents.stop()
        }
    }
}

/// Banner for Core connection state, e.g. 正在重新同步….
struct NoticeBanner: View {
    let text: String
    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
            Text(text).font(.footnote).foregroundStyle(Theme.muted)
        }
        .padding(.horizontal, 14).padding(.vertical, 7)
        .glass(Capsule(), strong: true, lift: .card)
        .frame(maxWidth: .infinity).padding(.vertical, 4)
    }
}

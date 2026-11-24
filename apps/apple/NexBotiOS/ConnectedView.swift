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

    var body: some View {
        ContactsView(model: model, workspace: workspace, agents: agents, nav: nav)
            .task(id: workspace.connection) { if workspace.connection == .connected { await workspace.loadFinanceAssistant() } }
            .onChange(of: workspace.contentCacheScope) { old, new in
                if old != nil || new != nil { agents.invalidateCachedTranscripts(waitForScope: new == nil) }
            }
            .task(id: workspace.connection) { if workspace.connection == .connected, agents.notificationsOn { agents.start() } }
            .onAppear { agents.installNotifier() }
            .environment(nav)
            .environment(preferences)
            .sheet(isPresented: $nav.showMenu) {
                AccountMenu(model: model, nav: nav)
                    .environment(nav)
                    .environment(preferences)
            }
            // iOS cannot install itself: tell the person once per version and link the installer.
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                while !Task.isCancelled {
                    if let offer = await updater.checkIfDue(workspace.client), offer.version != skipped {
                        update = offer
                    }
                    try? await Task.sleep(for: .seconds(5 * 60))
                }
            }
            .alert("新版本 \(update?.version ?? "") 可用", isPresented: Binding(get: { update != nil }, set: { if !$0 { update = nil } })) {
                Button("下载") { if let url = update?.url { openURL(url) }; update = nil }
                Button("稍后", role: .cancel) { skipped = update?.version ?? ""; update = nil }
            }
            .environment(updater)
        #if DEBUG
            .task { await DebugHooks.runCommands(model: model, workspace: workspace, nav: nav) }
        #endif
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

import SwiftUI
import NexClientKit

/// The connected app: contacts list at the root, everything else pushed. No tab bar, as in the web UI.
struct ConnectedView: View {
    let model: AppModel
    let workspace: WorkspaceStore
    @State private var nav = Navigation()
    @State private var preferences = ContactPreferences()

    var body: some View {
        ContactsView(model: model, workspace: workspace, nav: nav)
            .environment(nav)
            .environment(preferences)
            .sheet(isPresented: $nav.showMenu) {
                AccountMenu(model: model, nav: nav)
                    .environment(nav)
                    .environment(preferences)
            }
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
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .background(Theme.secondary)
    }
}

import SwiftUI
import NexClientKit

struct RootTabView: View {
    let model: AppModel
    let workspace: WorkspaceStore
    @State private var nav = Navigation()

    var body: some View {
        TabView(selection: $nav.tab) {
            ContactsView(workspace: workspace, nav: nav)
                .tabItem { Label("会话", systemImage: "bubble.left.and.bubble.right") }
                .tag(Navigation.Tab.chats)
            ApprovalsView(workspace: workspace)
                .tabItem { Label("审批", systemImage: "checkmark.shield") }
                .badge(workspace.pendingApprovalCount)
                .tag(Navigation.Tab.approvals)
            SettingsView(model: model, workspace: workspace)
                .tabItem { Label("设置", systemImage: "gearshape") }
                .tag(Navigation.Tab.settings)
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
            Text(text).font(.footnote)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .background(.thinMaterial)
    }
}

import SwiftUI
import NexClientKit

/// The 连接器 page pushed from the account menu. Placeholder: iOS-B replaces the body.
struct ConnectorsView: View {
    let workspace: WorkspaceStore

    var body: some View {
        VStack(spacing: 8) {
            Text("连接器").font(.title2.weight(.bold))
            Text("\(workspace.state?.connectors.count ?? 0) 个连接器").font(.footnote).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .navigationTitle("连接器")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
    }
}

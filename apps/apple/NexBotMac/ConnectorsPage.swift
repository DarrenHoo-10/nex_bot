import SwiftUI
import NexClientKit

/// Main-area 连接器 page. Placeholder: Mac-B replaces the body.
struct ConnectorsPage: View {
    let workspace: WorkspaceStore

    var body: some View {
        VStack(spacing: 8) {
            Text("连接器").font(.system(size: 20, weight: .bold))
            Text("\(workspace.state?.connectors.count ?? 0) 个连接器").font(.system(size: 12)).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

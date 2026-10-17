import SwiftUI
import NexClientKit

/// Main-area 设备网络 page. Placeholder: Mac-B replaces the body.
struct DevicesPage: View {
    let workspace: WorkspaceStore

    var body: some View {
        VStack(spacing: 8) {
            Text("设备网络").font(.system(size: 20, weight: .bold))
            Text("\(workspace.state?.devices.count ?? 0) 台设备").font(.system(size: 12)).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

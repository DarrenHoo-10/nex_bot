import SwiftUI
import NexClientKit

/// The 设备网络 page pushed from the account menu. Placeholder: iOS-B replaces the body.
struct DevicesView: View {
    let workspace: WorkspaceStore

    var body: some View {
        VStack(spacing: 8) {
            Text("设备网络").font(.title2.weight(.bold))
            Text("\(workspace.state?.devices.count ?? 0) 台设备").font(.footnote).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .navigationTitle("设备网络")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
    }
}

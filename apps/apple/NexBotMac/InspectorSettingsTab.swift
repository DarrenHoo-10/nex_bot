import SwiftUI
import NexClientKit

/// Inspector 设置 tab (motion, about, capabilities, usage, export, archive). Placeholder: Mac-A replaces the body.
struct InspectorSettingsTab: View {
    let workspace: WorkspaceStore
    let botID: String

    var body: some View {
        Text("设置").font(.system(size: 12)).foregroundStyle(Theme.muted)
    }
}

import SwiftUI
import NexClientKit

/// Agent detail 设置 tab (about, capabilities, usage, export, archive). Placeholder: iOS-A replaces the body.
struct AgentSettingsTab: View {
    let workspace: WorkspaceStore
    let botID: String

    var body: some View {
        Text("设置").font(.footnote).foregroundStyle(Theme.muted)
    }
}

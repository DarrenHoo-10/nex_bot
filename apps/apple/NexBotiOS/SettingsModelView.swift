import SwiftUI
import NexClientKit

/// Settings 模型 category content (embedded in SettingsView's scroll view). Placeholder: iOS-B replaces the body.
struct SettingsModelView: View {
    let workspace: WorkspaceStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("模型").font(.title3.weight(.bold))
            Text(workspace.state?.config?.defaultModel ?? "待配置").font(.footnote).foregroundStyle(Theme.muted)
        }
    }
}

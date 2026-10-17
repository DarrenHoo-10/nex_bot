import SwiftUI
import NexClientKit

/// Settings 记忆服务 category content (embedded in SettingsView's scroll view). Placeholder: iOS-B replaces the body.
struct SettingsMemoryView: View {
    let workspace: WorkspaceStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("记忆服务").font(.title3.weight(.bold))
            Text(workspace.state?.memoryPlugin?.statusLabel ?? "当前后端未提供记忆服务配置。").font(.footnote).foregroundStyle(Theme.muted)
        }
    }
}

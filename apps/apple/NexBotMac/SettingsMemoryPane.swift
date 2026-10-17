import SwiftUI
import NexClientKit

/// Settings 记忆服务 category. Placeholder: Mac-B replaces the body.
struct SettingsMemoryPane: View {
    let workspace: WorkspaceStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("记忆服务").font(.system(size: 20, weight: .bold))
            Text(workspace.state?.memoryPlugin?.statusLabel ?? "当前后端未提供记忆服务配置。").font(.system(size: 12)).foregroundStyle(Theme.muted)
        }
    }
}

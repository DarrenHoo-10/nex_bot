import SwiftUI
import NexClientKit

/// Settings 模型 category. Placeholder: Mac-B replaces the body.
struct SettingsModelPane: View {
    let workspace: WorkspaceStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("模型").font(.system(size: 20, weight: .bold))
            Text(workspace.state?.config?.defaultModel ?? "待配置").font(.system(size: 12)).foregroundStyle(Theme.muted)
        }
    }
}

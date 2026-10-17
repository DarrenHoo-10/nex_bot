import SwiftUI
import NexClientKit

/// Inspector 资料 tab (long-term memory, work records, workbench, preview). Placeholder: Mac-A replaces the body.
struct InspectorMemoryTab: View {
    let workspace: WorkspaceStore
    let botID: String

    var body: some View {
        Text("资料").font(.system(size: 12)).foregroundStyle(Theme.muted)
    }
}

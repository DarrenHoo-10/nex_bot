import SwiftUI
import NexClientKit

/// Agent detail 资料 tab (long-term memory, work records, workbench, preview). Placeholder: iOS-A replaces the body.
struct AgentMemoryTab: View {
    let workspace: WorkspaceStore
    let botID: String

    var body: some View {
        Text("资料").font(.footnote).foregroundStyle(Theme.muted)
    }
}

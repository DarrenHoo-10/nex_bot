import SwiftUI
import NexClientKit

/// "{name} 的工具权限": one toggle per action in the web editor's order.
struct PolicyEditorSheet: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(\.dismiss) private var dismiss
    @State private var granted: Set<String> = []
    @State private var saving = false
    @State private var error: String?

    private var bot: Bot? { workspace.bot(botID) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(PolicyCatalog.uiOrder) { action in
                        Toggle(isOn: Binding(
                            get: { granted.contains(action.id) },
                            set: { if $0 { granted.insert(action.id) } else { granted.remove(action.id) } }
                        )) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(action.label).font(.subheadline)
                                Text(action.id).font(.system(size: 10, design: .monospaced)).foregroundStyle(Theme.muted)
                            }
                        }
                        .tint(Theme.success)
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(PolicyCatalog.footnote)
                        SheetError(text: error)
                    }
                }
            }
            .sheetFormStyle()
            .navigationTitle("\(bot?.name ?? "") 的工具权限")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "保存中…" : "保存") { Task { await save() } }.disabled(saving)
                }
            }
            .onAppear { granted = Set(bot?.policyTools ?? []) }
            .debugCommand { command, arg in
                if command == "policytoggle" { if granted.contains(arg) { granted.remove(arg) } else { granted.insert(arg) } }
                if command == "policysave" { Task { await save() } }
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(saving)
    }

    private func save() async {
        saving = true; error = nil
        defer { saving = false }
        let tools = PolicyCatalog.serverOrder.filter(granted.contains)
        do { try await workspace.updatePolicy(botID: botID, tools: tools); dismiss() }
        catch { self.error = message(of: error) }
    }
}

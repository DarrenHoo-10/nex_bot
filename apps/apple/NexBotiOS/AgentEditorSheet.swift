import SwiftUI
import NexClientKit

/// 添加 Agent (`botID == nil`) or Agent 身份: name plus optional instructions.
struct AgentEditorSheet: View {
    let workspace: WorkspaceStore
    var botID: String?
    /// Called with the new agent's id after a successful create.
    var onCreated: (String) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var instructions = ""
    @State private var pending = false
    @State private var error: String?
    @FocusState private var focus: Bool

    private var title: String { botID == nil ? "添加 Agent" : "Agent 身份" }
    private var canSave: Bool { !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !pending }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("名字", text: $name).focused($focus).submitLabel(.next)
                        .accessibilityLabel("名字")
                } header: { Text("名字") }
                Section {
                    TextEditor(text: $instructions)
                        .frame(minHeight: 150)
                        .accessibilityLabel("补充身份、职责与沟通方式（选填）")
                } header: {
                    Text("补充身份、职责与沟通方式（选填）")
                } footer: {
                    Text("名字也是身份的一部分，留空也可以。修改后，其他 Agent 会自动获取最新资料。")
                }
                if let error { Section { SheetError(text: error) } }
            }
            .sheetFormStyle()
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(pending ? "保存中…" : "保存") { Task { await save() } }.disabled(!canSave)
                }
            }
            .onAppear {
                if let botID, let bot = workspace.bot(botID) { name = bot.name; instructions = bot.instructions } else { focus = true }
            }
            .debugCommand { command, arg in
                if command == "agentname" { name = arg }
                if command == "agentinstructions" { instructions = arg }
                if command == "agentsave" { Task { await save() } }
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(pending)
    }

    private func save() async {
        guard canSave else { return }
        pending = true; error = nil
        defer { pending = false }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if let botID {
                try await workspace.updateIdentity(botID: botID, name: String(trimmed.prefix(80)), instructions: instructions)
                dismiss()
            } else {
                let id = try await workspace.createAgent(name: String(trimmed.prefix(80)), instructions: instructions)
                dismiss()
                onCreated(id)
            }
        } catch { self.error = message(of: error) }
    }
}

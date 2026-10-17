import SwiftUI
import NexClientKit

/// 添加记忆 / 编辑记忆. The scope of an existing memory cannot change.
struct MemoryEditorSheet: View {
    let workspace: WorkspaceStore
    let botID: String
    var existing: Memory?
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var content = ""
    @State private var scope = "bot"
    @State private var pending = false
    @State private var error: String?

    private var botName: String { workspace.bot(botID)?.name ?? "Agent" }
    private var canSave: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !pending
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("标题") { TextField("标题", text: $title) }
                Section("记忆内容") { TextEditor(text: $content).frame(minHeight: 140) }
                Section("可见范围") {
                    Picker("可见范围", selection: $scope) {
                        Text("仅 \(botName)").tag("bot")
                        Text("与所有 Agent 共享").tag("workspace")
                    }
                    .pickerStyle(.segmented)
                    .disabled(existing != nil)
                }
                if let error { Section { SheetError(text: error) } }
            }
            .sheetFormStyle()
            .navigationTitle(existing == nil ? "添加记忆" : "编辑记忆")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(pending ? "保存中…" : "保存") { Task { await save() } }.disabled(!canSave)
                }
            }
            .onAppear {
                if let existing { title = existing.title; content = existing.content; scope = existing.scope }
            }
            .debugCommand { command, arg in
                switch command {
                case "memorytitle": title = arg
                case "memorycontent": content = arg
                case "memoryscope": scope = arg
                case "memorysave": Task { await save() }
                default: break
                }
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(pending)
    }

    private func save() async {
        guard canSave else { return }
        pending = true; error = nil
        defer { pending = false }
        do {
            try await workspace.saveMemory(botID: botID, existing: existing, title: String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200)),
                                           content: content.trimmingCharacters(in: .whitespacesAndNewlines), scope: scope)
            dismiss()
        } catch { self.error = message(of: error) }
    }
}

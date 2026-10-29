import SwiftUI
import NexClientKit

// MARK: - 添加 Agent / Agent 身份

struct AgentEditorSheet: View {
    let workspace: WorkspaceStore
    let request: AgentEditorRequest
    @Environment(\.dismiss) private var dismiss
    @Environment(UIState.self) private var ui
    @State private var name = ""
    @State private var instructions = ""
    @State private var error: String?
    @State private var busy = false
    @State private var loaded = false

    private var editing: Bot? { if case .edit(let id) = request { workspace.bot(id) } else { nil } }
    private var valid: Bool { !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            DialogHeader(title: editing == nil ? "添加 Agent" : "Agent 身份") { dismiss() }
            VStack(alignment: .leading, spacing: 6) {
                FieldLabel(text: "名字")
                DialogTextField(placeholder: "名字", text: $name).accessibilityLabel("名字")
            }
            VStack(alignment: .leading, spacing: 6) {
                FieldLabel(text: "补充身份、职责与沟通方式（选填）")
                DialogTextEditor(placeholder: "补充身份、职责与沟通方式", text: $instructions, height: 124).accessibilityLabel("补充身份、职责与沟通方式（选填）")
                Text("名字也是身份的一部分，留空也可以。修改后，其他 Agent 会自动获取最新资料。")
                    .font(.system(size: 11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            if let error { Text(error).font(.system(size: 12)).foregroundStyle(Theme.danger).textSelection(.enabled) }
            HStack(spacing: 8) {
                DialogButton(title: "保存", kind: .primary, disabled: !valid || busy, action: save)
                    .keyboardShortcut(.defaultAction)
                DialogButton(title: "取消") { dismiss() }.keyboardShortcut(.cancelAction)
                if busy { ProgressView().controlSize(.small) }
            }
        }
        .padding(24).frame(width: 460)
        .background(Theme.card)
        .onAppear {
            guard !loaded else { return }
            loaded = true
            if let bot = editing { name = bot.name; instructions = bot.instructions }
        }
    }

    private func save() {
        busy = true; error = nil
        Task {
            do {
                if let bot = editing {
                    try await workspace.updateIdentity(botID: bot.id, name: name.trimmingCharacters(in: .whitespacesAndNewlines), instructions: instructions)
                } else {
                    let id = try await workspace.createAgent(name: name.trimmingCharacters(in: .whitespacesAndNewlines), instructions: instructions)
                    workspace.select(id)
                }
                dismiss()
            } catch { self.error = message(of: error) }
            busy = false
        }
    }
}

// MARK: - 工具权限

struct PolicyEditorSheet: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(\.dismiss) private var dismiss
    @State private var selected: Set<String> = []
    @State private var error: String?
    @State private var busy = false
    @State private var loaded = false

    private var bot: Bot? { workspace.bot(botID) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            DialogHeader(title: "\(bot?.name ?? "Agent") 的工具权限") { dismiss() }
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], alignment: .leading, spacing: 8) {
                ForEach(PolicyCatalog.uiOrder) { action in
                    Button {
                        if (PolicyCatalog.universalActions.contains(action.id) || selected.contains(action.id)) { selected.remove(action.id) } else { selected.insert(action.id) }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: (PolicyCatalog.universalActions.contains(action.id) || selected.contains(action.id)) ? "checkmark.square.fill" : "square")
                                .font(.system(size: 14)).foregroundStyle((PolicyCatalog.universalActions.contains(action.id) || selected.contains(action.id)) ? Theme.brand : Theme.muted)
                            Text(action.label).font(.system(size: 12)).foregroundStyle(Theme.foreground).multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(PolicyCatalog.universalActions.contains(action.id))
                    .accessibilityLabel(action.label)
                    .accessibilityValue((PolicyCatalog.universalActions.contains(action.id) || selected.contains(action.id)) ? "已选择" : "未选择")
                }
            }
            Text(PolicyCatalog.footnote).font(.system(size: 11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            if let error { Text(error).font(.system(size: 12)).foregroundStyle(Theme.danger).textSelection(.enabled) }
            HStack(spacing: 8) {
                DialogButton(title: "保存", kind: .primary, disabled: busy, action: save).keyboardShortcut(.defaultAction)
                DialogButton(title: "取消") { dismiss() }.keyboardShortcut(.cancelAction)
                if busy { ProgressView().controlSize(.small) }
            }
        }
        .padding(24).frame(width: 600)
        .background(Theme.card)
        .onAppear {
            guard !loaded else { return }
            loaded = true
            selected = Set(bot?.policyTools ?? [])
        }
    }

    private func save() {
        busy = true; error = nil
        let tools = PolicyCatalog.orderedTools(selected)
        Task {
            do { try await workspace.updatePolicy(botID: botID, tools: tools); dismiss() }
            catch { self.error = message(of: error) }
            busy = false
        }
    }
}

// MARK: - 长期记忆

struct MemoryEditorSheet: View {
    let workspace: WorkspaceStore
    let request: MemoryRequest
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var content = ""
    @State private var scope = "bot"
    @State private var error: String?
    @State private var busy = false
    @State private var loaded = false

    private var botName: String { workspace.bot(request.botID)?.name ?? "Agent" }
    private var valid: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            DialogHeader(title: request.existing == nil ? "添加记忆" : "编辑记忆") { dismiss() }
            VStack(alignment: .leading, spacing: 6) {
                FieldLabel(text: "标题")
                DialogTextField(placeholder: "标题", text: $title).accessibilityLabel("标题")
            }
            VStack(alignment: .leading, spacing: 6) {
                FieldLabel(text: "记忆内容")
                DialogTextEditor(placeholder: "记忆内容", text: $content, height: 120).accessibilityLabel("记忆内容")
            }
            // The scope is fixed once a memory exists, so the select only appears when creating.
            if request.existing == nil {
                VStack(alignment: .leading, spacing: 6) {
                    FieldLabel(text: "可见范围")
                    Picker("可见范围", selection: $scope) {
                        Text("仅 \(botName)").tag("bot")
                        Text("与所有 Agent 共享").tag("workspace")
                    }
                    .labelsHidden().pickerStyle(.menu).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if let error { Text(error).font(.system(size: 12)).foregroundStyle(Theme.danger).textSelection(.enabled) }
            HStack(spacing: 8) {
                DialogButton(title: "保存", kind: .primary, disabled: !valid || busy, action: save)
                DialogButton(title: "取消") { dismiss() }.keyboardShortcut(.cancelAction)
                if busy { ProgressView().controlSize(.small) }
            }
        }
        .padding(24).frame(width: 460)
        .background(Theme.card)
        .onAppear {
            guard !loaded else { return }
            loaded = true
            if let m = request.existing { title = m.title; content = m.content; scope = m.scope }
        }
    }

    private func save() {
        busy = true; error = nil
        Task {
            do {
                try await workspace.saveMemory(botID: request.botID, existing: request.existing, title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                                               content: content.trimmingCharacters(in: .whitespacesAndNewlines), scope: scope)
                dismiss()
            } catch { self.error = message(of: error) }
            busy = false
        }
    }
}

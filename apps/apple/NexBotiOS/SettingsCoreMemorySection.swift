import SwiftUI
import NexClientKit

/// 核心记忆 (web `CoreMemoryEditor.tsx`): the always-loaded memory of an assistant and of the workspace, edited as plain lines.
/// 关于用户 is one fact per line; 主题索引 is one "标题 — 一句话 (memory:<id>)" per line.
struct CoreMemorySection: View {
    let workspace: WorkspaceStore

    @State private var botID = ""
    @State private var view: CoreMemoryView?
    @State private var error = ""

    private var bots: [Bot] { workspace.bots }
    private var selected: String { bots.contains { $0.id == botID } ? botID : (bots.first?.id ?? "") }
    private var selectedName: String { bots.first { $0.id == selected }?.name ?? "" }

    var body: some View {
        if !bots.isEmpty {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text("核心记忆").font(.subheadline.weight(.semibold))
                    Spacer()
                    if let view { StatusChip(text: view.usageText, tone: .neutral).monospacedDigit() }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("助手").font(.footnote.weight(.semibold))
                    Picker("助手", selection: Binding(get: { selected }, set: { botID = $0 })) {
                        ForEach(bots, id: \.id) { Text($0.name).tag($0.id) }
                    }
                    .pickerStyle(.menu).labelsHidden()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 6).padding(.vertical, 4)
                    .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                if !error.isEmpty { InlineBanner(text: error) }
                if let view {
                    CoreScopeForm(workspace: workspace, botID: selected, scope: .bot, title: selectedName, entry: view.bot, onSaved: { self.view = $0 })
                    CoreScopeForm(workspace: workspace, botID: selected, scope: .workspace, title: "共享", entry: view.workspace, onSaved: { self.view = $0 })
                }
            }
            .task(id: selected) {
                view = nil
                guard !selected.isEmpty else { return }
                do {
                    let result = try await workspace.coreMemory(botID: selected)
                    if !Task.isCancelled { view = result; error = "" }
                } catch {
                    if !Task.isCancelled { self.error = coreMessage(error) }
                }
            }
        }
    }
}

private struct CoreScopeForm: View {
    let workspace: WorkspaceStore
    let botID: String
    let scope: CoreMemoryScope
    let title: String
    let entry: CoreMemoryEntry
    let onSaved: (CoreMemoryView) -> Void

    @State private var about: String
    @State private var topics: String
    @State private var pending = false
    @State private var saved = false
    @State private var error = ""

    init(workspace: WorkspaceStore, botID: String, scope: CoreMemoryScope, title: String, entry: CoreMemoryEntry, onSaved: @escaping (CoreMemoryView) -> Void) {
        self.workspace = workspace; self.botID = botID; self.scope = scope; self.title = title; self.entry = entry; self.onSaved = onSaved
        _about = State(initialValue: CoreMemoryText.aboutText(entry.content.about))
        _topics = State(initialValue: CoreMemoryText.topicText(entry.content.topics))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title).font(.footnote.weight(.semibold))
            lines("关于用户", text: $about)
            lines("主题索引", text: $topics)
            if !error.isEmpty { InlineBanner(text: error) }
            PrimaryButton(title: pending ? "保存中…" : "保存", busy: pending, brand: true, action: save).disabled(pending)
            if saved { Label("已保存", systemImage: "checkmark").font(.subheadline.weight(.medium)).foregroundStyle(Theme.success) }
        }
        .disabled(pending)
        .padding(14).cardStyle()
        .onChange(of: entry.version) {
            about = CoreMemoryText.aboutText(entry.content.about)
            topics = CoreMemoryText.topicText(entry.content.topics)
        }
    }

    private func lines(_ label: String, text: Binding<String>) -> some View {
        FormField(title: label) {
            TextEditor(text: Binding(get: { text.wrappedValue }, set: { text.wrappedValue = $0; saved = false }))
                .scrollContentBackground(.hidden).textInputAutocapitalization(.never).autocorrectionDisabled()
                .frame(minHeight: 110)
                .accessibilityLabel(label)
        }
    }

    private func save() {
        guard !pending else { return }
        let aboutLines: [String], topicLines: [CoreMemoryTopic]
        do { aboutLines = CoreMemoryText.parseAbout(about); topicLines = try CoreMemoryText.parseTopics(topics) }
        catch { self.error = coreMessage(error); saved = false; return }
        pending = true; saved = false; error = ""
        Task {
            defer { pending = false }
            do {
                let result = try await workspace.saveCoreMemory(botID: botID, scope: scope, about: aboutLines, topics: topicLines, version: entry.version)
                saved = true
                onSaved(result)
            } catch { self.error = coreMessage(error) }
        }
    }
}

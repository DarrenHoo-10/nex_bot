import SwiftUI
import NexClientKit

/// 核心记忆 (web `CoreMemoryEditor.tsx`): the always-loaded memory of an assistant and of the workspace, edited as plain lines.
/// 关于用户 is one fact per line; 主题索引 is one "标题 — 一句话 (memory:<id>)" per line.
struct CoreMemorySection: View {
    let workspace: WorkspaceStore
    /// The 长期记忆 category is showing: the lines are read on every show and whenever the assistant changes.
    let active: Bool

    @State private var botID = ""
    @State private var view: CoreMemoryView?
    @State private var error = ""

    private var bots: [Bot] { workspace.bots }
    private var selected: String { bots.contains { $0.id == botID } ? botID : (bots.first?.id ?? "") }
    private var selectedName: String { bots.first { $0.id == selected }?.name ?? "" }

    var body: some View {
        if !bots.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("核心记忆").font(.system(size: 13, weight: .semibold))
                    Spacer()
                    if let view {
                        Text(view.usageText).font(.system(size: 10)).foregroundStyle(Theme.muted).monospacedDigit()
                            .padding(.horizontal, 8).padding(.vertical, 4).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 5))
                            .accessibilityIdentifier("core-memory-usage")
                    }
                }
                MBSelect(label: "助手", selection: Binding(get: { selected }, set: { botID = $0 }), options: bots.map { ($0.id, $0.name) })
                    .padding(.top, 16)
                if !error.isEmpty { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled).padding(.top, 12) }
                if let view {
                    CoreScopeForm(workspace: workspace, botID: selected, scope: .bot, title: selectedName, entry: view.bot, onSaved: { self.view = $0 })
                        .padding(.top, 22)
                    CoreScopeForm(workspace: workspace, botID: selected, scope: .workspace, title: "共享", entry: view.workspace, onSaved: { self.view = $0 })
                        .padding(.top, 22)
                }
            }
            .task(id: "\(active)|\(selected)") {
                view = nil
                guard active, !selected.isEmpty else { return }
                do {
                    let result = try await workspace.coreMemory(botID: selected)
                    if !Task.isCancelled { view = result; error = "" }
                } catch {
                    if !Task.isCancelled { self.error = mbFallbackMessage(error) }
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
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(.system(size: 12, weight: .semibold))
            VStack(alignment: .leading, spacing: 20) {
                lines("关于用户", text: $about)
                lines("主题索引", text: $topics)
            }
            .disabled(pending)
            .padding(.top, 16)
            if !error.isEmpty { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled).padding(.top, 12) }
            HStack(spacing: 14) {
                MBButton(title: pending ? "保存中…" : "保存", kind: .brand, busy: pending, action: save)
                if saved {
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark").font(.system(size: 11)); Text("已保存").font(.system(size: 12))
                    }
                    .foregroundStyle(Theme.muted)
                }
            }
            .padding(.top, 18)
        }
        .onChange(of: entry.version) {
            about = CoreMemoryText.aboutText(entry.content.about)
            topics = CoreMemoryText.topicText(entry.content.topics)
        }
    }

    private func lines(_ label: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.system(size: 12, weight: .medium))
            TextEditor(text: Binding(get: { text.wrappedValue }, set: { text.wrappedValue = $0; saved = false }))
                .font(.system(size: 12)).scrollContentBackground(.hidden).autocorrectionDisabled()
                .padding(.horizontal, 7).padding(.vertical, 6).frame(height: 104)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
                .accessibilityLabel(label).accessibilityIdentifier("\(scope.rawValue)-\(label)")
        }
    }

    private func save() {
        guard !pending else { return }
        let aboutLines: [String], topicLines: [CoreMemoryTopic]
        do { aboutLines = CoreMemoryText.parseAbout(about); topicLines = try CoreMemoryText.parseTopics(topics) }
        catch { self.error = mbFallbackMessage(error); saved = false; return }
        pending = true; saved = false; error = ""
        Task {
            defer { pending = false }
            do {
                let result = try await workspace.saveCoreMemory(botID: botID, scope: scope, about: aboutLines, topics: topicLines, version: entry.version)
                saved = true
                onSaved(result)
            } catch { self.error = mbFallbackMessage(error) }
        }
    }
}

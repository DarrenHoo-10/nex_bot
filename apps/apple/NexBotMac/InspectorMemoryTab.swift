import SwiftUI
import NexClientKit

/// Inspector 资料 tab: preview card, long-term memory, work records, memory workbench and the engine footnote.
struct InspectorMemoryTab: View {
    let workspace: WorkspaceStore
    let botID: String

    private enum Filter: Hashable { case all, bot, workspace }

    @State private var filter = Filter.all
    @State private var deleting: Memory?
    @State private var error: String?
    /// Survives the workbench reset that the refresh after a forget triggers.
    @State private var forgotten = ""

    private var agentUI: AgentUI { AgentUI.shared }

    var body: some View {
        let state = workspace.state
        let memories = state?.memories(botID: botID) ?? []
        let active = memories.count > 1 ? filter : .all
        let shown = memories.filter { active == .all || $0.scope == (active == .workspace ? "workspace" : "bot") }
        VStack(alignment: .leading, spacing: 22) {
            if let item = agentUI.preview, agentUI.previewBotID == botID { PreviewCard(item: item) { agentUI.preview = nil } }

            VStack(alignment: .leading, spacing: 10) {
                InspectorSectionTitle(title: "长期记忆", addLabel: "添加记忆") { agentUI.editMemory(botID: botID) }
                if memories.count > 1 {
                    HStack(spacing: 6) {
                        scopePill("全部 (\(memories.count))", .all, active)
                        scopePill("仅当前 Agent", .bot, active)
                        scopePill("共享", .workspace, active)
                    }
                }
                ForEach(shown) { memory in memoryCard(memory) }
                if let error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled) }
                Text("消息与工作记录自动保存。长期记忆可在这里维护，也可以让 Agent 帮你记住。")
                    .font(.system(size: 11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: 10) {
                InspectorSectionTitle(title: "已有工作记录")
                ForEach(state?.journal(botID: botID) ?? []) { entry in JournalRow(entry: entry) }
            }

            if let engine = state?.memoryEngine, let sync = state?.sync {
                MemoryWorkbench(workspace: workspace, botID: botID, forgotten: $forgotten)
                    .id("\(botID)|\(engine.revision)|\(sync.bootId)|\(sync.privacyEpoch)")
                Text(engine.footnote).font(.system(size: 11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .alert("撤回这条记忆？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("取消", role: .cancel) { deleting = nil }.keyboardShortcut(.cancelAction)
            Button("确认", role: .destructive) { if let memory = deleting { delete(memory) }; deleting = nil }
        } message: { Text("撤回后不再用于长期记忆检索，原始消息和工作记录保留。如需一起清理，请使用下方的彻底遗忘。") }
    }

    private func scopePill(_ title: String, _ value: Filter, _ active: Filter) -> some View {
        Button { filter = value } label: {
            Text(title).font(.system(size: 11)).foregroundStyle(active == value ? Theme.primaryForeground : Theme.foreground)
                .padding(.horizontal, 10).frame(height: 24)
                .background(active == value ? Theme.primary : Theme.secondary, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func memoryCard(_ memory: Memory) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(memory.title).font(.system(size: 12, weight: .semibold))
            Text(memory.scopeLabel + (memory.updatedAt.map { " · \(TimeFormat.formatShortTime($0))" } ?? ""))
                .font(.system(size: 10)).foregroundStyle(Theme.muted)
            Text(memory.content).font(.system(size: 12)).foregroundStyle(Theme.foreground).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button { agentUI.editMemory(botID: botID, existing: memory) } label: {
                    Text("编辑").font(.system(size: 11)).foregroundStyle(Theme.foreground)
                        .padding(.horizontal, 10).frame(height: 24)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Theme.border))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Button { deleting = memory } label: {
                    Image(systemName: "trash").font(.system(size: 11)).foregroundStyle(Theme.foreground)
                        .frame(width: 28, height: 24)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Theme.border))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).help("撤回\(memory.title)").accessibilityLabel("撤回\(memory.title)")
            }
        }
        .fieldCard()
    }

    private func delete(_ memory: Memory) {
        error = nil
        Task {
            do { try await workspace.deleteMemory(memory) } catch { self.error = message(of: error) }
        }
    }
}

// MARK: - Work record

private struct JournalRow: View {
    let entry: JournalEntry
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { open.toggle() } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold)).rotationEffect(.degrees(open ? 90 : 0)).foregroundStyle(Theme.muted)
                    Text(String(entry.objective.prefix(100))).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.foreground)
                        .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                Text(entry.result).font(.system(size: 12)).foregroundStyle(Theme.foreground).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                if let at = entry.createdAt { Text(TimeFormat.formatTime(at)).font(.system(size: 10)).foregroundStyle(Theme.muted) }
            }
        }
        .fieldCard()
    }
}

// MARK: - Preview card

private struct PreviewCard: View {
    let item: PreviewItem
    let close: () -> Void
    @State private var copied = false
    @State private var showArguments = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.displayTitle).font(.system(size: 12, weight: .semibold)).lineLimit(2)
                    Text(item.subtitle).font(.system(size: 10)).foregroundStyle(Theme.muted).lineLimit(2).truncationMode(.middle)
                }
                Spacer(minLength: 4)
                Button(action: copy) {
                    Text(copied ? "已复制" : "复制").font(.system(size: 11)).foregroundStyle(Theme.foreground)
                        .padding(.horizontal, 9).frame(height: 24)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Theme.border))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Button(action: close) {
                    Image(systemName: "xmark").font(.system(size: 10)).foregroundStyle(Theme.foreground).frame(width: 24, height: 24).contentShape(Rectangle())
                }
                .buttonStyle(.plain).help("关闭预览").accessibilityLabel("关闭预览")
            }
            if let arguments = item.arguments, !arguments.isEmpty {
                Button { showArguments.toggle() } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold)).rotationEffect(.degrees(showArguments ? 90 : 0))
                        Text("调用参数").font(.system(size: 11))
                    }
                    .foregroundStyle(Theme.muted).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if showArguments { code(arguments) }
            }
            code(item.content.isEmpty ? "暂无内容" : item.content)
        }
        .fieldCard()
        .accessibilityElement(children: .contain).accessibilityLabel("内容预览")
    }

    private func code(_ text: String) -> some View {
        ScrollView {
            Text(text).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).padding(8)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 220)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func copy() {
        AgentUI.shared.copyToPasteboard(item.content)
        copied = true
        Task { try? await Task.sleep(for: .seconds(1.8)); copied = false }
    }
}

// MARK: - Workbench

/// 查找与综合 and 彻底遗忘. Re-created (via `.id`) whenever the memory engine revision or the sync generation changes.
private struct MemoryWorkbench: View {
    let workspace: WorkspaceStore
    let botID: String
    @Binding var forgotten: String
    @State private var query = ""
    @State private var status = ""
    @State private var busy = false
    @State private var facts: [MemoryFact] = []
    @State private var answers: [MemoryAnswer] = []
    @State private var expanded: [String: String] = [:]
    @State private var forgetPreview: ForgetPreview?
    @State private var forgetQuery = ""

    private var empty: Bool { query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var botNames: [String: String] { Dictionary(workspace.bots.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a }) }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            VStack(alignment: .leading, spacing: 10) {
                Text("查找与综合").font(.system(size: 12, weight: .bold))
                Text("问题或主题").font(.system(size: 11, weight: .medium))
                TextField("例如：我之前确定了哪些项目约束？", text: $query)
                    .textFieldStyle(.plain).font(.system(size: 12))
                    .padding(.horizontal, 10).frame(height: 34)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
                    .onSubmit { if !empty { find() } }
                    .accessibilityLabel("问题或主题")
                HStack(spacing: 8) {
                    action("查找", disabled: empty || busy, action: find)
                    action("综合记忆", disabled: empty || busy, action: reflect)
                    if busy { ProgressView().controlSize(.small) }
                }
                Text("只检索当前 Agent 的私有记忆与共享记忆。综合会调用你配置的模型。")
                    .font(.system(size: 11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                let line = status.isEmpty ? forgotten : status
                if !line.isEmpty { Text(line).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.foreground).textSelection(.enabled).accessibilityLabel("状态 \(line)") }
                ForEach(answers) { answer in answerCard(answer) }
                ForEach(facts) { fact in factCard(fact) }
            }

            VStack(alignment: .leading, spacing: 10) {
                Text("彻底遗忘").font(.system(size: 12, weight: .bold))
                Text("按上面输入的主题预览清理范围。相关原文、已记录的同伴副本和综合结果一起清理，受影响的工作会停止。")
                    .font(.system(size: 11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                action("预览遗忘范围", disabled: empty || busy, action: previewForgetScope)
            }
        }
        .alert("确认遗忘这些记录？", isPresented: Binding(get: { forgetPreview != nil }, set: { if !$0 { forgetPreview = nil } })) {
            Button("取消", role: .cancel) { forgetPreview = nil }.keyboardShortcut(.cancelAction)
            Button("确认", role: .destructive) { if let preview = forgetPreview { forget(preview) }; forgetPreview = nil }
        } message: { Text(forgetPreview?.confirmationDetail(botNames: botNames) ?? "") }
    }

    private func action(_ title: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.foreground)
                .padding(.horizontal, 12).frame(height: 28)
                .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .opacity(disabled ? 0.45 : 1).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(disabled)
    }

    // MARK: Cards

    private func factCard(_ fact: MemoryFact) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(fact.caption).font(.system(size: 10)).foregroundStyle(Theme.muted)
            Text(fact.text).font(.system(size: 12)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            refs(fact.refs, label: { fact.refs.count > 1 ? "原文来源 \($0 + 1)" : "查看原文" })
        }
        .fieldCard()
    }

    private func answerCard(_ answer: MemoryAnswer) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(answer.caption).font(.system(size: 10)).foregroundStyle(Theme.muted)
            Text(answer.text).font(.system(size: 12)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            refs(answer.refs, label: { "来源 \($0 + 1)" })
        }
        .fieldCard()
    }

    private func refs(_ refs: [String], label: @escaping (Int) -> String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(refs.enumerated()), id: \.offset) { index, ref in
                Button { expand(ref) } label: {
                    Text(label(index)).font(.system(size: 11)).foregroundStyle(Theme.brand).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if let text = expanded[ref] {
                    Text(text).font(.system(size: 11)).foregroundStyle(Theme.foreground).textSelection(.enabled)
                        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: Actions

    private func run(_ body: @escaping () async throws -> Void) {
        busy = true
        Task {
            do { try await body() } catch {
                let text = message(of: error)
                status = text.isEmpty ? "记忆操作失败" : text
            }
            busy = false
        }
    }

    private func find() {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        run {
            let result = try await workspace.recallMemory(botID: botID, query: text)
            facts = result.facts; answers = []; expanded = [:]; forgotten = ""
            status = result.statusText
        }
    }

    private func reflect() {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        run {
            let result = try await workspace.reflectMemory(botID: botID, query: text)
            answers = result.answers; facts = []; expanded = [:]; forgotten = ""
            status = result.statusText
        }
    }

    private func expand(_ ref: String) {
        if expanded[ref] != nil { expanded[ref] = nil; return }
        run {
            let result = try await workspace.expandMemory(botID: botID, ref: ref)
            expanded[ref] = result.content
        }
    }

    private func previewForgetScope() {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        run {
            let preview = try await workspace.previewForget(botID: botID, query: text)
            forgetQuery = text
            forgetPreview = preview
        }
    }

    private func forget(_ preview: ForgetPreview) {
        run {
            let result = try await workspace.forget(botID: botID, query: forgetQuery, preview: preview)
            status = ""; forgotten = result.statusText
            facts = []; answers = []; expanded = [:]
        }
    }
}

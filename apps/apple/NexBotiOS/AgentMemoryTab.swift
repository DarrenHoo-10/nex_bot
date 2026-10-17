import SwiftUI
import NexClientKit

/// Agent detail 资料 tab: preview card, long-term memory, work records and the memory workbench.
struct AgentMemoryTab: View {
    let workspace: WorkspaceStore
    let botID: String

    enum Scope: String, CaseIterable { case all, bot, shared }
    @State private var scope = Scope.all
    @State private var editor: EditorTarget?
    @State private var deleting: Memory?
    @State private var errorText: String?

    struct EditorTarget: Identifiable {
        let memory: Memory?
        var id: String { memory?.id ?? "new" }
    }

    private var preview: PreviewItem? { PreviewCenter.shared.items[botID] }
    private var memories: [Memory] { workspace.state?.memories(botID: botID) ?? [] }
    private var shown: [Memory] {
        switch scope {
        case .all: memories
        case .bot: memories.filter { !$0.isShared }
        case .shared: memories.filter(\.isShared)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            if let preview {
                PreviewCard(item: preview) { PreviewCenter.shared.items[botID] = nil }
            }
            longTerm
            records
            if let engine = workspace.state?.memoryEngine, let sync = workspace.sync {
                MemoryWorkbench(workspace: workspace, botID: botID, engine: engine)
                    .id("\(botID)|\(engine.revision)|\(sync.bootId)|\(sync.privacyEpoch)")
            }
        }
        .sheet(item: $editor) { target in MemoryEditorSheet(workspace: workspace, botID: botID, existing: target.memory) }
        .alert("撤回这条记忆？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { memory in
            Button("确认", role: .destructive) { Task { await retract(memory) } }
            Button("取消", role: .cancel) {}
        } message: { _ in
            Text("撤回后不再用于长期记忆检索，原始消息和工作记录保留。如需一起清理，请使用下方的彻底遗忘。")
        }
        .errorAlert($errorText)
        .debugCommand { command, arg in
            switch command {
            case "memoryadd": editor = EditorTarget(memory: nil)
            case "memoryedit": if let m = memories.first(where: { !$0.isShared }) ?? memories.first { editor = EditorTarget(memory: m) }
            case "memorydelete": deleting = memories.first
            case "memoryconfirmdelete": if let m = deleting { Task { await retract(m) }; deleting = nil }
            case "memoryfilter": if let s = Scope(rawValue: arg) { scope = s }
            default: break
            }
        }
    }

    // MARK: Long-term memory

    private var longTerm: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "长期记忆", trailing: ("plus", "添加记忆", { editor = EditorTarget(memory: nil) }))
            if memories.count > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        Chip(title: "全部 (\(memories.count))", selected: scope == .all) { scope = .all }
                        Chip(title: "仅当前 Agent", selected: scope == .bot) { scope = .bot }
                        Chip(title: "共享", selected: scope == .shared) { scope = .shared }
                    }
                }
            }
            ForEach(shown) { memory in memoryCard(memory) }
            Text("消息与工作记录自动保存。长期记忆可在这里维护，也可以让 Agent 帮你记住。")
                .font(.footnote).foregroundStyle(Theme.muted)
        }
    }

    private func memoryCard(_ memory: Memory) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(memory.title).font(.subheadline.weight(.semibold))
            Text(memory.scopeLabel + (memory.updatedAt.map { " · \(TimeFormat.formatShortTime($0))" } ?? ""))
                .font(.caption2).foregroundStyle(Theme.muted)
            Text(memory.content).font(.footnote).textSelection(.enabled)
            HStack(spacing: 8) {
                Button("编辑") { editor = EditorTarget(memory: memory) }.buttonStyle(PillButtonStyle())
                Spacer()
                Button { deleting = memory } label: { Image(systemName: "trash").frame(width: 32, height: 30) }
                    .buttonStyle(.plain).foregroundStyle(Theme.danger).accessibilityLabel("撤回\(memory.title)")
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading).cardStyle()
    }

    private func retract(_ memory: Memory) async {
        do { try await workspace.deleteMemory(memory) } catch { errorText = message(of: error) }
    }

    // MARK: Work records

    @ViewBuilder private var records: some View {
        let journal = workspace.state?.journal(botID: botID) ?? []
        VStack(alignment: .leading, spacing: 8) {
            Text("已有工作记录").font(.footnote.weight(.bold))
            if journal.isEmpty { Text("完成的工作会记录在这里。").font(.footnote).foregroundStyle(Theme.muted) }
            ForEach(journal) { entry in
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(entry.result).font(.footnote).textSelection(.enabled)
                        if let date = entry.createdAt { Text(TimeFormat.formatTime(date)).font(.caption2).foregroundStyle(Theme.muted) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
                } label: {
                    Text(String(entry.objective.prefix(100))).font(.footnote.weight(.semibold)).foregroundStyle(Theme.foreground).lineLimit(2)
                }
                .tint(Theme.muted)
                Divider().overlay(Theme.border)
            }
        }
    }
}

/// 内容预览: a file or a tool call opened from the chat.
struct PreviewCard: View {
    let item: PreviewItem
    let close: () -> Void
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.isTool ? item.displayTitle : (item.path.map { ($0 as NSString).lastPathComponent } ?? item.title))
                        .font(.subheadline.weight(.semibold)).lineLimit(2)
                    if !item.subtitle.isEmpty { Text(item.subtitle).font(.caption).foregroundStyle(Theme.muted).lineLimit(2) }
                }
                Spacer(minLength: 8)
                Button(copied ? "已复制" : "复制") { copy() }.buttonStyle(PillButtonStyle())
                Button(action: close) { Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).frame(width: 30, height: 30) }
                    .buttonStyle(.plain).foregroundStyle(Theme.muted).accessibilityLabel("关闭预览")
            }
            if let arguments = item.arguments, !arguments.isEmpty {
                DisclosureGroup("调用参数") {
                    Text(arguments).font(.system(.caption2, design: .monospaced)).textSelection(.enabled)
                        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .font(.footnote).tint(Theme.muted)
            }
            ScrollView(.vertical) {
                Text(item.content.isEmpty ? "暂无内容" : item.content).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 260)
            .padding(10).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .padding(12).cardStyle()
        .accessibilityElement(children: .contain).accessibilityLabel("内容预览")
    }

    private func copy() {
        UIPasteboard.general.string = item.content
        copied = true
        Task { try? await Task.sleep(for: .seconds(1.8)); copied = false }
    }
}

/// 查找与综合 and 彻底遗忘.
struct MemoryWorkbench: View {
    let workspace: WorkspaceStore
    let botID: String
    let engine: MemoryEngineStatus
    @State private var query = ""
    @State private var status: String?
    @State private var facts: [MemoryFact] = []
    @State private var answers: [MemoryAnswer] = []
    @State private var expanded: [String: String] = [:]
    @State private var busy = false
    @State private var pendingForget: ForgetPreview?

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("查找与综合").font(.footnote.weight(.bold))
            VStack(alignment: .leading, spacing: 6) {
                Text("问题或主题").font(.caption.weight(.semibold))
                TextField("例如：我之前确定了哪些项目约束？", text: $query)
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.border))
                    .onChange(of: query) { if query.count > 200 { query = String(query.prefix(200)) } }
                    .submitLabel(.search).onSubmit { Task { await find() } }
            }
            HStack(spacing: 8) {
                Button("查找") { Task { await find() } }.buttonStyle(PillButtonStyle(primary: true))
                Button("综合记忆") { Task { await reflect() } }.buttonStyle(PillButtonStyle())
                if busy { ProgressView() }
            }
            .disabled(trimmed.isEmpty || busy)
            Text("只检索当前 Agent 的私有记忆与共享记忆。综合会调用你配置的模型。").font(.footnote).foregroundStyle(Theme.muted)
            if let status { Text(status).font(.footnote.weight(.medium)).accessibilityAddTraits(.updatesFrequently) }
            ForEach(facts) { fact in factCard(fact) }
            ForEach(answers) { answer in answerCard(answer) }

            VStack(alignment: .leading, spacing: 8) {
                Text("彻底遗忘").font(.footnote.weight(.bold))
                Text("按上面输入的主题预览清理范围。相关原文、已记录的同伴副本和综合结果一起清理，受影响的工作会停止。")
                    .font(.footnote).foregroundStyle(Theme.muted)
                Button("预览遗忘范围") { Task { await previewForget() } }
                    .buttonStyle(PillButtonStyle(danger: true)).disabled(trimmed.isEmpty || busy)
            }
            .padding(.top, 6)
            Text(engine.footnote).font(.footnote).foregroundStyle(Theme.muted)
        }
        .alert("确认遗忘这些记录？", isPresented: Binding(get: { pendingForget != nil }, set: { if !$0 { pendingForget = nil } }), presenting: pendingForget) { preview in
            Button("确认", role: .destructive) { Task { await forget(preview) } }
            Button("取消", role: .cancel) {}
        } message: { preview in
            Text(preview.confirmationDetail(botNames: Dictionary(workspace.bots.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })))
        }
        .debugCommand { command, arg in
            switch command {
            case "find": query = arg; Task { await find() }
            case "reflect": query = arg; Task { await reflect() }
            case "expand": if let ref = facts.first?.refs.first ?? answers.first?.refs.first { Task { await expand(ref) } }
            case "forgetpreview": query = arg; Task { await previewForget() }
            case "forgetconfirm": if let p = pendingForget { Task { await forget(p) } }
            default: break
            }
        }
    }

    private func factCard(_ fact: MemoryFact) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(fact.caption).font(.caption2).foregroundStyle(Theme.muted)
            Text(fact.text).font(.footnote).textSelection(.enabled)
            refButtons(fact.refs, plain: "查看原文", numbered: "原文来源")
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading).cardStyle()
    }

    private func answerCard(_ answer: MemoryAnswer) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(answer.caption).font(.caption2).foregroundStyle(Theme.muted)
            Text(answer.text).font(.footnote).textSelection(.enabled)
            refButtons(answer.refs, plain: nil, numbered: "来源")
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading).cardStyle()
    }

    @ViewBuilder private func refButtons(_ refs: [String], plain: String?, numbered: String) -> some View {
        ForEach(Array(refs.enumerated()), id: \.offset) { index, ref in
            let title = refs.count == 1 ? (plain ?? "\(numbered) 1") : "\(numbered) \(index + 1)"
            if let content = expanded[ref] {
                VStack(alignment: .leading, spacing: 4) {
                    Button { expanded[ref] = nil } label: { Text("\(title) · 收起").font(.caption.weight(.semibold)) }.buttonStyle(.plain).foregroundStyle(Theme.brand)
                    Text(content).font(.caption).textSelection(.enabled)
                        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            } else {
                Button { Task { await expand(ref) } } label: { Text(title).font(.caption.weight(.semibold)) }.buttonStyle(.plain).foregroundStyle(Theme.brand)
            }
        }
    }

    // MARK: Actions

    private func find() async {
        guard !trimmed.isEmpty, !busy else { return }
        busy = true; defer { busy = false }
        do {
            let result = try await workspace.recallMemory(botID: botID, query: trimmed)
            facts = result.facts; answers = []; status = result.statusText
        } catch { status = (error as? CoreError)?.message ?? "记忆操作失败" }
    }

    private func reflect() async {
        guard !trimmed.isEmpty, !busy else { return }
        busy = true; defer { busy = false }
        do {
            let result = try await workspace.reflectMemory(botID: botID, query: trimmed)
            answers = result.answers; facts = []; status = result.statusText
        } catch { status = (error as? CoreError)?.message ?? "记忆操作失败" }
    }

    private func expand(_ ref: String) async {
        do { expanded[ref] = try await workspace.expandMemory(botID: botID, ref: ref).content }
        catch { status = (error as? CoreError)?.message ?? "记忆操作失败" }
    }

    private func previewForget() async {
        guard !trimmed.isEmpty, !busy else { return }
        busy = true; defer { busy = false }
        do { pendingForget = try await workspace.previewForget(botID: botID, query: trimmed) }
        catch { status = (error as? CoreError)?.message ?? "记忆操作失败" }
    }

    private func forget(_ preview: ForgetPreview) async {
        busy = true; defer { busy = false }
        do {
            let result = try await workspace.forget(botID: botID, query: trimmed, preview: preview)
            status = result.statusText; facts = []; answers = []; expanded = [:]
        } catch { status = (error as? CoreError)?.message ?? "记忆操作失败" }
    }
}

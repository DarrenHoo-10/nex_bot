import SwiftUI
import NexClientKit

/// One durable Todo surface shared by the native Mac and iPhone clients.
struct TodosView: View {
    let workspace: WorkspaceStore
    let openAgent: (String) -> Void
    @State private var items: [TodoItem] = []
    @State private var period = "week"
    @State private var filter = "all"
    @State private var anchor = Date()
    @State private var query = ""
    @State private var selected: String?
    @State private var editing: TodoItem?
    @State private var errorText = ""
    @State private var busy = false
    @State private var loaded = false
    @State private var serial = 0
    private var days: [Date] { TodoDates.days(anchor, period: period) }
    private var filtered: [TodoItem] { items.filter { $0.matches(filter) && (query.isEmpty || ($0.title + $0.description).localizedCaseInsensitiveContains(query)) } }
    private var selectedItem: TodoItem? { items.first { $0.id == selected } }

    var body: some View {
        VStack(spacing: 16) {
            HStack {
                Text("待办").font(.title2.bold()); Spacer()
                Button { editing = TodoItem(date: TodoDates.key(anchor)) } label: { Label("新建待办", systemImage: "plus") }.buttonStyle(.borderedProminent).tint(Theme.identityAccent)
            }
            HStack {
                TextField("搜索待办", text: $query).textFieldStyle(.roundedBorder)
                Picker("时间视角", selection: $period) { Text("日").tag("day"); Text("周").tag("week"); Text("月").tag("month") }.pickerStyle(.segmented).frame(maxWidth: 170)
            }
            HStack {
                DatePicker("查看日期", selection: $anchor, displayedComponents: .date).labelsHidden()
                Spacer()
                Button { move(-1) } label: { Image(systemName: "chevron.left") }.accessibilityLabel("上一时段")
                Button("今天") { anchor = Date() }
                Button { move(1) } label: { Image(systemName: "chevron.right") }.accessibilityLabel("下一时段")
            }.buttonStyle(.borderless)
            Picker("状态筛选", selection: $filter) { Text("全部").tag("all"); Text("进行中").tag("running"); Text("未开始").tag("todo"); Text("已完成").tag("done") }.pickerStyle(.segmented)
            if !errorText.isEmpty { HStack { Text(errorText).foregroundStyle(.red).font(.caption); Button("重试") { Task { await load() } } } }
            if !loaded { ProgressView().frame(maxHeight: .infinity) }
            else { ScrollView {
                if period == "month" { monthGrid }
                else {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(days, id: \.self) { day in
                            let list = filtered.filter { $0.date == TodoDates.key(day) }
                            HStack { Button(day.formatted(.dateTime.month().day().weekday())) { anchor = day; period = "day" }.foregroundStyle(Theme.muted); Spacer(); Button { editing = TodoItem(date: TodoDates.key(day)) } label: { Image(systemName: "plus") }.accessibilityLabel("在这一天添加待办") }.buttonStyle(.plain)
                            if list.isEmpty { Text("暂无待办").font(.caption).foregroundStyle(Theme.muted).padding(.bottom, 8) }
                            ForEach(list) { item in row(item) }
                        }
                    }
                }
                let unscheduled = filtered.filter { $0.date.isEmpty }
                if !unscheduled.isEmpty { DisclosureGroup("未安排 · \(unscheduled.count)") { ForEach(unscheduled) { item in row(item) } }.padding(.top, 18) }
            } }
        }
        .padding(20).background { WorkspaceSurface(kind: .stage) }
        .task(id: workspace.sync) { if workspace.state == nil { items = []; selected = nil; editing = nil; loaded = false; serial += 1 } else { await load() } }
        .sheet(isPresented: Binding(get: { editing != nil || selectedItem != nil }, set: { if !$0 { selected = nil; editing = nil } })) {
            if let item = editing {
                TodoEditor(workspace: workspace, original: item) { _ in await load() }
            } else if let item = selectedItem {
                TodoDetails(workspace: workspace, item: item, busy: busy, error: errorText,
                    action: { action, feedback in await act(item, action, feedback) },
                    edit: { editing = item }, close: { selected = nil },
                    openAgent: { selected = nil; openAgent(item.owner) })
            }
        }
    }
    private func row(_ item: TodoItem) -> some View {
        Button { selected = item.id } label: {
            HStack(spacing: 12) {
                Image(systemName: item.status == "done" ? "checkmark.circle.fill" : item.status == "running" ? "arrow.trianglehead.2.clockwise" : "circle").foregroundStyle(Theme.identityAccent)
                VStack(alignment: .leading, spacing: 5) { Text(item.title).foregroundStyle(Theme.foreground); Text(item.statusTitle).font(.caption).foregroundStyle(Theme.muted) }
                Spacer(); Text(owner(item)).font(.caption).foregroundStyle(Theme.muted)
            }.padding(12).glass(RoundedRectangle(cornerRadius: 14), strong: true, lift: .card)
        }.buttonStyle(.plain)
    }
    private var monthGrid: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 7), spacing: 6) {
            ForEach(["一", "二", "三", "四", "五", "六", "日"], id: \.self) { Text($0).font(.caption).foregroundStyle(Theme.muted) }
            ForEach(days, id: \.self) { day in
                let count = filtered.filter { $0.date == TodoDates.key(day) }.count
                Button { anchor = day; period = "day" } label: {
                    VStack(spacing: 6) { Text("\(TodoDates.calendar.component(.day, from: day))"); Text(count > 0 ? "\(count) 项" : " ").font(.system(size: 10)) }
                        .frame(maxWidth: .infinity, minHeight: 58)
                        .background(TodoDates.key(day) == TodoDates.key(Date()) ? Theme.identityAccent.opacity(0.12) : Theme.secondary.opacity(0.3), in: RoundedRectangle(cornerRadius: 9))
                        .opacity(TodoDates.calendar.isDate(day, equalTo: anchor, toGranularity: .month) ? 1 : 0.4)
                }.buttonStyle(.plain)
            }
        }
    }
    private func owner(_ item: TodoItem) -> String { item.owner == "me" ? "我" : workspace.bot(item.owner)?.name ?? "已归档 Agent" }
    private func move(_ amount: Int) { anchor = TodoDates.calendar.date(byAdding: period == "month" ? .month : .day, value: amount * (period == "week" ? 7 : 1), to: anchor) ?? anchor }
    private func load() async {
        serial += 1; let current = serial
        do { let response: TodoList = try await workspace.client.get("/api/todos"); if current == serial && workspace.state != nil { items = response.items; loaded = true } }
        catch { if current == serial && !Task.isCancelled { errorText = CoreError.wrap(error).message; loaded = true } }
    }
    private func act(_ item: TodoItem, _ action: String, _ feedback: String?) async {
        guard !busy else { return }; busy = true; errorText = ""; defer { busy = false }
        do { try await workspace.client.post("/api/todos/action", body: TodoAction(item, action: action, feedback: feedback)); if action == "delete" { selected = nil }; await load() }
        catch { errorText = CoreError.wrap(error).message; await load() }
    }
}

private struct TodoEditor: View {
    let workspace: WorkspaceStore
    let original: TodoItem
    let saved: (TodoItem) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var draft: TodoItem
    @State private var busy = false
    @State private var errorText = ""
    init(workspace: WorkspaceStore, original: TodoItem, saved: @escaping (TodoItem) async -> Void) { self.workspace = workspace; self.original = original; self.saved = saved; _draft = State(initialValue: original) }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(original.version == 0 ? "新建待办" : "编辑待办").font(.title2.bold())
            TextField("要做什么", text: $draft.title).textFieldStyle(.roundedBorder)
            Text("完成要求").font(.caption).foregroundStyle(Theme.muted)
            TextEditor(text: $draft.description).frame(minHeight: 100, maxHeight: 160).padding(8).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 12))
            Picker("交给谁", selection: $draft.owner) { Text("我").tag("me"); ForEach(workspace.bots) { bot in Text(bot.name).tag(bot.id) } }
            Toggle("设置截止日期", isOn: Binding(get: { !draft.date.isEmpty }, set: { draft.date = $0 ? TodoDates.key(Date()) : "" }))
            if !draft.date.isEmpty { DatePicker("截止日期", selection: Binding(get: { TodoDates.parse(draft.date) ?? Date() }, set: { draft.date = TodoDates.key($0) }), displayedComponents: .date) }
            Picker("优先级", selection: $draft.priority) { Text("高").tag("高"); Text("普通").tag("普通"); Text("低").tag("低") }.pickerStyle(.segmented)
            if !errorText.isEmpty { Text(errorText).font(.caption).foregroundStyle(.red) }
            HStack { Spacer(); Button("取消") { dismiss() }; Button(busy ? "保存中…" : "保存") { Task { await save() } }.buttonStyle(.borderedProminent).tint(Theme.identityAccent).disabled(draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
        }.padding(24).frame(minWidth: 280, idealWidth: 480).disabled(busy).interactiveDismissDisabled(busy)
    }
    private func save() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do { let updated: TodoItem = try await workspace.client.post("/api/todos/save", body: draft); await saved(updated); dismiss() }
        catch { errorText = CoreError.wrap(error).message }
    }
}

private struct TodoDetails: View {
    let workspace: WorkspaceStore
    let item: TodoItem
    let busy: Bool
    let error: String
    let action: (String, String?) async -> Void
    let edit: () -> Void
    let close: () -> Void
    let openAgent: () -> Void
    @State private var feedback = ""
    @State private var revise = false
    @State private var deleting = false
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Text(item.statusTitle).font(.caption).foregroundStyle(Theme.identityAccent); Spacer(); Button("关闭", action: close) }
            Text(item.title).font(.title2.bold())
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    LabeledContent("负责人", value: item.owner == "me" ? "我" : workspace.bot(item.owner)?.name ?? "已归档 Agent")
                    LabeledContent("截止日期", value: item.date.isEmpty ? "未设置" : item.date)
                    LabeledContent("优先级", value: item.priority)
                    Text(item.description).textSelection(.enabled)
                    ForEach(Array(item.steps.enumerated()), id: \.offset) { _, step in Label(step.text, systemImage: step.done ? "checkmark.circle" : "circle") }
                    if !item.result.isEmpty { Text(item.result).textSelection(.enabled).padding(12).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 12)) }
                    if item.owner != "me" { Button("打开对话与审批", action: openAgent) }
                    DisclosureGroup("动态记录") { ForEach(Array(item.log.enumerated()), id: \.offset) { _, text in Text(text).font(.caption).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4) } }
                    if revise && item.status == "review" { TextField("告诉 AI 要调整什么", text: $feedback, axis: .vertical).textFieldStyle(.roundedBorder); Button("提交修改要求") { Task { await action("start", feedback) } }.disabled(feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                }
            }
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red) }
            HStack {
                if item.status != "running" || item.taskId == nil { Button("编辑", action: edit); Button("删除", role: .destructive) { deleting = true } }
                Spacer()
                if item.status == "running" {
                    Button(item.taskId == nil ? "暂停处理" : "停止执行") { Task { await action("stop", nil) } }
                    if item.taskId == nil { Button("标记完成") { Task { await action("complete", nil) } }.buttonStyle(.borderedProminent).tint(Theme.identityAccent) }
                }
                else if item.status == "done" { Button("重新打开") { Task { await action("reopen", nil) } } }
                else { if item.status == "review" { Button("继续修改") { revise.toggle() } } else if item.owner == "me" { Button("开始处理") { Task { await action("begin", nil) } } } else if item.owner != "me" { Button("交给 AI") { Task { await action("start", nil) } } }; Button("确认完成") { Task { await action("complete", nil) } }.buttonStyle(.borderedProminent).tint(Theme.identityAccent) }
            }.disabled(busy)
        }.padding(24).frame(minWidth: 280, idealWidth: 520, minHeight: 420)
        .confirmationDialog("删除这条待办？", isPresented: $deleting) { Button("删除", role: .destructive) { Task { await action("delete", nil) } } }
    }
}

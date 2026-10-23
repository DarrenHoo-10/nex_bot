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
                        if selected.contains(action.id) { selected.remove(action.id) } else { selected.insert(action.id) }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: selected.contains(action.id) ? "checkmark.square.fill" : "square")
                                .font(.system(size: 14)).foregroundStyle(selected.contains(action.id) ? Theme.brand : Theme.muted)
                            Text(action.label).font(.system(size: 12)).foregroundStyle(Theme.foreground).multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(action.label)
                    .accessibilityValue(selected.contains(action.id) ? "已选择" : "未选择")
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

// MARK: - 例行任务

struct RoutineEditorSheet: View {
    let workspace: WorkspaceStore
    let request: RoutineRequest
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var prompt = ""
    @State private var kind = ScheduleKind.daily
    @State private var time = Date()
    @State private var minutes = "60"
    @State private var runAt = Date().addingTimeInterval(3600)
    @State private var timeZone = TimeZone.current.identifier
    @State private var error: String?
    @State private var busy = false
    @State private var loaded = false

    private var valid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !timeZone.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            DialogHeader(title: request.existing == nil ? "添加例行任务" : "编辑例行任务") { dismiss() }
            field("名称") { DialogTextField(placeholder: "例如：每日工作计划", text: $name).accessibilityLabel("名称") }
            field("让 Agent 做什么") {
                DialogTextEditor(placeholder: "描述目标、需要参考的资料和汇报方式", text: $prompt, height: 90).accessibilityLabel("让 Agent 做什么")
            }
            field("执行计划") {
                Picker("执行计划", selection: $kind) {
                    ForEach(ScheduleKind.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .labelsHidden().pickerStyle(.menu).frame(maxWidth: .infinity, alignment: .leading)
            }
            switch kind {
            case .daily:
                field("每天的时间") { DatePicker("每天的时间", selection: $time, displayedComponents: .hourAndMinute).labelsHidden().datePickerStyle(.field) }
            case .interval:
                field("间隔（分钟）") { DialogTextField(placeholder: "60", text: $minutes).accessibilityLabel("间隔（分钟）") }
            case .once:
                field("执行时间（本机时间）") { DatePicker("执行时间", selection: $runAt, displayedComponents: [.date, .hourAndMinute]).labelsHidden().datePickerStyle(.field) }
            }
            field("时区") { DialogTextField(placeholder: TimeZone.current.identifier, text: $timeZone).accessibilityLabel("时区") }
            Text("按计划唤醒 Agent 会调用你配置的模型。需要批准的工具操作仍会等待你处理。")
                .font(.system(size: 11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            if let error { Text(error).font(.system(size: 12)).foregroundStyle(Theme.danger).textSelection(.enabled) }
            HStack(spacing: 8) {
                DialogButton(title: "保存", kind: .primary, disabled: !valid || busy, action: save)
                DialogButton(title: "取消") { dismiss() }.keyboardShortcut(.cancelAction)
                if let existing = request.existing {
                    DialogButton(title: "现在执行", disabled: busy) { runNow(existing) }
                }
                if busy { ProgressView().controlSize(.small) }
            }
        }
        .padding(24).frame(width: 460)
        .background(Theme.card)
        .onAppear(perform: load)
    }

    private func field<C: View>(_ label: String, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) { FieldLabel(text: label); content() }
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        guard let r = request.existing else { time = Self.date(from: "09:00"); return }
        name = r.name; prompt = r.prompt; kind = r.scheduleKind; timeZone = r.timeZone
        time = Self.date(from: r.localTime ?? "09:00")
        if r.intervalMs > 0 { minutes = String(r.intervalMinutes) }
    }

    private static func date(from hhmm: String) -> Date {
        let parts = hhmm.split(separator: ":").compactMap { Int($0) }
        var c = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        c.hour = parts.first ?? 9; c.minute = parts.count > 1 ? parts[1] : 0
        return Calendar.current.date(from: c) ?? Date()
    }

    private func runNow(_ routine: Routine) {
        busy = true; error = nil
        Task {
            do { try await workspace.runRoutine(routine); dismiss() } catch { self.error = message(of: error) }
            busy = false
        }
    }

    private func save() {
        let schedule: RoutineSchedule
        switch kind {
        case .daily:
            let c = Calendar.current.dateComponents([.hour, .minute], from: time)
            schedule = .daily(localTime: String(format: "%02d:%02d", c.hour ?? 9, c.minute ?? 0))
        case .interval: schedule = .interval(minutes: Int(minutes.trimmingCharacters(in: .whitespaces)) ?? 0)
        case .once: schedule = .once(at: runAt)
        }
        busy = true; error = nil
        Task {
            do {
                try await workspace.saveRoutine(botID: request.botID, existing: request.existing, name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                                                prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines), schedule: schedule,
                                                timeZone: timeZone.trimmingCharacters(in: .whitespaces))
                dismiss()
            } catch { self.error = message(of: error) }
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

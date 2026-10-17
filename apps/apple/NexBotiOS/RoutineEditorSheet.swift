import SwiftUI
import NexClientKit

/// 添加例行任务 / 编辑例行任务.
struct RoutineEditorSheet: View {
    let workspace: WorkspaceStore
    let botID: String
    var existing: Routine?
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var prompt = ""
    @State private var kind = ScheduleKind.daily
    @State private var time = Date()
    @State private var minutes = "60"
    @State private var runAt = Date().addingTimeInterval(3600)
    @State private var timeZone = TimeZone.current.identifier
    @State private var pending = false
    @State private var error: String?

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !pending
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("名称") {
                    TextField("例如：每日工作计划", text: $name)
                }
                Section("让 Agent 做什么") {
                    TextEditor(text: $prompt).frame(minHeight: 100)
                        .overlay(alignment: .topLeading) {
                            if prompt.isEmpty {
                                Text("描述目标、需要参考的资料和汇报方式").foregroundStyle(Theme.muted).padding(.top, 8).padding(.leading, 5).allowsHitTesting(false)
                            }
                        }
                }
                Section("执行计划") {
                    Picker("执行计划", selection: $kind) {
                        ForEach(ScheduleKind.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    switch kind {
                    case .daily:
                        DatePicker("每天的时间", selection: $time, displayedComponents: .hourAndMinute)
                    case .interval:
                        HStack {
                            Text("间隔（分钟）")
                            Spacer()
                            TextField("60", text: $minutes).keyboardType(.numberPad).multilineTextAlignment(.trailing).frame(width: 100)
                        }
                    case .once:
                        DatePicker("执行时间（本机时间）", selection: $runAt, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                    }
                    HStack {
                        Text("时区")
                        Spacer()
                        TextField("Asia/Shanghai", text: $timeZone)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .multilineTextAlignment(.trailing).foregroundStyle(Theme.muted)
                    }
                }
                Section {
                    SheetError(text: error)
                } footer: {
                    Text("按计划唤醒 Agent 会调用你配置的模型。需要批准的工具操作仍会等待你处理。")
                }
            }
            .sheetFormStyle()
            .navigationTitle(existing == nil ? "添加例行任务" : "编辑例行任务")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(pending ? "保存中…" : "保存") { Task { await save() } }.disabled(!canSave)
                }
            }
            .onAppear(perform: load)
            .debugCommand { command, arg in
                switch command {
                case "routinename": name = arg
                case "routineprompt": prompt = arg
                case "routinekind": if let k = ScheduleKind(rawValue: arg) { kind = k }
                case "routinesave": Task { await save() }
                default: break
                }
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(pending)
    }

    private func load() {
        guard let existing else { return }
        name = existing.name; prompt = existing.prompt; kind = existing.scheduleKind; timeZone = existing.timeZone
        if existing.intervalMinutes > 0 { minutes = String(existing.intervalMinutes) }
        if let local = existing.localTime {
            let parts = local.split(separator: ":").compactMap { Int($0) }
            if parts.count == 2, let date = Calendar.current.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: Date()) { time = date }
        }
    }

    private func save() async {
        guard canSave else { return }
        error = nil
        let zone = timeZone.trimmingCharacters(in: .whitespaces)
        guard TimeZone(identifier: zone) != nil else { error = "Invalid time zone specified: \(zone)"; return }
        let schedule: RoutineSchedule
        switch kind {
        case .daily:
            let c = Calendar.current.dateComponents([.hour, .minute], from: time)
            schedule = .daily(localTime: String(format: "%02d:%02d", c.hour ?? 9, c.minute ?? 0))
        case .interval:
            guard let value = Int(minutes.trimmingCharacters(in: .whitespaces)), (1...525_600).contains(value) else { error = "间隔须为 1 分钟至 365 天"; return }
            schedule = .interval(minutes: value)
        case .once:
            guard runAt > Date() else { error = "执行时间须在未来"; return }
            schedule = .once(at: runAt)
        }
        pending = true
        defer { pending = false }
        do {
            try await workspace.saveRoutine(botID: botID, existing: existing, name: String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(100)),
                                            prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines), schedule: schedule, timeZone: zone)
            dismiss()
        } catch { self.error = message(of: error) }
    }
}

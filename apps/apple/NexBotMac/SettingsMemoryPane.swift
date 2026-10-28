import SwiftUI
import NexClientKit

/// Settings 长期记忆 category (web `MemoryDashboard.tsx`): one account-wide switch, one memory model (empty follows the
/// account default model) and lifetime memory token usage. External Hindsight settings and per-assistant statistics are hidden.
struct SettingsMemoryPane: View {
    let workspace: WorkspaceStore
    /// The category is showing: the summary is read now and every 5 s.
    var active = true

    @State private var summary: MemorySummary?
    @State private var busy = false
    @State private var error = ""
    @State private var pickerOpen = false
    /// Bumped on every deactivation or connection change so a late answer from before is dropped.
    @State private var generation = 0
    @State private var saving = false

    private var config: ModelConfig? { workspace.state?.config }
    private var defaultModel: String { (config?.defaultModel).flatMap { $0.isEmpty ? nil : $0 } ?? "未配置" }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            paneHeader("长期记忆")
            HStack {
                Text("开启长期记忆").font(.system(size: 13, weight: .semibold))
                Spacer()
                Toggle("开启长期记忆", isOn: Binding(get: { summary?.enabled ?? false }, set: { save(enabled: $0) }))
                    .labelsHidden().toggleStyle(.switch).controlSize(.small)
                    .disabled(summary == nil || busy).accessibilityIdentifier("memory-switch")
            }
            .padding(.top, 24)
            Text("开启后会增加 Token 消耗。").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.top, 6)
            ModelPickerField(label: "选择记忆模型", title: "记忆模型", value: summary?.model ?? "", emptyLabel: "默认模型 · \(defaultModel)",
                             models: workspace.state?.modelVisibility.models, source: workspace.savedModelSource(),
                             disabled: summary == nil || busy, identifier: "memory-model", debugPrefix: "mp", isOpen: $pickerOpen,
                             onChange: { save(model: $0) })
                .padding(.top, 22)
            VStack(alignment: .leading, spacing: 6) {
                Text("总 Token").font(.system(size: 11)).foregroundStyle(Theme.muted)
                Text(summary?.totalLabel ?? "—").font(.system(size: 22, weight: .semibold)).monospacedDigit()
                    .accessibilityIdentifier("memory-total")
            }
            .padding(16).frame(minWidth: 180, alignment: .leading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.border))
            .padding(.top, 24)
            if !error.isEmpty { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled).padding(.top, 12) }
            if !workspace.bots.isEmpty { Hairline().padding(.vertical, 28) }
            CoreMemorySection(workspace: workspace, active: active)
        }
        .task(id: "\(active)|\(workspace.state?.sync.privacyEpoch ?? 0)|\(config?.providerID ?? "")|\(config?.endpoint ?? "")") {
            generation += 1
            summary = nil; error = ""
            guard active else { return }
            let mine = generation
            while !Task.isCancelled, generation == mine {
                await poll(mine)
                try? await Task.sleep(for: .seconds(5))
            }
        }
        #if DEBUG
        .task { MBDebug.start() }
        .onReceive(NotificationCenter.default.publisher(for: .mbDebug)) { note in
            guard let cmd = note.mbCommand, cmd.prefix == "mm" else { return }
            switch cmd.verb {
            case "on": save(enabled: true)
            case "off": save(enabled: false)
            case "toggle": save(enabled: !(summary?.enabled ?? false))
            case "open": pickerOpen = true
            case "close": pickerOpen = false
            case "pick": save(model: cmd.arg == "-" ? "" : cmd.arg)
            case "state": mbLog("memory enabled=\(summary?.enabled.description ?? "nil") model=\(summary?.model ?? "nil") version=\(summary?.version ?? -1) total=\(summary?.totalLabel ?? "nil") error=\(error)")
            default: break
            }
        }
        #endif
    }

    private func poll(_ mine: Int) async {
        guard !saving else { return }
        do {
            let value = try await workspace.memorySummary()
            guard generation == mine, !saving else { return }
            if summary == nil || value.version >= (summary?.version ?? 0) { summary = value }
            error = ""
        } catch {
            if generation == mine { self.error = mbFallbackMessage(error) }
        }
    }

    private func save(enabled: Bool? = nil, model: String? = nil) {
        guard let current = summary, !saving else { return }
        let mine = generation
        saving = true; busy = true; error = ""
        Task {
            defer { saving = false; busy = false }
            do {
                let value = try await workspace.saveMemorySettings(enabled: enabled ?? current.enabled, model: model ?? current.model, version: current.version)
                if generation == mine { summary = value }
            } catch {
                guard generation == mine else { return }
                self.error = mbFallbackMessage(error)
                if let value = try? await workspace.memorySummary(), generation == mine { summary = value }
            }
        }
    }
}

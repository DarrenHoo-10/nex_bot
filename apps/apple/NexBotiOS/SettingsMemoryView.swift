import SwiftUI
import NexClientKit

/// Settings 长期记忆 category (web `MemoryDashboard.tsx`): one account-wide switch, one memory model (empty follows the
/// account default model) and lifetime memory token usage. External Hindsight settings and per-assistant statistics are hidden.
struct SettingsMemoryView: View {
    let workspace: WorkspaceStore

    @State private var summary: MemorySummary?
    @State private var busy = false
    @State private var error = ""
    @State private var pickerOpen = false
    /// Bumped on every connection change so a late answer from before is dropped.
    @State private var generation = 0
    @State private var saving = false

    private var config: ModelConfig? { workspace.state?.config }
    private var defaultModel: String { (config?.defaultModel).flatMap { $0.isEmpty ? nil : $0 } ?? "未配置" }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            PageHeading(title: "长期记忆")
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Toggle(isOn: Binding(get: { summary?.enabled ?? false }, set: { save(enabled: $0) })) {
                        Text("开启长期记忆").font(.subheadline.weight(.semibold))
                    }
                    .disabled(summary == nil || busy)
                    Text("开启后会增加 Token 消耗。").font(.footnote).foregroundStyle(Theme.muted)
                }
                ModelPickerField(label: "选择记忆模型", title: "记忆模型", value: summary?.model ?? "", emptyLabel: "默认模型 · \(defaultModel)",
                                 models: workspace.state?.modelVisibility.models, source: workspace.savedModelSource(),
                                 disabled: summary == nil || busy, isOpen: $pickerOpen, onChange: { save(model: $0) })
            }
            .padding(14).cardStyle()
            VStack(alignment: .leading, spacing: 6) {
                Text("总 Token").font(.caption).foregroundStyle(Theme.muted)
                Text(summary?.totalLabel ?? "—").font(.title2.weight(.semibold)).monospacedDigit()
            }
            .padding(14).frame(maxWidth: .infinity, alignment: .leading).cardStyle()
            if !error.isEmpty { InlineBanner(text: error) }
            CoreMemorySection(workspace: workspace)
        }
        .task(id: "\(workspace.state?.sync.privacyEpoch ?? 0)|\(config?.providerID ?? "")|\(config?.endpoint ?? "")") {
            generation += 1
            summary = nil; error = ""
            let mine = generation
            while !Task.isCancelled, generation == mine {
                await poll(mine)
                try? await Task.sleep(for: .seconds(5))
            }
        }
        .onDebugUI { cmd, arg in
            switch cmd {
            case "mm-on": save(enabled: true)
            case "mm-off": save(enabled: false)
            case "mm-toggle": save(enabled: !(summary?.enabled ?? false))
            case "mm-open": pickerOpen = true
            case "mm-close": pickerOpen = false
            case "mm-pick": save(model: arg == "-" ? "" : arg)
            case "mm-state": mbLogUI("memory enabled=\(summary?.enabled.description ?? "nil") model=\(summary?.model ?? "nil") version=\(summary?.version ?? -1) total=\(summary?.totalLabel ?? "nil") error=\(error)")
            default: break
            }
        }
    }

    private func poll(_ mine: Int) async {
        guard !saving else { return }
        do {
            let value = try await workspace.memorySummary()
            guard generation == mine, !saving else { return }
            if summary == nil || value.version >= (summary?.version ?? 0) { summary = value }
            error = ""
        } catch {
            if generation == mine { self.error = coreMessage(error) }
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
                self.error = coreMessage(error)
                if let value = try? await workspace.memorySummary(), generation == mine { summary = value }
            }
        }
    }
}

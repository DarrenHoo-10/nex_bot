import SwiftUI
import NexClientKit

struct TranslationModelSection: View {
    let workspace: WorkspaceStore
    var active = true
    @State private var settings: CliTranslationSettings?
    @State private var viewedProvider = ""
    @State private var pickerOpen = false
    @State private var saving = false
    @State private var error = ""

    private var providers: [ModelConnection] { (workspace.state?.connections ?? []).filter(\.usable) }
    private var provider: ModelConnection? {
        providers.first { $0.id == viewedProvider }
            ?? providers.first { $0.id == settings?.selection?.connectionId }
            ?? providers.first
    }

    private var selectedAvailable: Bool {
        guard let choice = settings?.selection, let selected = providers.first(where: { $0.id == choice.connectionId }) else { return false }
        return selected.models?.contains(choice.model) ?? true
    }

    private var status: String {
        if saving { return "保存中…" }
        if settings == nil { return "未加载" }
        if settings?.selection == nil { return "未启用" }
        return selectedAvailable ? "已启用" : "所选模型不可用"
    }

    var body: some View {
        #if os(iOS)
        content.padding(14).cardStyle()
        #else
        content
        #endif
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("翻译服务").font(.subheadline.weight(.semibold))
                Spacer()
                Text(status).font(.caption).foregroundStyle(Theme.muted)
            }
            if let settings {
                if let provider {
                    if providers.count > 1 {
                        Picker("供应商", selection: Binding(get: { provider.id }, set: { viewedProvider = $0 })) {
                            ForEach(providers) { Text($0.name).tag($0.id) }
                        }
                        .pickerStyle(.menu).disabled(saving)
                    }
                    let value = settings.selection?.connectionId == provider.id && selectedAvailable ? settings.selection?.model ?? "" : ""
                    let source = ModelSource(cacheKey: "\(ModelCatalogCache.key(workspace, provider: provider.provider, endpoint: provider.endpoint, secret: ""))|\(provider.id)",
                                             fetch: { try await workspace.listModels(connectionID: provider.id) })
                    ModelPickerField(label: "选择翻译模型", value: value, models: provider.models, source: source,
                                     disabled: saving, allowCustom: false, names: provider.names, isOpen: $pickerOpen) { model in
                        guard !model.isEmpty else { return }
                        Task { await save(.init(connectionId: provider.id, model: model)) }
                    }
                    .id(provider.id)
                } else {
                    Text("请先连接模型").font(.caption).foregroundStyle(Theme.muted)
                }
                if settings.selection != nil {
                    Button("关闭翻译") { Task { await save(nil) } }.disabled(saving)
                }
            }
            if !error.isEmpty {
                Text(error).font(.caption).foregroundStyle(Theme.danger)
                if settings == nil { Button("重试") { Task { await load() } } }
            }
        }
        .task(id: active) {
            if active { await load() }
        }
    }

    private func load() async {
        error = ""
        do {
            let value = try await workspace.cliTranslationSettings()
            if !Task.isCancelled { settings = value }
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }

    private func save(_ selection: CliTranslationSelection?) async {
        guard let settings, !saving else { return }
        saving = true
        error = ""
        defer { saving = false }
        do {
            self.settings = try await workspace.saveCliTranslationSettings(selection, version: settings.version)
        } catch {
            if let latest = try? await workspace.cliTranslationSettings() { self.settings = latest }
            self.error = error.localizedDescription
        }
    }
}

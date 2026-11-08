import SwiftUI
import NexClientKit

/// 显示的模型 (web `ModelVisibility.tsx`): choose which models the pickers offer.
/// `selection == nil` shows the whole provider directory; an array is a shortlist.
/// For the saved connection every change saves at once (``ModelSelectionAutosave``). For a connection still being
/// edited (`draft`), the choice is reported through `onSelection` and saved with the connection.
struct ModelVisibilitySection: View {
    let workspace: WorkspaceStore
    let active: Bool
    /// Models fetched with 获取模型列表 in the connection form.
    var fetched: [String] = []
    var draft = false
    var onSelection: ([String]?) -> Void = { _ in }

    @State private var catalog: [String] = []
    @State private var draftSelection: [String]?
    @State private var autosave: ModelSelectionAutosave?
    @State private var loading = false
    @State private var notice = ""
    @State private var error = ""
    @State private var custom = ""
    @State private var onlySelected = false
    @State private var loaded = false

    private var stored: ModelVisibility { workspace.state?.modelVisibility ?? ModelVisibility() }
    private var defaultModel: String { workspace.state?.config?.defaultModel ?? "" }
    private var selection: [String]? { draft ? draftSelection : (autosave?.selection ?? stored.models) }
    private var all: [String] {
        var seen = Set<String>()
        return (catalog + fetched + (selection ?? []) + (draft ? [] : [defaultModel])).filter { !$0.isEmpty && seen.insert($0).inserted }.sorted()
    }
    private var selected: Set<String> { Set(selection ?? all) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("显示的模型").font(.system(size: 13, weight: .semibold))
                Spacer()
                Text(selection == nil ? "全部显示" : "已选 \(selection?.count ?? 0) 个").font(.system(size: 10)).foregroundStyle(Theme.muted)
                    .padding(.horizontal, 8).padding(.vertical, 4).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 5))
                    .accessibilityIdentifier("visibility-status")
            }
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    MBButton(title: "全选", enabled: selection != nil) { edit(nil) }
                    MBButton(title: "全不选", enabled: selection?.isEmpty != true) { edit([]) }
                    MBButton(title: onlySelected ? "查看全部" : "只看已选") { onlySelected.toggle() }
                    if !draft { MBButton(title: loading ? "获取中…" : "刷新目录", enabled: !loading) { Task { await load(force: true) } } }
                    Spacer()
                }
                ModelListView(models: onlySelected ? selected.sorted() : all, selected: selected, maxHeight: 300, debugPrefix: "mv", onSelect: toggle)
                    .padding(6)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border))
                HStack(spacing: 8) {
                    TextField("", text: $custom, prompt: Text("手动添加模型 ID").foregroundStyle(Theme.muted.opacity(0.7)))
                        .textFieldStyle(.plain).font(.system(size: 12)).autocorrectionDisabled()
                        .padding(.horizontal, 12).frame(height: 34)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
                        .accessibilityLabel("添加模型 ID")
                        .onSubmit(addCustom)
                    MBButton(title: "添加", enabled: !custom.trimmingCharacters(in: .whitespaces).isEmpty, action: addCustom)
                }
                let status = draft ? "随模型连接一起保存" : (autosave?.busy == true ? "保存中…" : notice)
                if !status.isEmpty { Text(status).font(.system(size: 11)).foregroundStyle(Theme.muted).accessibilityAddTraits(.updatesFrequently) }
                if let failure = [error, autosave?.error ?? ""].first(where: { !$0.isEmpty }) {
                    Text(failure).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled)
                }
            }
            .padding(.top, 16)
        }
        .onAppear {
            guard !draft, autosave == nil else { return }
            autosave = ModelSelectionAutosave(initial: stored) { [workspace] models, version in
                try await workspace.saveModelVisibility(models: models, version: version)
            }
        }
        .onChange(of: stored) { autosave?.sync(stored) }
        .onChange(of: selection, initial: true) { onSelection(selection) }
        .task(id: active) { if active, !loaded, !draft { loaded = true; await load(force: false) } }
        #if DEBUG
        .onReceive(NotificationCenter.default.publisher(for: .mbDebug)) { note in
            guard let cmd = note.mbCommand, cmd.prefix == "mv" else { return }
            switch cmd.verb {
            case "all": edit(nil)
            case "clear": edit([])
            case "only": onlySelected.toggle()
            case "toggle": toggle(cmd.arg)
            case "add": custom = cmd.arg; addCustom()
            case "refresh": Task { await load(force: true) }
            case "status": mbLog("visibility selection=\(selection?.joined(separator: ",") ?? "all") stored=\(stored.models?.joined(separator: ",") ?? "all")@\(stored.version) busy=\(autosave?.busy ?? false) error=\(autosave?.error ?? error) catalog=\(catalog.count)")
            default: break
            }
        }
        #endif
    }

    private func edit(_ value: [String]?) {
        if draft { draftSelection = value } else { autosave?.set(value) }
    }

    private func toggle(_ id: String) {
        var next = selected
        if next.contains(id) { next.remove(id) } else { next.insert(id) }
        edit(next.sorted())
    }

    private func addCustom() {
        let id = custom.trimmingCharacters(in: .whitespaces)
        guard !id.isEmpty, id.count <= 200 else { return }
        edit(Array(selected.union([id])).sorted()); custom = ""
    }

    private func load(force: Bool) async {
        guard !loading, let source = workspace.savedModelSource() else { return }
        loading = true; error = ""
        defer { loading = false }
        let loader = ModelCatalogLoader()
        await loader.load(source, force: force)
        if let failure = loader.error { error = failure; return }
        if let result = loader.catalog {
            catalog = result.models
            notice = result.hasMore ? "服务仍有未返回的模型，可手动添加。" : ""
        }
    }
}

/// 生图模型 (web `ImageModelSettings.tsx`): image generation uses OpenAI-compatible providers, whichever is the default.
/// Pick a provider, then its image models; every enabled provider's selection is offered to the assistant.
struct ImageModelSection: View {
    let workspace: WorkspaceStore
    let active: Bool
    @State private var chosen = ""

    private var providers: [ModelConnection] { (workspace.state?.connections ?? []).filter { $0.provider == "openai" && $0.usable } }
    private var provider: ModelConnection? { providers.first { $0.id == chosen } ?? providers.first(where: \.isDefault) ?? providers.first }
    private var total: Int { providers.reduce(0) { $0 + ($1.imageModels?.models?.count ?? 0) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("生图模型").font(.system(size: 13, weight: .semibold))
                Spacer()
                Text(providers.isEmpty ? (workspace.state?.connections.isEmpty == false ? "需要 OpenAI 兼容的供应商" : "请先连接模型") : "已选 \(total) 个")
                    .font(.system(size: 10)).foregroundStyle(Theme.muted)
                    .padding(.horizontal, 8).padding(.vertical, 4).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 5))
                    .accessibilityIdentifier("image-models-status")
            }
            if let provider {
                VStack(alignment: .leading, spacing: 12) {
                    if providers.count > 1 {
                        MBSelect(label: "供应商", selection: Binding(get: { provider.id }, set: { chosen = $0 }),
                                 options: providers.map { ($0.id, $0.name) })
                    }
                    ImageProviderModels(workspace: workspace, connection: provider, active: active).id(provider.id)
                }
                .padding(.top, 16)
            }
        }
    }
}

private struct ImageProviderModels: View {
    let workspace: WorkspaceStore
    let connection: ModelConnection
    let active: Bool
    @State private var catalog: [String] = []
    @State private var autosave: ModelSelectionAutosave?
    @State private var loading = false
    @State private var notice = ""
    @State private var error = ""
    @State private var loaded = false

    private var stored: ModelVisibility { connection.imageModels ?? ModelVisibility(models: []) }
    private var selection: [String] { autosave?.selection ?? stored.models ?? [] }
    private var all: [String] {
        var seen = Set<String>()
        return (catalog + selection + (connection.models ?? [])).filter { !$0.isEmpty && seen.insert($0).inserted }.sorted()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ModelListView(models: all, selected: Set(selection), maxHeight: 240, debugPrefix: "ig", names: connection.names, onSelect: { autosave?.toggle($0, all: all) })
                .padding(6)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border))
                .disabled(loading)
            let status = loading ? "获取中…" : autosave?.busy == true ? "保存中…" : notice
            if !status.isEmpty { Text(status).font(.system(size: 11)).foregroundStyle(Theme.muted).accessibilityAddTraits(.updatesFrequently) }
            if let failure = [error, autosave?.error ?? ""].first(where: { !$0.isEmpty }) {
                HStack(spacing: 8) {
                    Text(failure).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled)
                    if !error.isEmpty { MBButton(title: "重试获取", enabled: !loading) { Task { await load() } } }
                }
            }
        }
        .onAppear {
            guard autosave == nil else { return }
            let id = connection.id
            autosave = ModelSelectionAutosave(initial: stored) { [workspace] models, version in
                try await workspace.saveImageModelSelection(connectionID: id, models: models ?? [], version: version)
            }
        }
        .onChange(of: stored) { autosave?.sync(stored) }
        .task(id: active) { if active, !loaded { loaded = true; await load() } }
    }

    private func load() async {
        guard !loading else { return }
        loading = true; error = ""
        defer { loading = false }
        do {
            let result = try await workspace.listModels(connectionID: connection.id)
            catalog = result.models; notice = result.hasMore ? "模型列表未全部返回" : ""
        } catch { self.error = mbFallbackMessage(error) }
    }
}

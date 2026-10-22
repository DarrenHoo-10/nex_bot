import SwiftUI
import NexClientKit

/// 显示的模型 (web `ModelVisibility.tsx`): choose which models the pickers offer.
/// `selection == nil` shows the whole provider directory; an array is a shortlist.
/// For the saved connection every change saves at once (``ModelSelectionAutosave``). For a connection still being
/// edited (`draft`), the choice is reported through `onSelection` and saved with the connection.
struct ModelVisibilitySection: View {
    let workspace: WorkspaceStore
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
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("显示的模型").font(.subheadline.weight(.semibold))
                Spacer()
                StatusChip(text: selection == nil ? "全部显示" : "已选 \(selection?.count ?? 0) 个", tone: .neutral)
            }
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], alignment: .leading, spacing: 8) {
                Button("全部显示") { edit(nil) }.buttonStyle(PillButtonStyle())
                Button("清空选择") { edit([]) }.buttonStyle(PillButtonStyle())
                Button(onlySelected ? "查看全部" : "只看已选") { onlySelected.toggle() }.buttonStyle(PillButtonStyle())
                if !draft { Button(loading ? "获取中…" : "刷新目录") { Task { await load(force: true) } }.buttonStyle(PillButtonStyle()).disabled(loading) }
            }
            ModelMultiList(models: onlySelected ? selected.sorted() : all, selected: selected, onToggle: toggle)
            HStack(spacing: 8) {
                TextField("手动添加模型 ID", text: $custom)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.done).onSubmit(addCustom)
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityLabel("添加模型 ID")
                Button("添加", action: addCustom).buttonStyle(PillButtonStyle()).disabled(custom.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            let status = draft ? "随模型连接一起保存" : (autosave?.busy == true ? "保存中…" : notice)
            if !status.isEmpty { Text(status).font(.caption).foregroundStyle(Theme.muted).accessibilityAddTraits(.updatesFrequently) }
            if let failure = [error, autosave?.error ?? ""].first(where: { !$0.isEmpty }) { InlineBanner(text: failure) }
        }
        .onAppear {
            guard !draft, autosave == nil else { return }
            autosave = ModelSelectionAutosave(initial: stored) { [workspace] models, version in
                try await workspace.saveModelVisibility(models: models, version: version)
            }
        }
        .onChange(of: stored) { autosave?.sync(stored) }
        .onChange(of: selection, initial: true) { onSelection(selection) }
        .task { if !loaded, !draft { loaded = true; await load(force: false) } }
        .onDebugUI { cmd, arg in
            switch cmd {
            case "mv-all": edit(nil)
            case "mv-clear": edit([])
            case "mv-only": onlySelected.toggle()
            case "mv-toggle": toggle(arg)
            case "mv-add": custom = arg; addCustom()
            case "mv-refresh": Task { await load(force: true) }
            case "mv-status": mbLogUI("visibility selection=\(selection?.joined(separator: ",") ?? "all") stored=\(stored.models?.joined(separator: ",") ?? "all")@\(stored.version) busy=\(autosave?.busy ?? false) error=\(autosave?.error ?? error) catalog=\(catalog.count)")
            default: break
            }
        }
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

/// 生图模型 (web `ImageModelSettings.tsx`): the models image generation may use, saved at once.
/// Only OpenAI-compatible connections can generate images.
struct ImageModelSection: View {
    let workspace: WorkspaceStore

    @State private var catalog: [String] = []
    @State private var autosave: ModelSelectionAutosave?
    @State private var loading = false
    @State private var notice = ""
    @State private var error = ""
    @State private var loaded = false

    private var config: ModelConfig? { workspace.state?.config }
    private var supported: Bool { config?.providerID == "openai" }
    private var stored: ModelVisibility { workspace.state?.imageModelSelection ?? ModelVisibility(models: []) }
    private var selection: [String] { autosave?.selection ?? stored.models ?? [] }
    private var all: [String] {
        var seen = Set<String>()
        return (catalog + selection + (workspace.state?.modelVisibility.models ?? []) + [config?.defaultModel ?? ""])
            .filter { !$0.isEmpty && seen.insert($0).inserted }.sorted()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("生图模型").font(.subheadline.weight(.semibold))
                Spacer()
                StatusChip(text: supported ? "已选 \(selection.count) 个" : config != nil ? "当前模型连接不支持生图" : "请先连接模型", tone: .neutral)
            }
            if supported {
                ModelMultiList(models: all, selected: Set(selection), maxHeight: 260, onToggle: { autosave?.toggle($0, all: all) })
                    .disabled(loading)
                let status = loading ? "获取中…" : autosave?.busy == true ? "保存中…" : notice
                if !status.isEmpty { Text(status).font(.caption).foregroundStyle(Theme.muted).accessibilityAddTraits(.updatesFrequently) }
                if let failure = [error, autosave?.error ?? ""].first(where: { !$0.isEmpty }) {
                    InlineBanner(text: failure)
                    if !error.isEmpty { Button("重试获取") { Task { await load() } }.buttonStyle(PillButtonStyle()).disabled(loading) }
                }
            }
        }
        .padding(14).cardStyle()
        .onAppear {
            guard autosave == nil else { return }
            autosave = ModelSelectionAutosave(initial: stored) { [workspace] models, version in
                try await workspace.saveImageModelSelection(models: models ?? [], version: version)
            }
        }
        .onChange(of: stored) { autosave?.sync(stored) }
        .task(id: supported) { if supported, !loaded { loaded = true; await load() } }
        .onDebugUI { cmd, arg in
            switch cmd {
            case "ig-toggle": autosave?.toggle(arg, all: all)
            case "ig-status": mbLogUI("images selection=\(selection.joined(separator: ",")) stored=\(stored.models?.joined(separator: ",") ?? "")@\(stored.version) busy=\(autosave?.busy ?? false) error=\(autosave?.error ?? error) supported=\(supported)")
            default: break
            }
        }
    }

    private func load() async {
        guard !loading, let source = workspace.savedModelSource() else { return }
        loading = true; error = ""
        defer { loading = false }
        let loader = ModelCatalogLoader()
        await loader.load(source, force: false)
        if let failure = loader.error { error = failure; return }
        if let result = loader.catalog { catalog = result.models; notice = result.hasMore ? "模型列表未全部返回" : "" }
    }
}

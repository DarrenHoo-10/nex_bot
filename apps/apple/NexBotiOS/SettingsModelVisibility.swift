import SwiftUI
import NexClientKit

/// 显示的模型 (web `ModelVisibility.tsx`): choose which models the pickers offer.
/// `selection == nil` shows the whole provider directory; an array is a shortlist. The edit echoes the version it started from.
/// For a connection still being edited (`draft`), the choice is reported through `onSelection` and saved with the connection.
struct ModelVisibilitySection: View {
    let workspace: WorkspaceStore
    /// Models fetched with 获取模型列表 in the connection form.
    var fetched: [String] = []
    var draft = false
    var onSelection: ([String]?) -> Void = { _ in }

    @State private var catalog: [String] = []
    @State private var selection: [String]?
    @State private var version = 0
    @State private var busy = false
    @State private var loading = false
    @State private var notice = ""
    @State private var error = ""
    @State private var custom = ""
    @State private var onlySelected = false
    @State private var dirty = false
    @State private var loaded = false

    private var stored: ModelVisibility { workspace.state?.modelVisibility ?? ModelVisibility() }
    private var defaultModel: String { workspace.state?.config?.defaultModel ?? "" }
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
            Text("选择聊天与记忆的模型列表里显示哪些模型。").font(.footnote).foregroundStyle(Theme.muted)
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
            if !error.isEmpty { InlineBanner(text: error) }
            if draft {
                Text("随模型连接一起保存").font(.caption).foregroundStyle(Theme.muted)
            } else {
                HStack(spacing: 12) {
                    PrimaryButton(title: busy ? "保存中…" : "保存显示模型", busy: busy, brand: true, action: save).disabled(!dirty || busy)
                    if !notice.isEmpty { Text(notice).font(.footnote).foregroundStyle(Theme.muted).accessibilityAddTraits(.updatesFrequently) }
                }
            }
        }
        .disabled(busy)
        .onAppear { if !draft { selection = stored.models; version = stored.version } }
        .onChange(of: stored) { if !dirty && !draft { selection = stored.models; version = stored.version } }
        .onChange(of: selection, initial: true) { onSelection(selection) }
        .task { if !loaded, !draft { loaded = true; await load(force: false) } }
        .onDebugUI { cmd, arg in
            switch cmd {
            case "mv-all": edit(nil)
            case "mv-clear": edit([])
            case "mv-only": onlySelected.toggle()
            case "mv-toggle": toggle(arg)
            case "mv-add": custom = arg; addCustom()
            case "mv-save": save()
            case "mv-refresh": Task { await load(force: true) }
            case "mv-status": mbLogUI("visibility selection=\(selection?.joined(separator: ",") ?? "all") version=\(version) dirty=\(dirty) notice=\(notice) error=\(error) catalog=\(catalog.count)")
            default: break
            }
        }
    }

    private func edit(_ value: [String]?) { selection = value; dirty = true; notice = "" }

    private func toggle(_ id: String) {
        guard !busy else { return }
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

    private func save() {
        guard dirty, !busy else { return }
        busy = true; error = ""
        let models = selection, base = version
        Task {
            defer { busy = false }
            do {
                let result = try await workspace.saveModelVisibility(models: models, version: base)
                version = result.version; selection = result.models; dirty = false; notice = "已保存"
            } catch { self.error = coreMessage(error) }
        }
    }
}

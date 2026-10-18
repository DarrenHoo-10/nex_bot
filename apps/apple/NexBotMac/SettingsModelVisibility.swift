import SwiftUI
import NexClientKit

/// 显示的模型 (web `ModelVisibility.tsx`): choose which models the pickers offer for the saved connection.
/// `selection == nil` shows the whole provider directory; an array is a shortlist. The edit echoes the version it started from.
struct ModelVisibilitySection: View {
    let workspace: WorkspaceStore
    let active: Bool

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
        return (catalog + (selection ?? []) + [defaultModel]).filter { !$0.isEmpty && seen.insert($0).inserted }.sorted()
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
            .padding(.top, 24)
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    MBButton(title: "全部显示") { edit(nil) }
                    MBButton(title: "清空选择") { edit([]) }
                    MBButton(title: onlySelected ? "查看全部" : "只看已选") { onlySelected.toggle() }
                    MBButton(title: loading ? "获取中…" : "刷新目录", enabled: !loading) { Task { await load(force: true) } }
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
                HStack(spacing: 14) {
                    MBButton(title: busy ? "保存中…" : "保存显示模型", kind: .brand, busy: busy, enabled: dirty && !busy, action: save)
                    if !notice.isEmpty { Text(notice).font(.system(size: 12)).foregroundStyle(Theme.muted).accessibilityAddTraits(.updatesFrequently) }
                }
                if !error.isEmpty { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled) }
            }
            .disabled(busy)
            .padding(.top, 16)
        }
        .onAppear { selection = stored.models; version = stored.version }
        .onChange(of: stored) { if !dirty { selection = stored.models; version = stored.version } }
        .task(id: active) { if active, !loaded { loaded = true; await load(force: false) } }
        #if DEBUG
        .onReceive(NotificationCenter.default.publisher(for: .mbDebug)) { note in
            guard let cmd = note.mbCommand, cmd.prefix == "mv" else { return }
            switch cmd.verb {
            case "all": edit(nil)
            case "clear": edit([])
            case "only": onlySelected.toggle()
            case "toggle": toggle(cmd.arg)
            case "add": custom = cmd.arg; addCustom()
            case "save": save()
            case "refresh": Task { await load(force: true) }
            case "status": mbLog("visibility selection=\(selection?.joined(separator: ",") ?? "all") version=\(version) dirty=\(dirty) notice=\(notice) error=\(error) catalog=\(catalog.count)")
            default: break
            }
        }
        #endif
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
            } catch { self.error = mbFallbackMessage(error) }
        }
    }
}

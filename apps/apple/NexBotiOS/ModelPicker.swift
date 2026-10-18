import SwiftUI
import NexClientKit

// The shared searchable model picker (web `ModelPicker.tsx`) as a bottom sheet: a search field and a lazy list.
// Used for the default model (设置 › 模型), the assistant's chat model (＋ 菜单 › 模型) and the memory model (设置 › 长期记忆).
// `ModelMultiList` is the multi-select list of the 显示的模型 editor.

// MARK: - Catalog loading

/// Where a picker gets its provider catalog. `cacheKey` is per connection; the catalog is fetched once and reused until 刷新列表.
struct ModelSource {
    var cacheKey: String
    var fetch: () async throws -> ModelCatalog
}

extension WorkspaceStore {
    /// The saved connection's catalog (Core reuses the saved key; the key never reaches the client).
    @MainActor func savedModelSource() -> ModelSource? {
        guard let config = state?.config else { return nil }
        let provider = config.providerID, endpoint = config.endpoint
        return ModelSource(cacheKey: ModelCatalogCache.key(self, provider: provider, endpoint: endpoint, secret: ""),
                           fetch: { [self] in try await listModels(provider: provider, endpoint: endpoint) })
    }
    /// Catalog of the connection typed into the settings form (a typed key is used once and not stored).
    @MainActor func formModelSource(provider: String, endpoint: String, apiKey: String) -> ModelSource {
        ModelSource(cacheKey: ModelCatalogCache.key(self, provider: provider, endpoint: endpoint, secret: apiKey),
                    fetch: { [self] in try await listModels(provider: provider, endpoint: endpoint, apiKey: apiKey) })
    }
}

/// Catalogs already fetched for a connection, shared by every picker of the signed-in workspace while the app runs.
@MainActor
final class ModelCatalogCache {
    static let shared = ModelCatalogCache()
    private var entries: [String: ModelCatalog] = [:]
    static func key(_ workspace: WorkspaceStore, provider: String, endpoint: String, secret: String) -> String {
        "\(ObjectIdentifier(workspace).hashValue)|\(provider)|\(endpoint)|\(secret.isEmpty ? "" : String(secret.hashValue))"
    }
    func catalog(for key: String) -> ModelCatalog? { entries[key] }
    func store(_ catalog: ModelCatalog, for key: String) { entries[key] = catalog }
}

/// One picker's fetch state. A newer request supersedes an older one, so a slow answer never overwrites a fresher list.
@MainActor @Observable
final class ModelCatalogLoader {
    var catalog: ModelCatalog?
    var loading = false
    var error: String?
    @ObservationIgnored private var generation = 0

    func load(_ source: ModelSource, force: Bool = false) async {
        if !force, let cached = ModelCatalogCache.shared.catalog(for: source.cacheKey) { catalog = cached; error = nil; return }
        generation += 1
        let mine = generation
        loading = true; error = nil
        defer { if mine == generation { loading = false } }
        do {
            let result = try await source.fetch()
            guard mine == generation else { return }
            ModelCatalogCache.shared.store(result, for: source.cacheKey)
            catalog = result
        } catch {
            guard mine == generation else { return }
            self.error = coreMessage(error)
        }
    }
}

// MARK: - Rows

private struct ModelRowItem: Identifiable, Equatable {
    let model: String
    let custom: Bool
    var id: String { custom ? "custom:\(model)" : "model:\(model)" }
}

/// Filters `models` (plus the empty id when `emptyLabel` is set) by the whitespace-separated terms of `query` and offers a typed id.
private func filterModels(_ models: [String], query: String, emptyLabel: String?, allowCustom: Bool) -> [ModelRowItem] {
    var seen = Set<String>()
    let all = ((emptyLabel != nil ? [""] : []) + models).filter { seen.insert($0).inserted }
    let terms = query.lowercased().split(whereSeparator: \.isWhitespace)
    var rows = all.filter { model in
        let haystack = (model.isEmpty ? emptyLabel ?? "" : model).lowercased()
        return terms.allSatisfy { haystack.contains($0) }
    }.map { ModelRowItem(model: $0, custom: false) }
    let typed = query.trimmingCharacters(in: .whitespaces)
    if allowCustom, !typed.isEmpty, typed.count <= 200, !rows.contains(where: { $0.model == typed }) { rows.append(ModelRowItem(model: typed, custom: true)) }
    return rows
}

private struct SearchField: View {
    @Binding var text: String
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(Theme.muted)
            TextField("搜索模型名称…", text: $text)
                .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search)
                .accessibilityLabel("搜索模型")
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted) }
                    .buttonStyle(.plain).accessibilityLabel("清除搜索")
            }
        }
        .padding(.horizontal, 12).frame(height: 42)
        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

// MARK: - Picker sheet

/// The picker body: search, list, loading / error / partial-catalog status and 刷新列表 / 重试. `models` is the saved shortlist
/// (`modelVisibility.models`); when nil the provider catalog from `source` is used. The current `value` is always listed.
struct ModelPickerSheet: View {
    let title: String
    let value: String
    var emptyLabel: String?
    var models: [String]?
    var source: ModelSource?
    let onSelect: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var loader = ModelCatalogLoader()
    @State private var query = ""

    private var options: [String] {
        var out: [String] = value.isEmpty ? [] : [value]
        out += models ?? loader.catalog?.models ?? []
        return out
    }

    var body: some View {
        let rows = filterModels(options, query: query, emptyLabel: emptyLabel, allowCustom: true)
        VStack(spacing: 0) {
            HStack {
                Text(title).font(.headline)
                Spacer()
                Button("关闭") { dismiss() }.font(.subheadline).foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 10)
            SearchField(text: $query).padding(.horizontal, 16).padding(.bottom, 8)
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(rows) { row in rowView(row) }
                    if rows.isEmpty, !loader.loading {
                        Text("没有匹配的模型").font(.footnote).foregroundStyle(Theme.muted).frame(maxWidth: .infinity).padding(.vertical, 24)
                    }
                }
                .padding(.horizontal, 8)
                .accessibilityElement(children: .contain).accessibilityLabel("可用模型")
                if loader.loading { status("正在获取模型…", progress: true) }
                if let error = loader.error { status(error, danger: true) }
                if models == nil, loader.catalog?.hasMore == true { status("服务仍有未返回的模型，可输入完整 ID。") }
                if source != nil, models == nil {
                    Button { reload(force: true) } label: {
                        Text(loader.error != nil ? "重试" : "刷新列表").font(.subheadline).foregroundStyle(Theme.brand)
                            .frame(maxWidth: .infinity).frame(height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(loader.loading)
                }
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(Theme.background)
        .task { if models == nil { reload(force: false) } }
        .onDebugUI { cmd, arg in
            switch cmd {
            case "mp-search": query = arg
            case "mp-state": mbLogUI("picker rows=\(rows.count) query=\(query) loading=\(loader.loading) error=\(loader.error ?? "-") hasMore=\(loader.catalog?.hasMore == true)")
            default: break
            }
        }
    }

    private func rowView(_ row: ModelRowItem) -> some View {
        let checked = !row.custom && row.model == value
        let label = row.custom ? "使用「\(row.model)」" : (row.model.isEmpty ? (emptyLabel ?? "") : row.model)
        return Button { onSelect(row.model); dismiss() } label: {
            HStack(spacing: 10) {
                Text(label).font(.subheadline).lineLimit(1).truncationMode(.middle)
                    .foregroundStyle(checked ? Theme.brand : Theme.foreground)
                Spacer(minLength: 6)
                if checked { Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.brand) }
            }
            .padding(.horizontal, 12).frame(minHeight: 46).frame(maxWidth: .infinity, alignment: .leading)
            .background(checked ? Theme.brandSoft : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label).accessibilityAddTraits(checked ? .isSelected : [])
    }

    private func reload(force: Bool) {
        guard let source else { return }
        Task { await loader.load(source, force: force) }
    }

    private func status(_ text: String, danger: Bool = false, progress: Bool = false) -> some View {
        HStack(spacing: 8) {
            if progress { ProgressView().controlSize(.small) }
            Text(text).font(.footnote).foregroundStyle(danger ? Theme.danger : Theme.muted).textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

// MARK: - Settings trigger

/// A labelled field that opens ``ModelPickerSheet`` (the default-model and memory-model pickers of the settings pages).
struct ModelPickerField: View {
    let label: String
    var title: String?
    let value: String
    var emptyLabel: String?
    var models: [String]?
    var source: ModelSource?
    var disabled = false
    @Binding var isOpen: Bool
    let onChange: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title { Text(title).font(.footnote.weight(.semibold)) }
            Button { isOpen = true } label: {
                HStack(spacing: 8) {
                    Text(value.isEmpty ? (emptyLabel ?? "选择模型") : value).lineLimit(1).truncationMode(.middle)
                        .foregroundStyle(value.isEmpty && emptyLabel == nil ? Theme.muted : Theme.foreground)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(Theme.muted)
                }
                .padding(.horizontal, 12).padding(.vertical, 11).frame(maxWidth: .infinity)
                .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .opacity(disabled ? 0.5 : 1).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(disabled)
            .accessibilityLabel(label).accessibilityValue(value.isEmpty ? (emptyLabel ?? "") : value)
        }
        .sheet(isPresented: $isOpen) {
            ModelPickerSheet(title: label, value: value, emptyLabel: emptyLabel, models: models, source: source, onSelect: onChange)
                .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
    }
}

// MARK: - Multi-select list (显示的模型)

/// Search field plus check-box rows (lazy). `selected` is the checked set; tapping a row calls `onToggle`.
struct ModelMultiList: View {
    let models: [String]
    let selected: Set<String>
    var maxHeight: CGFloat = 320
    let onToggle: (String) -> Void
    @State private var query = ""

    var body: some View {
        let rows = filterModels(models, query: query, emptyLabel: nil, allowCustom: false)
        VStack(spacing: 8) {
            SearchField(text: $query)
            HStack {
                Text("\(rows.count) 个模型 · 已选 \(selected.count)").font(.caption).foregroundStyle(Theme.muted)
                Spacer()
            }
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(rows) { row in
                        let checked = selected.contains(row.model)
                        Button { onToggle(row.model) } label: {
                            HStack(spacing: 10) {
                                Image(systemName: checked ? "checkmark.square.fill" : "square").font(.system(size: 18))
                                    .foregroundStyle(checked ? Theme.brand : Theme.muted)
                                Text(row.model).font(.subheadline).lineLimit(1).truncationMode(.middle).foregroundStyle(Theme.foreground)
                                Spacer(minLength: 6)
                            }
                            .padding(.horizontal, 10).frame(minHeight: 44).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(row.model).accessibilityAddTraits(checked ? .isSelected : [])
                    }
                    if rows.isEmpty { Text("没有匹配的模型").font(.footnote).foregroundStyle(Theme.muted).padding(.vertical, 20) }
                }
            }
            .frame(maxHeight: maxHeight)
        }
    }
}

#if DEBUG
func mbLogUI(_ text: String) {
    guard let path = ProcessInfo.processInfo.environment["NEXBOT_DEBUG_LOG_FILE"] else { return }
    let line = text + "\n"
    if let handle = FileHandle(forWritingAtPath: path) { handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close() }
    else { try? line.write(toFile: path, atomically: true, encoding: .utf8) }
}
#else
@inline(__always) func mbLogUI(_ text: String) {}
#endif

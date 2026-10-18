import SwiftUI
import NexClientKit

// The shared searchable model picker (web `ModelPicker.tsx`): a popover with a search field and a lazy list.
// Used for the default model (设置 › 模型), the assistant's chat model (＋ menu › 模型) and the memory model (设置 › 长期记忆).
// `ModelListView` is also the multi-select list of the 显示的模型 editor.

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
    /// Catalog of the connection currently typed into the settings form (a typed key is used once and not stored).
    @MainActor func formModelSource(provider: String, endpoint: String, apiKey: String) -> ModelSource {
        ModelSource(cacheKey: ModelCatalogCache.key(self, provider: provider, endpoint: endpoint, secret: apiKey),
                    fetch: { [self] in try await listModels(provider: provider, endpoint: endpoint, apiKey: apiKey) })
    }
}

/// Catalogs already fetched for a connection, shared by every picker of the signed-in workspace.
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
            self.error = mbFallbackMessage(error)
        }
    }
}

// MARK: - Searchable list

private struct ModelRowItem: Identifiable, Equatable {
    let model: String
    let custom: Bool
    var id: String { custom ? "custom:\(model)" : "model:\(model)" }
}

/// Search field plus a lazy list. ↑ ↓ move the highlight, Home / End jump (with ⌃, or while the field is empty), Return picks it,
/// Escape calls `onEscape`. With `selected` the rows are check boxes (multi-select); otherwise the row equal to `value` is checked.
/// With `emptyLabel` the first row is the empty id (follow the default). With `allowCustom` a typed id that is not listed is offered.
struct ModelListView: View {
    let models: [String]
    var value = ""
    var selected: Set<String>?
    var emptyLabel: String?
    var allowCustom = false
    var maxHeight: CGFloat = 264
    var debugPrefix = ""
    let onSelect: (String) -> Void
    var onEscape: (() -> Void)?

    static let rowHeight: CGFloat = 34

    @State private var query = ""
    @State private var rows: [ModelRowItem] = []
    @State private var active = 0
    @FocusState private var searchFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(Theme.muted)
                TextField("", text: $query, prompt: Text("搜索模型名称…").foregroundStyle(Theme.muted.opacity(0.7)))
                    .textFieldStyle(.plain).font(.system(size: 13)).autocorrectionDisabled()
                    .focused($searchFocused)
                    .onSubmit { chooseActive() }
                    .onKeyPress(.downArrow) { move(active + 1); return .handled }
                    .onKeyPress(.upArrow) { move(active - 1); return .handled }
                    .onKeyPress(.home) { jump(to: 0) }
                    .onKeyPress(.end) { jump(to: rows.count - 1) }
                    .onKeyPress(.escape) { if let onEscape { onEscape(); return .handled }; return .ignored }
                    .accessibilityLabel("搜索模型")
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 12)).foregroundStyle(Theme.muted) }
                        .buttonStyle(.plain).accessibilityLabel("清除搜索")
                }
            }
            .padding(.horizontal, 12).frame(height: 38)
            Hairline()
            HStack {
                let listed = rows.filter { !$0.custom }.count
                Text("\(listed) 个模型" + (selected.map { " · 已选 \($0.count)" } ?? "")).font(.system(size: 11)).foregroundStyle(Theme.muted)
                Spacer()
            }
            .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 4)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in rowView(row, index: index) }
                    }
                    .padding(.horizontal, 6)
                }
                .frame(height: listHeight)
                .overlay { if rows.isEmpty { Text("没有匹配的模型").font(.system(size: 12)).foregroundStyle(Theme.muted) } }
                .onChange(of: active) { if rows.indices.contains(active) { proxy.scrollTo(rows[active].id) } }
                .onChange(of: rows.first?.id) { proxy.scrollTo(rows.first?.id, anchor: .top) }
            }
            .accessibilityLabel("可用模型")
        }
        .onAppear { refilter(); Task { try? await Task.sleep(for: .milliseconds(60)); searchFocused = true } }
        .onChange(of: query) { active = 0; refilter() }
        .onChange(of: models) { refilter() }
        .onChange(of: emptyLabel) { refilter() }
        #if DEBUG
        .onReceive(NotificationCenter.default.publisher(for: .mbDebug)) { note in
            guard !debugPrefix.isEmpty, let cmd = note.mbCommand, cmd.prefix == debugPrefix else { return }
            switch cmd.verb {
            case "search": query = cmd.arg
            case "down": move(active + 1)
            case "up": move(active - 1)
            case "home": _ = jump(to: 0, force: true)
            case "end": _ = jump(to: rows.count - 1, force: true)
            case "return": chooseActive()
            case "pick": onSelect(cmd.arg)
            case "state": mbLog("\(debugPrefix) rows=\(rows.count) active=\(active)=\(rows.indices.contains(active) ? rows[active].model : "-") query=\(query) selected=\(selected?.sorted().joined(separator: ",") ?? "-")")
            default: break
            }
        }
        #endif
    }

    private var listHeight: CGFloat { min(maxHeight, max(Self.rowHeight + 10, CGFloat(rows.count) * Self.rowHeight + 8)) }

    private func rowView(_ row: ModelRowItem, index: Int) -> some View {
        let checked = selected.map { $0.contains(row.model) } ?? (!row.custom && row.model == value)
        let title = row.custom ? "使用「\(row.model)」" : (row.model.isEmpty ? (emptyLabel ?? "") : row.model)
        return Button { onSelect(row.model) } label: {
            HStack(spacing: 9) {
                if selected != nil {
                    Image(systemName: checked ? "checkmark.square.fill" : "square").font(.system(size: 14))
                        .foregroundStyle(checked ? Theme.brand : Theme.muted)
                }
                Text(title).font(.system(size: 13)).lineLimit(1).truncationMode(.middle)
                    .foregroundStyle(checked && selected == nil ? Theme.brand : Theme.foreground)
                Spacer(minLength: 6)
                if selected == nil && checked { Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.brand) }
            }
            .padding(.horizontal, 10).frame(height: Self.rowHeight).frame(maxWidth: .infinity, alignment: .leading)
            .background(active == index ? Theme.secondary : .clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(title)
        .onHover { if $0 { active = index } }
        .accessibilityLabel(title).accessibilityAddTraits(checked ? .isSelected : [])
    }

    private func refilter() {
        var seen = Set<String>()
        var all = (emptyLabel != nil ? [""] : []) + models
        all = all.filter { seen.insert($0).inserted }
        let terms = query.lowercased().split(whereSeparator: \.isWhitespace)
        var next = all.filter { model in
            let haystack = (model.isEmpty ? emptyLabel ?? "" : model).lowercased()
            return terms.allSatisfy { haystack.contains($0) }
        }.map { ModelRowItem(model: $0, custom: false) }
        let typed = query.trimmingCharacters(in: .whitespaces)
        if allowCustom, !typed.isEmpty, typed.count <= 200, !next.contains(where: { $0.model == typed }) { next.append(ModelRowItem(model: typed, custom: true)) }
        rows = next
        active = min(active, max(0, next.count - 1))
    }

    private func move(_ index: Int) { active = max(0, min(rows.count - 1, index)) }

    private func jump(to index: Int, force: Bool = false) -> KeyPress.Result {
        guard force || query.isEmpty || NSEvent.modifierFlags.contains(.control) else { return .ignored }
        move(index); return .handled
    }

    private func chooseActive() {
        if rows.indices.contains(active) { onSelect(rows[active].model) }
        else if allowCustom, !query.trimmingCharacters(in: .whitespaces).isEmpty { onSelect(query.trimmingCharacters(in: .whitespaces)) }
    }
}

// MARK: - Popover content

/// The picker body: list, loading / error / partial-catalog status and 刷新列表 / 重试. `models` is the saved shortlist
/// (`modelVisibility.models`); when nil the provider catalog from `source` is used. The current `value` is always listed.
struct ModelPickerPopover: View {
    let label: String
    let value: String
    var emptyLabel: String?
    var models: [String]?
    var source: ModelSource?
    var debugPrefix = "mp"
    let onSelect: (String) -> Void
    let close: () -> Void

    @State private var loader = ModelCatalogLoader()

    private var options: [String] {
        var out: [String] = value.isEmpty ? [] : [value]
        out += models ?? loader.catalog?.models ?? []
        return out
    }

    var body: some View {
        VStack(spacing: 0) {
            ModelListView(models: options, value: value, emptyLabel: emptyLabel, allowCustom: true, debugPrefix: debugPrefix,
                          onSelect: { onSelect($0) }, onEscape: close)
            if loader.loading { status("正在获取模型…") }
            if let error = loader.error { status(error, danger: true) }
            if models == nil, loader.catalog?.hasMore == true { status("服务仍有未返回的模型，可输入完整 ID。") }
            if source != nil, models == nil {
                Hairline()
                Button { reload(force: true) } label: {
                    Text(loader.error != nil ? "重试" : "刷新列表").font(.system(size: 12)).foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity).frame(height: 34).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(loader.loading)
            }
        }
        .frame(width: 340)
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain).accessibilityLabel(label)
        .task { if models == nil { reload(force: false) } }
    }

    private func reload(force: Bool) {
        guard let source else { return }
        Task { await loader.load(source, force: force) }
    }

    private func status(_ text: String, danger: Bool = false) -> some View {
        Text(text).font(.system(size: 12)).foregroundStyle(danger ? Theme.danger : Theme.muted)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 8).textSelection(.enabled)
            .accessibilityAddTraits(.updatesFrequently)
    }
}

// MARK: - Settings trigger

/// A labelled field that opens ``ModelPickerPopover`` (the default-model and memory-model pickers of the settings panes).
struct ModelPickerField: View {
    let label: String
    var title: String?
    let value: String
    var emptyLabel: String?
    var models: [String]?
    var source: ModelSource?
    var disabled = false
    var identifier: String?
    var debugPrefix = "mp"
    @Binding var isOpen: Bool
    let onChange: (String) -> Void
    @FocusState private var triggerFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title { Text(title).font(.system(size: 12, weight: .medium)) }
            Button { isOpen.toggle() } label: {
                HStack(spacing: 8) {
                    Text(value.isEmpty ? (emptyLabel ?? "选择模型") : value).font(.system(size: 12)).lineLimit(1).truncationMode(.middle)
                        .foregroundStyle(value.isEmpty && emptyLabel == nil ? Theme.muted : Theme.foreground)
                    Spacer(minLength: 6)
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 10)).foregroundStyle(Theme.muted)
                }
                .padding(.horizontal, 12).frame(height: 38).frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
                .opacity(disabled ? 0.5 : 1)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(disabled).focused($triggerFocused)
            .help(value.isEmpty ? (emptyLabel ?? label) : value)
            .accessibilityLabel(label).accessibilityValue(value.isEmpty ? (emptyLabel ?? "") : value)
            .accessibilityIdentifier(identifier ?? label)
            .popover(isPresented: $isOpen, arrowEdge: .bottom) {
                ModelPickerPopover(label: label, value: value, emptyLabel: emptyLabel, models: models, source: source, debugPrefix: debugPrefix,
                                   onSelect: { choice in
                                       if !disabled { onChange(choice) }
                                       isOpen = false
                                   },
                                   close: { isOpen = false })
            }
            .onChange(of: isOpen) { _, open in if !open { triggerFocused = true } }
        }
    }
}

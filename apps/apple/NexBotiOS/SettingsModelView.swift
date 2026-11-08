import SwiftUI
import Observation
import NexClientKit

/// Unsaved 模型 form. Held by SettingsView so switching categories keeps the edits.
@MainActor @Observable
final class ModelForm {
    static let openAIDefault = "https://api.openai.com/v1"
    static let anthropicDefault = "https://api.anthropic.com"

    var provider: String { didSet { saved = false; resetModels(); clearEnteredKey(); resetLimits() } }
    var model: String { didSet { saved = false; if model != oldValue { resetLimits() } } }
    var endpoint: String { didSet { saved = false; resetModels(); clearEnteredKey(); resetLimits() } }
    var apiKey = "" { didSet { saved = false; if apiKey != oldValue { resetModels() } } }
    /// Fetched catalog (never saved by itself).
    var models: [String] = []
    var hasMore = false
    var loadingModels = false
    var modelNotice: String?
    var modelError: String?
    /// Type the ID by hand even though a catalog is loaded.
    var manual = false
    var showKey = false
    var saving = false
    var saved = false
    var errorText: String?

    // 模型参数: the limits of the current provider + endpoint + model. Blank text = automatic.
    var limits: ModelLimitInfo?
    var contextText = "" { didSet { if contextText != oldValue { saved = false } } }
    var outputText = "" { didSet { if outputText != oldValue { saved = false } } }
    var budgetText = "" { didSet { if budgetText != oldValue { saved = false } } }
    var contextEdited = false
    var outputEdited = false
    var budgetEdited = false
    var limitsLoading = false
    var limitsError: String?
    /// Scope the loaded `limits` belong to.
    var limitsScope: String?
    var scopeKey: String { "\(provider)\n\(endpoint.trimmingCharacters(in: .whitespaces))\n\(model.trimmingCharacters(in: .whitespaces))" }

    /// A different model: show that model's saved overrides, never the previous model's edits.
    func resetLimits() {
        limits = nil; limitsScope = nil; limitsError = nil; limitsLoading = false
        contextText = ""; outputText = ""; budgetText = ""; contextEdited = false; outputEdited = false; budgetEdited = false
    }

    /// Applies an answer for `scope`; ignored when the form moved on. Fields the user edited are kept.
    func apply(_ info: ModelLimitInfo, scope: String) {
        guard scope == scopeKey else { return }
        limits = info; limitsScope = scope
        if !contextEdited { contextText = info.manual.contextWindow.map(String.init) ?? "" }
        if !outputEdited { outputText = info.manual.maxOutputTokens.map(String.init) ?? "" }
        if !budgetEdited { budgetText = info.manual.contextBudget.map(String.init) ?? "" }
    }

    init(config: ModelConfig?) {
        provider = config?.providerID == "anthropic" ? "anthropic" : "openai"
        model = config?.defaultModel ?? ""
        endpoint = config?.endpoint.isEmpty == false ? config!.endpoint : Self.openAIDefault
    }

    /// Switching the protocol swaps the endpoint only while it is one of the two defaults.
    func changeProvider(to next: String) {
        guard next != provider else { return }
        let swap = endpoint == Self.openAIDefault || endpoint == Self.anthropicDefault
        provider = next
        if swap { endpoint = next == "anthropic" ? Self.anthropicDefault : Self.openAIDefault }
    }

    /// A key typed for one service is never sent to another.
    func clearEnteredKey() { if !apiKey.isEmpty { apiKey = "" }; showKey = false }
    func resetModels() { models = []; hasMore = false; modelNotice = nil; modelError = nil; manual = false }
}

/// Settings 模型 category content (embedded in SettingsView's scroll view).
/// Settings 模型 (web `ProviderSettings`): the providers ("供应商"), then one provider's name, base URL, API format, key,
/// 启用 and models. `form` is kept for callers; the provider screens hold their own drafts.
struct SettingsModelView: View {
    let workspace: WorkspaceStore
    @Bindable var form: ModelForm
    @State private var selected: String?

    private var connections: [ModelConnection] { workspace.state?.connections ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if let selected {
                Button { self.selected = nil } label: { Label("供应商", systemImage: "chevron.left").font(.subheadline) }
                    .buttonStyle(.plain).foregroundStyle(Theme.muted)
                if selected == "new" {
                    ProviderFormIOS(workspace: workspace, connection: nil, onDone: { self.selected = $0 }).padding(14).cardStyle()
                } else if let connection = connections.first(where: { $0.id == selected }) {
                    ProviderFormIOS(workspace: workspace, connection: connection, onDone: { _ in }).padding(14).cardStyle().id("\(connection.id)-\(connection.version)")
                    if connection.configured { ProviderModelsIOS(workspace: workspace, connection: connection).padding(14).cardStyle().id("models-\(connection.id)") }
                } else {
                    Text("这个供应商已删除").foregroundStyle(Theme.muted)
                }
            } else {
                PageHeading(title: "模型")
                VStack(spacing: 0) {
                    ForEach(Array(connections.enumerated()), id: \.element.id) { index, connection in
                        if index > 0 { Divider() }
                        Button { selected = connection.id } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "shippingbox").foregroundStyle(Theme.muted)
                                Text(connection.name).foregroundStyle(Theme.foreground).lineLimit(1)
                                if connection.isDefault { StatusChip(text: "默认", tone: .good) }
                                Spacer()
                                Circle().fill(connection.usable ? Theme.success : Theme.offline.opacity(0.5)).frame(width: 8, height: 8)
                                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.muted)
                            }
                            .padding(.horizontal, 14).frame(minHeight: 50).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).accessibilityLabel(connection.name)
                    }
                    if !connections.isEmpty { Divider() }
                    Button { selected = "new" } label: {
                        Label("添加供应商", systemImage: "plus").font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14).frame(minHeight: 50).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.brand)
                }
                .cardStyle()
                if let config = workspace.state?.config { ImageModelSection(workspace: workspace).id("\(config.providerID)|\(config.endpoint)") }
                RetrievalSection(workspace: workspace)
            }
        }
    }
}

/// Name, API format, base URL and key; for a saved provider also 启用, 设为默认 and 删除.
private struct ProviderFormIOS: View {
    let workspace: WorkspaceStore
    let connection: ModelConnection?
    let onDone: (String) -> Void
    @State private var name = ""
    @State private var provider = "openai"
    @State private var endpoint = ""
    @State private var apiKey = ""
    @State private var showKey = false
    @State private var saving = false
    @State private var saved = false
    @State private var error: String?
    @State private var confirmRemove = false

    private var valid: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty && !endpoint.trimmingCharacters(in: .whitespaces).isEmpty && (connection?.configured == true || !apiKey.isEmpty) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Text(connection?.name ?? "添加供应商").font(.headline).lineLimit(1)
                Spacer()
                if let connection {
                    Toggle("启用供应商", isOn: Binding(get: { connection.enabled }, set: { value in run { try await workspace.updateConnection(connection, enabled: value) } }))
                        .labelsHidden().disabled(saving || connection.isDefault)
                    Menu {
                        Button(connection.isDefault ? "已是默认供应商" : "设为默认供应商") { run { try await workspace.setDefaultConnection(id: connection.id) } }.disabled(connection.isDefault)
                        Button("删除供应商", role: .destructive) { confirmRemove = true }.disabled(connection.isDefault)
                    } label: { Image(systemName: "ellipsis.circle").foregroundStyle(Theme.muted) }
                        .accessibilityLabel("更多操作")
                }
            }
            FormField(title: "名称") { TextField("例如：公司 API", text: edited($name)).autocorrectionDisabled() }
            FormField(title: "Base URL") {
                TextField("https://api.example.com/v1", text: edited($endpoint)).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("API 格式").font(.footnote.weight(.semibold))
                Picker("API 格式", selection: edited($provider)) {
                    Text("OpenAI 兼容").tag("openai")
                    Text("Anthropic").tag("anthropic")
                }
                .pickerStyle(.segmented)
            }
            FormField(title: "API Key") {
                HStack(spacing: 8) {
                    Group {
                        let placeholder = connection?.configured == true ? "留空保留已保存的 Key" : "输入 API Key"
                        if showKey { TextField(placeholder, text: edited($apiKey)) } else { SecureField(placeholder, text: edited($apiKey)) }
                    }
                    .textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.oneTimeCode)
                    Button { showKey.toggle() } label: { Image(systemName: showKey ? "eye.slash" : "eye").foregroundStyle(Theme.muted) }
                        .buttonStyle(.plain).accessibilityLabel(showKey ? "隐藏 API Key" : "显示 API Key")
                }
            }
            if let error { InlineBanner(text: error) }
            HStack(spacing: 12) {
                PrimaryButton(title: saving ? "保存中…" : connection == nil ? "添加" : "保存", busy: saving, brand: true) { save() }.disabled(!valid || saving)
                if saved { Label("已保存", systemImage: "checkmark").font(.subheadline.weight(.medium)).foregroundStyle(Theme.success).fixedSize() }
            }
        }
        .onAppear { name = connection?.name ?? ""; provider = connection?.provider ?? "openai"; endpoint = connection?.endpoint ?? "" }
        .confirmationDialog("删除供应商「\(connection?.name ?? "")」？", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("删除", role: .destructive) { if let connection { run { try await workspace.removeConnection(connection) } } }
        } message: { Text("它的 API Key 会被清除，正在用它的助手会改用默认供应商。") }
    }

    private func edited(_ binding: Binding<String>) -> Binding<String> { Binding(get: { binding.wrappedValue }, set: { binding.wrappedValue = $0; saved = false }) }

    private func run(_ body: @escaping () async throws -> Void) {
        saving = true; error = nil
        Task { defer { saving = false }; do { try await body() } catch { self.error = (error as? CoreError)?.message ?? error.localizedDescription } }
    }

    private func save() {
        guard valid, !saving else { return }
        let key = apiKey
        saving = true; error = nil
        Task {
            defer { saving = false }
            do {
                let id = try await workspace.saveConnection(id: connection?.id, version: connection?.version, name: name.trimmingCharacters(in: .whitespaces), provider: provider,
                                                            endpoint: endpoint.trimmingCharacters(in: .whitespaces), apiKey: key, enabled: connection?.enabled)
                apiKey = ""; showKey = false; saved = true
                if connection == nil { onDone(id) }
            } catch { self.error = (error as? CoreError)?.message ?? error.localizedDescription }
        }
    }
}

/// A provider's models: 启用 (全选 / 全不选), 设为默认模型 and each model's settings.
private struct ProviderModelsIOS: View {
    let workspace: WorkspaceStore
    let connection: ModelConnection
    @State private var fetched: [String] = []
    @State private var loading = false
    @State private var error = ""
    @State private var custom = ""
    @State private var query = ""
    @State private var editing: String?
    @State private var autosave: ModelSelectionAutosave?
    @State private var loaded = false

    private var stored: ModelVisibility { ModelVisibility(models: connection.models, version: connection.modelsVersion) }
    private var selection: [String]? { autosave?.selection ?? stored.models }
    private var all: [String] {
        var seen = Set<String>()
        return (fetched + (selection ?? []) + [connection.defaultModel] + Array(connection.options.keys)).filter { !$0.isEmpty && seen.insert($0).inserted }.sorted()
    }
    private var enabled: Set<String> { Set(selection ?? all) }
    private var rows: [String] {
        let terms = query.lowercased().split(separator: " ").map(String.init)
        return all.filter { model in terms.allSatisfy { model.lowercased().contains($0) } }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("模型列表").font(.subheadline.weight(.semibold))
                Spacer()
                Button(loading ? "获取中…" : "获取模型") { Task { await load() } }.buttonStyle(PillButtonStyle()).disabled(loading)
            }
            HStack(spacing: 8) {
                TextField("手动添加模型 ID", text: $custom).textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.done).onSubmit(addCustom)
                    .padding(.horizontal, 12).padding(.vertical, 9).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                Button("添加", action: addCustom).buttonStyle(PillButtonStyle()).disabled(custom.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if !error.isEmpty { InlineBanner(text: error) }
            if let failure = autosave?.error, !failure.isEmpty { InlineBanner(text: failure) }
            if all.count > 12 || !query.isEmpty {
                TextField("搜索模型", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .padding(.horizontal, 12).padding(.vertical, 9).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            HStack {
                Text("\(all.count) 个模型 · 已启用 \(enabled.count)\(autosave?.busy == true ? " · 保存中…" : "")").font(.caption).foregroundStyle(Theme.muted)
                Spacer()
                Button("全选") { bulk(true) }.font(.caption).disabled(rows.isEmpty || rows.allSatisfy(enabled.contains))
                Button("全不选") { bulk(false) }.font(.caption).disabled(!rows.contains(where: enabled.contains))
            }
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element) { index, model in
                    if index > 0 { Divider() }
                    row(model)
                }
                if rows.isEmpty { Text(loading ? "正在获取模型…" : "没有模型，可点「获取模型」或手动添加").font(.footnote).foregroundStyle(Theme.muted).padding(12) }
            }
        }
        .onAppear {
            guard autosave == nil else { return }
            let id = connection.id
            autosave = ModelSelectionAutosave(initial: stored) { [workspace] models, version in try await workspace.saveModelVisibility(connectionID: id, models: models, version: version) }
        }
        .onChange(of: stored) { autosave?.sync(stored) }
        .task { if !loaded { loaded = true; await load() } }
        .sheet(item: Binding(get: { editing.map(EditingModel.init) }, set: { editing = $0?.id })) { item in
            ModelOptionsSheetIOS(workspace: workspace, connection: connection, model: item.id).presentationDetents([.medium, .large])
        }
    }

    private struct EditingModel: Identifiable { let id: String }

    @ViewBuilder private func row(_ model: String) -> some View {
        let options = connection.options[model], isDefault = model == connection.defaultModel
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                Text(model).font(.callout.monospaced()).foregroundStyle(enabled.contains(model) ? Theme.foreground : Theme.muted).lineLimit(1).truncationMode(.middle)
                let tags = [isDefault ? "默认" : nil, options?.imageInput == true ? "视觉" : nil, options?.reasoning.first.map { "推理 \($0.label)\(options!.reasoning.count > 1 ? "–\(options!.reasoning.last!.label)" : "")" }].compactMap { $0 }
                if !tags.isEmpty { Text(tags.joined(separator: " · ")).font(.caption2).foregroundStyle(Theme.muted) }
            }
            Spacer(minLength: 6)
            Menu {
                if !isDefault { Button("设为默认模型") { Task { try? await workspace.updateConnection(connection, defaultModel: model) } } }
                Button("编辑") { editing = model }
            } label: { Image(systemName: "ellipsis").foregroundStyle(Theme.muted).frame(width: 30, height: 30) }
                .accessibilityLabel("\(model) 的操作")
            Toggle("启用 \(model)", isOn: Binding(get: { enabled.contains(model) }, set: { _ in autosave?.toggle(model, all: all) })).labelsHidden()
        }
        .padding(.vertical, 6)
    }

    private func bulk(_ checked: Bool) {
        var next = enabled
        for model in rows { if checked { next.insert(model) } else { next.remove(model) } }
        autosave?.set(checked && query.isEmpty ? nil : next.sorted())
    }

    private func addCustom() {
        let id = custom.trimmingCharacters(in: .whitespaces)
        guard !id.isEmpty, id.count <= 200 else { return }
        if !enabled.contains(id) { autosave?.set(Array(Set(selection ?? all).union([id])).sorted()) }
        custom = ""
    }

    private func load() async {
        guard !loading else { return }
        loading = true; error = ""
        defer { loading = false }
        do { fetched = try await workspace.listModels(connectionID: connection.id).models }
        catch { self.error = (error as? CoreError)?.message ?? error.localizedDescription }
    }
}

/// One model's settings: context window, output ceiling, image input and the reasoning levels it offers.
private struct ModelOptionsSheetIOS: View {
    let workspace: WorkspaceStore
    let connection: ModelConnection
    let model: String
    @Environment(\.dismiss) private var dismiss
    @State private var info: ModelLimitInfo?
    @State private var context = ""
    @State private var output = ""
    @State private var imageInput = false
    @State private var levels: [ReasoningLevel] = []
    @State private var saving = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("上下文") {
                    TextField(info.map { "上下文窗口（自动 · \($0.automatic.contextWindow.formatted())）" } ?? "上下文窗口（自动）", text: $context).keyboardType(.numberPad)
                    TextField(info.map { "最大输出（自动 · \($0.automatic.maxOutputTokens.formatted())）" } ?? "最大输出（自动）", text: $output).keyboardType(.numberPad)
                }
                Section { Toggle("支持图片输入", isOn: $imageInput) }
                Section("推理档位") {
                    ForEach(ReasoningLevel.allCases, id: \.self) { level in
                        Toggle(level.label, isOn: Binding(get: { levels.contains(level) }, set: { on in levels = ReasoningLevel.allCases.filter { $0 == level ? on : levels.contains($0) } }))
                    }
                }
                if !error.isEmpty { Section { Text(error).foregroundStyle(Theme.danger) } }
            }
            .navigationTitle(model).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(saving ? "保存中…" : "保存", action: save).disabled(saving) }
            }
        }
        .task {
            let stored = connection.options[model]
            imageInput = stored?.imageInput ?? false; levels = stored?.reasoning ?? []
            guard let result = try? await workspace.modelLimits(provider: connection.provider, endpoint: connection.endpoint, model: model) else { return }
            info = result
            context = result.manual.contextWindow.map(String.init) ?? ""; output = result.manual.maxOutputTokens.map(String.init) ?? ""
            if stored == nil, let capabilities = result.capabilities { imageInput = capabilities.imageInput; if capabilities.reasoning { levels = [.low, .medium, .high] } }
        }
    }

    private func save() {
        let trimmedContext = context.trimmingCharacters(in: .whitespaces), trimmedOutput = output.trimmingCharacters(in: .whitespaces)
        guard trimmedContext.isEmpty || Int(trimmedContext) != nil, trimmedOutput.isEmpty || Int(trimmedOutput) != nil else { error = "请输入整数"; return }
        saving = true; error = ""
        Task {
            defer { saving = false }
            do {
                try await workspace.saveModelOptions(connectionID: connection.id, model: model, version: connection.options[model]?.version ?? 0, imageInput: imageInput, reasoning: levels,
                                                     contextWindow: Int(trimmedContext), maxOutputTokens: Int(trimmedOutput))
                dismiss()
            } catch { self.error = (error as? CoreError)?.message ?? error.localizedDescription }
        }
    }
}

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
    var contextEdited = false
    var outputEdited = false
    var limitsLoading = false
    var limitsError: String?
    /// Scope the loaded `limits` belong to.
    var limitsScope: String?
    var scopeKey: String { "\(provider)\n\(endpoint.trimmingCharacters(in: .whitespaces))\n\(model.trimmingCharacters(in: .whitespaces))" }

    /// A different model: show that model's saved overrides, never the previous model's edits.
    func resetLimits() {
        limits = nil; limitsScope = nil; limitsError = nil; limitsLoading = false
        contextText = ""; outputText = ""; contextEdited = false; outputEdited = false
    }

    /// Applies an answer for `scope`; ignored when the form moved on. Fields the user edited are kept.
    func apply(_ info: ModelLimitInfo, scope: String) {
        guard scope == scopeKey else { return }
        limits = info; limitsScope = scope
        if !contextEdited { contextText = info.manual.contextWindow.map(String.init) ?? "" }
        if !outputEdited { outputText = info.manual.maxOutputTokens.map(String.init) ?? "" }
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
struct SettingsModelView: View {
    let workspace: WorkspaceStore
    @Bindable var form: ModelForm
    @State private var pickerOpen = false
    /// The 显示的模型 choice shown in the form; for a new connection it is saved after the connection.
    @State private var visible: [String]?

    private var config: ModelConfig? { workspace.state?.config }
    private var keyRequired: Bool { config == nil }
    private var canSave: Bool {
        !form.model.trimmingCharacters(in: .whitespaces).isEmpty && !form.endpoint.trimmingCharacters(in: .whitespaces).isEmpty
            && (!keyRequired || !form.apiKey.isEmpty) && !form.saving
    }

    /// The form addresses the saved connection, whose 显示的模型 save on their own.
    private var connectionSaved: Bool {
        let slash = CharacterSet(charactersIn: "/")
        return config.map { $0.providerID == form.provider && $0.endpoint.trimmingCharacters(in: slash) == form.endpoint.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: slash) } ?? false
    }

    private var loadable: Bool { !form.endpoint.trimmingCharacters(in: .whitespaces).isEmpty && !form.loadingModels && !form.saving }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            PageHeading(title: "模型")
            HStack {
                Text("模型连接").font(.subheadline.weight(.semibold))
                Spacer()
                StatusChip(text: config == nil ? "待配置" : "已配置", tone: config == nil ? .warn : .good)
            }
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("API 协议").font(.footnote.weight(.semibold))
                    Picker("API 协议", selection: Binding(get: { form.provider }, set: { form.changeProvider(to: $0) })) {
                        Text("OpenAI 兼容").tag("openai")
                        Text("Anthropic").tag("anthropic")
                    }
                    .pickerStyle(.segmented)
                }
                FormField(title: "API 基础地址") {
                    TextField(ModelForm.openAIDefault, text: $form.endpoint)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                FormField(title: "API Key") {
                    HStack(spacing: 8) {
                        Group {
                            if form.showKey { TextField(keyPlaceholder, text: $form.apiKey) } else { SecureField(keyPlaceholder, text: $form.apiKey) }
                        }
                        .textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.oneTimeCode)
                        Button { form.showKey.toggle() } label: {
                            Image(systemName: form.showKey ? "eye.slash" : "eye").foregroundStyle(Theme.muted)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(form.showKey ? "隐藏 API Key" : "显示 API Key")
                    }
                }
                listField
                ModelVisibilitySection(workspace: workspace, fetched: form.models, draft: !connectionSaved, onSelection: { visible = $0 })
                    .id("\(form.provider)|\(form.endpoint.trimmingCharacters(in: .whitespaces))|\(connectionSaved)")
                modelField
                limitsSection
                if let message = form.errorText { InlineBanner(text: message) }
                HStack(spacing: 12) {
                    PrimaryButton(title: form.saving ? "保存中…" : "保存配置", busy: form.saving, brand: true) { Task { await save() } }.disabled(!canSave)
                    if form.saved {
                        Label("已保存", systemImage: "checkmark").font(.subheadline.weight(.medium)).foregroundStyle(Theme.success).fixedSize()
                    }
                }
            }
            .padding(14).cardStyle()
            if let config { ImageModelSection(workspace: workspace).id("\(config.providerID)|\(config.endpoint)") }
        }
        .onDisappear { form.showKey = false }
        .task(id: form.scopeKey) { await loadLimits() }
        .onDebugUI { cmd, arg in
            switch cmd {
            case "m-provider": form.changeProvider(to: arg)
            case "m-model": form.model = arg
            case "m-endpoint": form.endpoint = arg
            case "m-key": form.apiKey = arg
            case "m-list": Task { await loadModels() }
            case "m-pick": if form.models.contains(arg) { form.model = arg }
            case "m-open": pickerOpen = true
            case "m-close": pickerOpen = false
            case "m-save": Task { await save() }
            case "m-context": form.contextEdited = true; form.contextText = arg
            case "m-output": form.outputEdited = true; form.outputText = arg
            case "m-lookup": Task { await lookup(force: true) }
            default: break
            }
        }
    }

    /// The 显示的模型 choice, else a list fetched with 获取模型列表, else nil (the picker fetches it).
    private var pickerModels: [String]? {
        if let visible { return visible }
        return form.models.isEmpty ? nil : form.models
    }
    private var pickerSource: ModelSource? {
        let endpoint = form.endpoint.trimmingCharacters(in: .whitespaces)
        return endpoint.isEmpty ? nil : workspace.formModelSource(provider: form.provider, endpoint: endpoint, apiKey: form.apiKey)
    }

    private var keyPlaceholder: String { config == nil ? "输入 API Key" : "留空保留已保存的 Key" }

    private var modelField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("默认模型").font(.footnote.weight(.semibold))
            ModelPickerField(label: "默认模型", value: form.model, models: pickerModels, source: pickerSource, isOpen: $pickerOpen, onChange: { form.model = $0 })
        }
    }

    private var listField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("模型列表").font(.footnote.weight(.semibold))
            HStack(spacing: 12) {
                Button { Task { await loadModels() } } label: {
                    HStack(spacing: 6) {
                        if form.loadingModels { ProgressView().controlSize(.small) }
                        Text(form.loadingModels ? "获取中…" : "获取模型列表")
                    }
                }
                .buttonStyle(PillButtonStyle()).disabled(!loadable)
            }
            if let notice = form.modelNotice { Text(notice).font(.caption).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
            if let error = form.modelError { Text(error).font(.caption).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true) }
        }
    }

    // MARK: 模型参数

    private var limitsModelReady: Bool { !form.model.trimmingCharacters(in: .whitespaces).isEmpty && !form.endpoint.trimmingCharacters(in: .whitespaces).isEmpty }

    private func separated(_ n: Int?) -> String { n.map { $0.formatted(.number.grouping(.automatic)) } ?? "—" }

    private var limitsSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("模型参数").font(.subheadline.weight(.semibold))
                Spacer()
                Button { Task { await lookup(force: true) } } label: {
                    HStack(spacing: 6) {
                        if form.limitsLoading { ProgressView().controlSize(.small) }
                        Text(form.limitsLoading ? "识别中…" : "联网识别")
                    }
                }
                .buttonStyle(PillButtonStyle()).disabled(form.limitsLoading || !limitsModelReady || form.limitsScope != form.scopeKey)
            }
            limitField("上下文窗口（Token）", text: $form.contextText, edited: { form.contextEdited = true },
                       automatic: form.limits?.automatic.contextWindow, source: form.limits?.automatic.source.contextWindow, name: "context")
            limitField("最大输出 Token", text: $form.outputText, edited: { form.outputEdited = true },
                       automatic: form.limits?.automatic.maxOutputTokens, source: form.limits?.automatic.source.maxOutputTokens, name: "output")
            Text((form.limits?.status ?? .matched).text).font(.caption).foregroundStyle(Theme.muted)
            if let error = form.limitsError { Text(error).font(.caption).foregroundStyle(Theme.danger) }
        }
    }

    private func limitField(_ title: String, text: Binding<String>, edited: @escaping () -> Void, automatic: Int?, source: ModelLimitSource?, name: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.footnote.weight(.semibold))
            TextField(automatic.map { "自动 · \(separated($0))" } ?? "读取中…", text: Binding(get: { text.wrappedValue }, set: { edited(); text.wrappedValue = $0 }))
                .keyboardType(.numberPad)
                .disabled(form.limits == nil)
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityLabel(title)
            Text(text.wrappedValue.isEmpty ? "\(source == .modelsDev ? "models.dev" : "默认") · \(separated(automatic))" : "手动配置")
                .font(.caption).foregroundStyle(Theme.muted)
        }
    }

    /// Saved overrides and the cached answer first, then the public directory while a field is automatic.
    private func loadLimits() async {
        guard limitsModelReady else { return }
        try? await Task.sleep(for: .milliseconds(400))
        guard !Task.isCancelled else { return }
        await lookup(force: false)
    }

    private func lookup(force: Bool) async {
        guard limitsModelReady else { return }
        let scope = form.scopeKey
        let (provider, endpoint, model) = (form.provider, form.endpoint.trimmingCharacters(in: .whitespaces), form.model.trimmingCharacters(in: .whitespaces))
        form.limitsError = nil
        do {
            if !force || form.limitsScope != scope {
                let cached = try await workspace.modelLimits(provider: provider, endpoint: endpoint, model: model)
                form.apply(cached, scope: scope)
                guard scope == form.scopeKey else { return }
                if !force && cached.manual.contextWindow != nil && cached.manual.maxOutputTokens != nil { return }
            }
            form.limitsLoading = true
            defer { if scope == form.scopeKey { form.limitsLoading = false } }
            let result = try await workspace.refreshModelLimits(provider: provider, endpoint: endpoint, model: model, force: force)
            form.apply(result, scope: scope)
            if scope == form.scopeKey, result.refreshFailed { form.limitsError = "联网识别失败，使用缓存或默认值" }
        } catch {
            if scope == form.scopeKey { form.limitsError = coreMessage(error) }
        }
    }

    /// Fetches the provider's catalog with the typed provider/endpoint/key (an empty key reuses the saved one). Never saves.
    private func loadModels() async {
        guard loadable else { return }
        form.loadingModels = true; form.modelError = nil; form.modelNotice = nil
        defer { form.loadingModels = false }
        do {
            let catalog = try await workspace.listModels(provider: form.provider, endpoint: form.endpoint.trimmingCharacters(in: .whitespaces), apiKey: form.apiKey)
            form.models = catalog.models; form.hasMore = catalog.hasMore; form.manual = false
            if form.model.trimmingCharacters(in: .whitespaces).isEmpty, let first = catalog.models.first { form.model = first }
            form.modelNotice = catalog.models.isEmpty
                ? "服务未返回可用模型，可手动填写模型 ID"
                : "已获取 \(catalog.models.count) 个模型" + (catalog.hasMore ? "（服务仅返回部分结果，可手动填写其他模型）" : "")
        } catch { form.modelError = coreMessage(error) }
    }

    private func save() async {
        guard canSave else { return }
        form.saving = true; form.errorText = nil
        defer { form.saving = false }
        do {
            // Untouched or not yet loaded fields keep what Core has saved; blank edited fields clear to automatic.
            let ready = form.limitsScope == form.scopeKey
            let context = ready ? try ModelLimits.parse(form.contextText, field: .contextWindow) : LimitSetting.preserve
            let output = ready ? try ModelLimits.parse(form.outputText, field: .maxOutputTokens) : LimitSetting.preserve
            let wasSaved = connectionSaved, draft = visible
            try await workspace.saveModel(provider: form.provider, model: form.model.trimmingCharacters(in: .whitespaces), endpoint: form.endpoint.trimmingCharacters(in: .whitespaces), apiKey: form.apiKey,
                                          contextWindow: context, maxOutputTokens: output)
            // A new connection's 显示的模型 were a draft until the connection existed.
            if !wasSaved, let draft { try await workspace.saveModelVisibility(models: draft) }
            form.showKey = false; form.saved = true
        } catch { form.errorText = coreMessage(error) }
    }
}

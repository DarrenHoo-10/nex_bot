import SwiftUI
import Observation
import NexClientKit

/// Unsaved 模型 form. Held by SettingsView so switching categories keeps the edits.
@MainActor @Observable
final class ModelForm {
    static let openAIDefault = "https://api.openai.com/v1"
    static let anthropicDefault = "https://api.anthropic.com"

    var provider: String { didSet { saved = false; resetModels(); clearEnteredKey() } }
    var model: String { didSet { saved = false } }
    var endpoint: String { didSet { saved = false; resetModels(); clearEnteredKey() } }
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

    var hint: String { provider == "anthropic" ? "填写服务根地址，不包含 /v1/messages。" : "通常以 /v1 结尾，不包含 /chat/completions。" }
}

/// Settings 模型 category content (embedded in SettingsView's scroll view).
struct SettingsModelView: View {
    let workspace: WorkspaceStore
    @Bindable var form: ModelForm

    private var config: ModelConfig? { workspace.state?.config }
    private var keyRequired: Bool { config == nil }
    private var canSave: Bool {
        !form.model.trimmingCharacters(in: .whitespaces).isEmpty && !form.endpoint.trimmingCharacters(in: .whitespaces).isEmpty
            && (!keyRequired || !form.apiKey.isEmpty) && !form.saving
    }

    private var loadable: Bool { !form.endpoint.trimmingCharacters(in: .whitespaces).isEmpty && !form.loadingModels && !form.saving }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            PageHeading(title: "模型", detail: "选择助手使用的模型，并连接你的服务商。")
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
                FormField(title: "API 基础地址", hint: form.hint) {
                    TextField(ModelForm.openAIDefault, text: $form.endpoint)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                FormField(title: "API Key", hint: "密钥将加密保存；眼睛按钮可查看本次填写的内容。") {
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
                modelField
                if let message = form.errorText { InlineBanner(text: message) }
                HStack(spacing: 12) {
                    PrimaryButton(title: form.saving ? "保存中…" : "保存配置", busy: form.saving, brand: true) { Task { await save() } }.disabled(!canSave)
                    if form.saved {
                        Label("已保存", systemImage: "checkmark").font(.subheadline.weight(.medium)).foregroundStyle(Theme.success).fixedSize()
                    }
                }
            }
            .padding(14).cardStyle()
        }
        .onDisappear { form.showKey = false }
        .onDebugUI { cmd, arg in
            switch cmd {
            case "m-provider": form.changeProvider(to: arg)
            case "m-model": form.model = arg
            case "m-endpoint": form.endpoint = arg
            case "m-key": form.apiKey = arg
            case "m-list": Task { await loadModels() }
            case "m-pick": if form.models.contains(arg) { form.model = arg }
            case "m-manual": form.manual.toggle()
            case "m-save": Task { await save() }
            default: break
            }
        }
    }

    private var keyPlaceholder: String { config == nil ? "输入 API Key" : "留空保留已保存的 Key" }

    private var modelField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("模型").font(.footnote.weight(.semibold))
            if !form.models.isEmpty && !form.manual {
                Menu {
                    Picker("模型", selection: $form.model) {
                        if !form.model.isEmpty && !form.models.contains(form.model) { Text("\(form.model)（当前配置）").tag(form.model) }
                        ForEach(form.models, id: \.self) { Text($0).tag($0) }
                    }
                } label: {
                    HStack {
                        Text(form.model.isEmpty ? "选择模型" : form.model).lineLimit(1).foregroundStyle(form.model.isEmpty ? Theme.muted : Theme.foreground)
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(Theme.muted)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 11).frame(maxWidth: .infinity)
                    .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .accessibilityLabel("模型")
            } else {
                TextField("选择或填写模型 ID", text: $form.model).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .padding(.horizontal, 12).padding(.vertical, 11)
                    .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            HStack(spacing: 12) {
                Button { Task { await loadModels() } } label: {
                    HStack(spacing: 6) {
                        if form.loadingModels { ProgressView().controlSize(.small) }
                        Text(form.loadingModels ? "获取中…" : "获取模型列表")
                    }
                }
                .buttonStyle(PillButtonStyle()).disabled(!loadable)
                if !form.models.isEmpty {
                    Button(form.manual ? "从列表选择" : "手动填写") { form.manual.toggle() }
                        .font(.footnote.weight(.medium)).foregroundStyle(Theme.brand).buttonStyle(.plain)
                }
            }
            if let notice = form.modelNotice { Text(notice).font(.caption).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
            if let error = form.modelError { Text(error).font(.caption).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true) }
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
            try await workspace.saveModel(provider: form.provider, model: form.model.trimmingCharacters(in: .whitespaces), endpoint: form.endpoint.trimmingCharacters(in: .whitespaces), apiKey: form.apiKey)
            form.showKey = false; form.saved = true
        } catch { form.errorText = coreMessage(error) }
    }
}

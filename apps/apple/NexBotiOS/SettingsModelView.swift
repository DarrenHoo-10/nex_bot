import SwiftUI
import Observation
import NexClientKit

/// Unsaved 模型 form. Held by SettingsView so switching categories keeps the edits.
@MainActor @Observable
final class ModelForm {
    static let openAIDefault = "https://api.openai.com/v1"
    static let anthropicDefault = "https://api.anthropic.com"

    var provider: String { didSet { saved = false } }
    var model: String { didSet { saved = false } }
    var endpoint: String { didSet { saved = false } }
    var apiKey = "" { didSet { saved = false } }
    var advancedOpen = false
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

    var hint: String { provider == "anthropic" ? "填写服务根地址，不包含 /v1/messages。" : "通常以 /v1 结尾，不包含 /chat/completions。" }

    /// The URL Core will call, or nil for an invalid base address.
    var requestURL: String? {
        guard let parts = URLComponents(string: endpoint.trimmingCharacters(in: .whitespaces)),
              let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil else { return nil }
        var path = parts.path
        while path.hasSuffix("/") { path.removeLast() }
        let port = parts.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)\(path)" + (provider == "anthropic" ? "/v1/messages" : "/chat/completions")
    }
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
                FormField(title: "模型 ID") {
                    TextField("服务商提供的模型 ID", text: $form.model).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                FormField(title: "API 基础地址", hint: form.hint) {
                    TextField(ModelForm.openAIDefault, text: $form.endpoint)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                FormField(title: "API Key", hint: "密钥由后端加密保存。") {
                    SecureField(config == nil ? "输入 API Key" : "留空保留已保存的 Key", text: $form.apiKey).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                DisclosureGroup(isExpanded: $form.advancedOpen) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("实际请求地址").font(.footnote.weight(.semibold))
                        Text(form.requestURL ?? "请输入有效的 API 基础地址").font(.system(.footnote, design: .monospaced))
                            .foregroundStyle(form.requestURL == nil ? Theme.muted : Theme.foreground).textSelection(.enabled)
                        Text(form.provider == "anthropic" ? "使用 Anthropic Messages 协议。" : "使用 Chat Completions 协议。").font(.caption).foregroundStyle(Theme.muted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
                } label: { Text("高级设置").font(.subheadline.weight(.semibold)) }
                if let message = form.errorText { InlineBanner(text: message) }
                HStack(spacing: 12) {
                    PrimaryButton(title: form.saving ? "保存中…" : "保存配置", busy: form.saving) { Task { await save() } }.disabled(!canSave)
                    if form.saved {
                        Label("已保存", systemImage: "checkmark").font(.subheadline.weight(.medium)).foregroundStyle(Theme.success).fixedSize()
                    }
                }
            }
            .padding(14).cardStyle()
        }
        .onDebugUI { cmd, arg in
            switch cmd {
            case "m-provider": form.changeProvider(to: arg)
            case "m-model": form.model = arg
            case "m-endpoint": form.endpoint = arg
            case "m-key": form.apiKey = arg
            case "m-advanced": form.advancedOpen = true
            case "m-save": Task { await save() }
            default: break
            }
        }
    }

    private func save() async {
        guard canSave else { return }
        form.saving = true; form.errorText = nil
        defer { form.saving = false }
        do {
            try await workspace.saveModel(provider: form.provider, model: form.model.trimmingCharacters(in: .whitespaces), endpoint: form.endpoint.trimmingCharacters(in: .whitespaces), apiKey: form.apiKey)
            form.apiKey = ""; form.saved = true
        } catch { form.errorText = coreMessage(error) }
    }
}

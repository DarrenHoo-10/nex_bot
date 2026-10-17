import SwiftUI
import NexClientKit

/// Settings 模型 category: API protocol, model id, endpoint and key (web `ModelSettings`).
struct SettingsModelPane: View {
    let workspace: WorkspaceStore

    private static let openAIDefault = "https://api.openai.com/v1"
    private static let anthropicDefault = "https://api.anthropic.com"

    @State private var provider = "openai"
    @State private var model = ""
    @State private var endpoint = SettingsModelPane.openAIDefault
    @State private var apiKey = ""
    @State private var advancedOpen = false
    @State private var saving = false
    @State private var saved = false
    @State private var error: String?
    @State private var dirty = false

    private var config: ModelConfig? { workspace.state?.config }
    private var valid: Bool {
        !model.trimmingCharacters(in: .whitespaces).isEmpty && !endpoint.trimmingCharacters(in: .whitespaces).isEmpty
            && (config != nil || !apiKey.isEmpty)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            paneHeader("模型", "选择助手使用的模型，并连接你的服务商。")
            HStack {
                Text("模型连接").font(.system(size: 13, weight: .semibold))
                Spacer()
                Text(config != nil ? "已配置" : "待配置").font(.system(size: 10)).foregroundStyle(Theme.muted)
                    .padding(.horizontal, 8).padding(.vertical, 4).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 5))
            }
            .padding(.top, 24)
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .top, spacing: 18) {
                    MBSelect(label: "API 协议", selection: Binding(get: { provider }, set: { setProvider($0) }),
                             options: [("openai", "OpenAI 兼容"), ("anthropic", "Anthropic")])
                    MBInput(label: "模型 ID", text: edit($model), placeholder: "服务商提供的模型 ID")
                }
                MBInput(label: "API 基础地址", text: edit($endpoint), placeholder: Self.openAIDefault, mono: false,
                        hint: provider == "anthropic" ? "填写服务根地址，不包含 /v1/messages。" : "通常以 /v1 结尾，不包含 /chat/completions。")
                MBInput(label: "API Key", text: edit($apiKey), placeholder: config != nil ? "留空保留已保存的 Key" : "输入 API Key", secure: true,
                        hint: "密钥由后端加密保存。")
            }
            .padding(.top, 20).padding(.bottom, 22)
            Hairline()
            MBDisclosure(title: "高级设置", open: $advancedOpen) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("实际请求地址").font(.system(size: 12, weight: .medium))
                    Text(requestURL ?? "请输入有效的 API 基础地址").font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                    Text(provider == "anthropic" ? "使用 Anthropic Messages 协议。" : "使用 Chat Completions 协议。")
                        .font(.system(size: 10)).foregroundStyle(Theme.muted)
                }
            }
            .padding(.vertical, 18)
            HStack(spacing: 14) {
                MBButton(title: saving ? "保存中…" : "保存配置", kind: .brand, busy: saving, enabled: valid, action: save)
                if saved && !dirty {
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark").font(.system(size: 11)); Text("已保存").font(.system(size: 12))
                    }
                    .foregroundStyle(Theme.muted)
                }
            }
            if let error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled).padding(.top, 12) }
        }
        .onAppear(perform: load)
        .onChange(of: "\(config?.providerID ?? "")|\(config?.defaultModel ?? "")|\(config?.endpoint ?? "")") { if !dirty { load() } }
        #if DEBUG
        .task { MBDebug.start() }
        .onReceive(NotificationCenter.default.publisher(for: .mbDebug)) { note in
            guard let cmd = note.mbCommand, cmd.prefix == "md" else { return }
            switch cmd.verb {
            case "fill":
                let p = cmd.arg.components(separatedBy: "|")
                if p.count > 0, !p[0].isEmpty { model = p[0] }; if p.count > 1, !p[1].isEmpty { endpoint = p[1] }; if p.count > 2 { apiKey = p[2] }
                dirty = true; saved = false
            case "protocol": setProvider(cmd.arg)
            case "advanced": advancedOpen = true
            case "save": save()
            default: break
            }
        }
        #endif
    }

    /// Binding that marks the form edited (hides 已保存).
    private func edit(_ binding: Binding<String>) -> Binding<String> {
        Binding(get: { binding.wrappedValue }, set: { binding.wrappedValue = $0; dirty = true; saved = false })
    }

    private func setProvider(_ next: String) {
        provider = next; dirty = true; saved = false
        let trimmed = endpoint.trimmingCharacters(in: .whitespaces)
        if trimmed == Self.openAIDefault || trimmed == Self.anthropicDefault {
            endpoint = next == "anthropic" ? Self.anthropicDefault : Self.openAIDefault
        }
    }

    private func load() {
        provider = config?.providerID ?? "openai"
        model = config?.defaultModel ?? ""
        endpoint = config.map { $0.endpoint.isEmpty ? Self.openAIDefault : $0.endpoint } ?? Self.openAIDefault
        apiKey = ""; dirty = false
    }

    /// `origin + path` of the base URL plus the protocol path; nil when the URL is not a plain http(s) address.
    private var requestURL: String? {
        guard let c = URLComponents(string: endpoint.trimmingCharacters(in: .whitespaces)),
              let scheme = c.scheme, scheme == "http" || scheme == "https", let host = c.host, !host.isEmpty,
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil else { return nil }
        var base = "\(scheme)://\(host.contains(":") ? "[\(host)]" : host)"
        if let port = c.port { base += ":\(port)" }
        var path = c.path
        while path.hasSuffix("/") { path.removeLast() }
        return base + path + (provider == "anthropic" ? "/v1/messages" : "/chat/completions")
    }

    private func save() {
        guard valid, !saving else { return }
        saving = true; error = nil
        Task {
            defer { saving = false }
            do {
                try await workspace.saveModel(provider: provider, model: model.trimmingCharacters(in: .whitespaces),
                                              endpoint: endpoint.trimmingCharacters(in: .whitespaces), apiKey: apiKey)
                apiKey = ""; dirty = false; saved = true
            } catch {
                self.error = mbFallbackMessage(error); saved = false
            }
        }
    }
}

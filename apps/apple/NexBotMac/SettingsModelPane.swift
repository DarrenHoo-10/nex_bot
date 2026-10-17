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
    @State private var showKey = false
    @State private var saving = false
    @State private var saved = false
    @State private var error: String?
    @State private var dirty = false
    // Model discovery (web `loadModels`): listing never saves anything.
    @State private var models: [String] = []
    @State private var loadingModels = false
    @State private var modelNotice = ""
    @State private var modelError = ""
    @State private var manual = false

    private var config: ModelConfig? { workspace.state?.config }
    private var valid: Bool {
        !model.trimmingCharacters(in: .whitespaces).isEmpty && !endpoint.trimmingCharacters(in: .whitespaces).isEmpty
            && (config != nil || !apiKey.isEmpty)
    }
    private var busy: Bool { saving || loadingModels }

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
                MBSelect(label: "API 协议", selection: Binding(get: { provider }, set: { setProvider($0) }),
                         options: [("openai", "OpenAI 兼容"), ("anthropic", "Anthropic")])
                MBInput(label: "API 基础地址", text: Binding(get: { endpoint }, set: { endpoint = $0; apiKey = ""; showKey = false; edited(resetList: true) }),
                        placeholder: Self.openAIDefault, mono: false,
                        hint: provider == "anthropic" ? "填写服务根地址，不包含 /v1/messages。" : "通常以 /v1 结尾，不包含 /chat/completions。")
                keyField
                modelField
            }
            .disabled(busy)
            .padding(.top, 20).padding(.bottom, 26)
            HStack(spacing: 14) {
                MBButton(title: saving ? "保存中…" : "保存配置", kind: .brand, busy: saving, enabled: valid && !loadingModels, action: save)
                if saved && !dirty {
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark").font(.system(size: 11)); Text("已保存").font(.system(size: 12))
                    }
                    .foregroundStyle(Theme.muted)
                }
            }
            if let error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled).padding(.top, 12) }
        }
        .onAppear { load() }
        .onChange(of: "\(config?.providerID ?? "")|\(config?.defaultModel ?? "")|\(config?.endpoint ?? "")") { if !dirty { load(keepList: true) } }
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
            case "list": loadModels()
            case "pick": model = cmd.arg; dirty = true; saved = false
            case "reveal": showKey.toggle()
            case "manual": manual.toggle()
            case "save": save()
            default: break
            }
        }
        #endif
    }

    // MARK: Fields

    private var keyField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("API Key").font(.system(size: 12, weight: .medium))
            HStack(spacing: 6) {
                Group {
                    let prompt = Text(config != nil ? "留空保留已保存的 Key" : "输入 API Key").foregroundStyle(Theme.muted.opacity(0.7))
                    if showKey { TextField("", text: Binding(get: { apiKey }, set: { apiKey = $0; edited(resetList: true) }), prompt: prompt) }
                    else { SecureField("", text: Binding(get: { apiKey }, set: { apiKey = $0; edited(resetList: true) }), prompt: prompt) }
                }
                .textFieldStyle(.plain).font(.system(size: 12)).autocorrectionDisabled()
                .accessibilityLabel("API Key").accessibilityIdentifier("API Key")
                Button { showKey.toggle() } label: {
                    Image(systemName: showKey ? "eye.slash" : "eye").font(.system(size: 13)).foregroundStyle(Theme.muted)
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain).help(showKey ? "隐藏 API Key" : "显示 API Key").accessibilityLabel(showKey ? "隐藏 API Key" : "显示 API Key")
            }
            .padding(.leading, 12).padding(.trailing, 6).frame(height: 38)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
            Text("密钥将加密保存；眼睛按钮可查看本次填写的内容。").font(.system(size: 10)).foregroundStyle(Theme.muted)
        }
    }

    private var modelField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("模型").font(.system(size: 12, weight: .medium))
            HStack(spacing: 10) {
                if !models.isEmpty && !manual {
                    Picker("模型", selection: Binding(get: { model }, set: { model = $0; dirty = true; saved = false })) {
                        if !model.isEmpty && !models.contains(model) { Text("\(model)（当前配置）").tag(model) }
                        ForEach(models, id: \.self) { Text($0).tag($0) }
                    }
                    .labelsHidden().pickerStyle(.menu)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 6).frame(height: 38)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
                    .accessibilityIdentifier("模型")
                } else {
                    TextField("", text: edit($model), prompt: Text("选择或填写模型 ID").foregroundStyle(Theme.muted.opacity(0.7)))
                        .textFieldStyle(.plain).font(.system(size: 12)).autocorrectionDisabled()
                        .padding(.horizontal, 12).frame(height: 38)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
                        .accessibilityLabel("模型").accessibilityIdentifier("模型")
                }
                Button(action: loadModels) {
                    Text(loadingModels ? "获取中…" : "获取模型列表").font(.system(size: 12)).foregroundStyle(Theme.foreground)
                        .padding(.horizontal, 14).frame(height: 38)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
                        .opacity(endpoint.trimmingCharacters(in: .whitespaces).isEmpty ? 0.5 : 1)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(endpoint.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if !models.isEmpty {
                Button { manual.toggle() } label: {
                    Text(manual ? "从列表选择" : "手动填写").font(.system(size: 11)).foregroundStyle(Theme.brand).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if !modelNotice.isEmpty { Text(modelNotice).font(.system(size: 10)).foregroundStyle(Theme.muted).accessibilityIdentifier("model-notice") }
            if !modelError.isEmpty { Text(modelError).font(.system(size: 10)).foregroundStyle(Theme.danger).textSelection(.enabled).accessibilityIdentifier("model-error") }
        }
    }

    // MARK: Discovery

    /// Marks the form edited (hides 已保存); changing the connection also drops a fetched list.
    private func edited(resetList: Bool) {
        dirty = true; saved = false
        if resetList { models = []; modelNotice = ""; modelError = "" }
    }

    private func loadModels() {
        guard !loadingModels else { return }
        loadingModels = true; modelError = ""; modelNotice = ""
        let provider = provider, endpoint = endpoint.trimmingCharacters(in: .whitespaces), key = apiKey
        Task {
            defer { loadingModels = false }
            do {
                // An empty key reuses the key saved on Core (same provider and endpoint only).
                let result = try await workspace.listModels(provider: provider, endpoint: endpoint, apiKey: key)
                models = result.models; manual = false
                if model.isEmpty, let first = result.models.first { model = first }
                modelNotice = result.models.isEmpty
                    ? "服务未返回可用模型，可手动填写模型 ID"
                    : "已获取 \(result.models.count) 个模型\(result.hasMore ? "（服务仅返回部分结果，可手动填写其他模型）" : "")"
            } catch { modelError = mbFallbackMessage(error) }
        }
    }

    /// Binding that marks the form edited (hides 已保存).
    private func edit(_ binding: Binding<String>) -> Binding<String> {
        Binding(get: { binding.wrappedValue }, set: { binding.wrappedValue = $0; dirty = true; saved = false })
    }

    private func setProvider(_ next: String) {
        provider = next; apiKey = ""; showKey = false; edited(resetList: true)
        let trimmed = endpoint.trimmingCharacters(in: .whitespaces)
        if trimmed == Self.openAIDefault || trimmed == Self.anthropicDefault {
            endpoint = next == "anthropic" ? Self.anthropicDefault : Self.openAIDefault
        }
    }

    private func load(keepList: Bool = false) {
        provider = config?.providerID ?? "openai"
        model = config?.defaultModel ?? ""
        endpoint = config.map { $0.endpoint.isEmpty ? Self.openAIDefault : $0.endpoint } ?? Self.openAIDefault
        apiKey = ""; showKey = false; dirty = false
        if !keepList { models = []; modelNotice = ""; modelError = ""; manual = false }
    }

    private func save() {
        guard valid, !saving else { return }
        saving = true; error = nil
        Task {
            defer { saving = false }
            do {
                try await workspace.saveModel(provider: provider, model: model.trimmingCharacters(in: .whitespaces),
                                              endpoint: endpoint.trimmingCharacters(in: .whitespaces), apiKey: apiKey)
                apiKey = ""; showKey = false; dirty = false; saved = true
            } catch {
                self.error = mbFallbackMessage(error); saved = false
            }
        }
    }
}

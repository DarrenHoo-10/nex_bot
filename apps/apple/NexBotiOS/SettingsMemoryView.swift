import SwiftUI
import Observation
import NexClientKit

/// Unsaved 记忆服务 form. Held by SettingsView so switching categories keeps the edits.
@MainActor @Observable
final class MemoryForm {
    var enabled: Bool { didSet { feedback = nil; error = nil } }
    var endpoint: String { didSet { feedback = nil; error = nil } }
    var token = "" { didSet { feedback = nil; error = nil } }
    var busy = false
    var feedback: String?
    var error: String?

    init(plugin: MemoryPluginState?) {
        enabled = plugin?.enabled ?? false
        endpoint = plugin?.endpoint ?? ""
    }
}

/// Settings 记忆服务 category content (embedded in SettingsView's scroll view).
struct SettingsMemoryView: View {
    let workspace: WorkspaceStore
    @Bindable var form: MemoryForm

    private var plugin: MemoryPluginState? { workspace.state?.memoryPlugin }
    private var endpointText: String { form.endpoint.trimmingCharacters(in: .whitespaces) }
    /// The saved token can be reused only while the endpoint (without a trailing /) is unchanged.
    private var tokenReusable: Bool {
        guard let plugin, plugin.hasToken else { return false }
        var current = endpointText
        while current.hasSuffix("/") { current.removeLast() }
        return current == plugin.endpoint
    }
    private var canSave: Bool { !form.busy && (!form.enabled || (!endpointText.isEmpty && (!form.token.isEmpty || tokenReusable))) }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            PageHeading(title: "记忆服务", detail: "让助手在后续对话中找回与你有关的信息。")
            if let plugin { content(plugin) }
            else { Text("当前后端未提供记忆服务配置。").font(.footnote).foregroundStyle(Theme.muted) }
        }
        .onDebugUI { cmd, arg in
            switch cmd {
            case "p-enable": form.enabled = arg != "off"
            case "p-endpoint": form.endpoint = arg
            case "p-token": form.token = arg
            case "p-test": Task { await test() }
            case "p-save": Task { await save() }
            default: break
            }
        }
    }

    private func content(_ plugin: MemoryPluginState) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Hindsight").font(.subheadline.weight(.semibold))
                Spacer()
                StatusChip(text: plugin.statusLabel, tone: plugin.status == "ready" ? .good : plugin.status == "unavailable" ? .bad : .neutral)
            }
            if plugin.status == "unavailable" {
                InlineBanner(text: "暂时无法连接记忆服务。聊天仍可使用，请检查服务地址或查看诊断详情。", tone: .warn)
            }
            VStack(alignment: .leading, spacing: 16) {
                Toggle(isOn: $form.enabled) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("启用长期记忆").font(.subheadline.weight(.semibold))
                        Text("将记忆来源同步到配置的服务，供后续检索使用。").font(.caption).foregroundStyle(Theme.muted)
                    }
                }
                FormField(title: "服务地址", hint: "填写后端能够访问的 Hindsight 服务地址。") {
                    TextField("https://memory.example.com", text: $form.endpoint)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                FormField(title: "访问令牌") {
                    SecureField(plugin.hasToken ? "地址不变时，留空保留已有令牌" : "输入服务访问令牌", text: $form.token).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Text("模型调用与费用由该服务管理。停用不会删除外部数据。").font(.caption).foregroundStyle(Theme.muted)
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 0) {
                        FactRow(title: "服务协议", value: plugin.protocolName.isEmpty ? "—" : plugin.protocolName)
                        Divider().overlay(Theme.border)
                        FactRow(title: "连接状态", value: plugin.statusLabel)
                        if let error = plugin.error {
                            Divider().overlay(Theme.border)
                            FactRow(title: "错误详情", value: error)
                        }
                        Text("模型与认证在外部 Hindsight 服务配置；修改本页配置后需重启后端服务。").font(.caption).foregroundStyle(Theme.muted).padding(.top, 8)
                    }
                    .padding(.top, 4)
                } label: { Text("诊断详情").font(.subheadline.weight(.semibold)) }
                if let error = form.error { InlineBanner(text: error) }
                if let feedback = feedback(plugin) { InlineBanner(text: feedback, tone: .good) }
                HStack(spacing: 10) {
                    PrimaryButton(title: form.busy ? "处理中…" : "保存插件配置", busy: form.busy, brand: true) { Task { await save() } }.disabled(!canSave)
                    Button("测试连接") { Task { await test() } }.buttonStyle(PillButtonStyle()).disabled(endpointText.isEmpty || form.busy)
                }
            }
            .padding(14).cardStyle()
        }
    }

    private func feedback(_ plugin: MemoryPluginState) -> String? {
        form.feedback ?? (plugin.restartRequired ? "配置已变更，重启后端服务后生效。" : nil)
    }

    private func save() async {
        guard canSave else { return }
        form.busy = true; form.error = nil
        defer { form.busy = false }
        do {
            _ = try await workspace.saveMemoryPlugin(enabled: form.enabled, endpoint: endpointText, token: form.token)
            form.token = ""; form.feedback = "配置已加密保存，重启后端服务后生效。"
        } catch { form.error = coreMessage(error) }
    }

    private func test() async {
        guard !endpointText.isEmpty else { return }
        form.busy = true; form.error = nil
        defer { form.busy = false }
        do {
            _ = try await workspace.testMemoryPlugin(endpoint: endpointText, token: form.token)
            form.feedback = "连接测试通过，尚未更改配置。"
        } catch { form.error = coreMessage(error) }
    }
}

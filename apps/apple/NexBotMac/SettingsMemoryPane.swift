import SwiftUI
import NexClientKit

/// Settings 记忆服务 category: the Hindsight memory plugin (web `MemorySettings`).
struct SettingsMemoryPane: View {
    let workspace: WorkspaceStore

    @State private var enabled = false
    @State private var endpoint = ""
    @State private var token = ""
    @State private var feedback: (text: String, isError: Bool)?
    @State private var busy = false
    @State private var diagnosticsOpen = false
    @State private var loaded = false

    private var plugin: MemoryPluginState? { workspace.state?.memoryPlugin }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            paneHeader("记忆服务", "让助手在后续对话中找回与你有关的信息。")
            if let plugin { form(plugin) }
            else { Text("当前后端未提供记忆服务配置。").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.top, 24) }
        }
        .onAppear(perform: load)
        .onChange(of: "\(plugin?.enabled ?? false)|\(plugin?.endpoint ?? "")") { if !loaded { load() } }
        #if DEBUG
        .task { MBDebug.start() }
        .onReceive(NotificationCenter.default.publisher(for: .mbDebug)) { note in
            guard let cmd = note.mbCommand, cmd.prefix == "mm", let plugin else { return }
            switch cmd.verb {
            case "fill":
                let p = cmd.arg.components(separatedBy: "|")
                if p.count > 0 { endpoint = p[0] }; if p.count > 1 { token = p[1] }; feedback = nil
            case "enable": enabled = true; feedback = nil
            case "disable": enabled = false; feedback = nil
            case "diag": diagnosticsOpen = true
            case "test": test(plugin)
            case "save": save(plugin)
            default: break
            }
        }
        #endif
    }

    private func form(_ plugin: MemoryPluginState) -> some View {
        let trimmed = endpoint.trimmingCharacters(in: .whitespaces)
        let sameEndpoint = plugin.hasToken && trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == plugin.endpoint
        let tokenRequired = enabled && !sameEndpoint
        let canSave = !enabled || (!trimmed.isEmpty && (!tokenRequired || !token.isEmpty))
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Hindsight").font(.system(size: 13, weight: .semibold))
                Spacer()
                MBChip(text: plugin.statusLabel, tone: plugin.status == "ready" ? .success : plugin.status == "unavailable" ? .danger : .muted)
            }
            .padding(.top, 24)
            if plugin.status == "unavailable" {
                Text("暂时无法连接记忆服务。聊天仍可使用，请检查服务地址或查看诊断详情。").font(.system(size: 12)).foregroundStyle(Theme.danger).padding(.top, 14)
            }
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("启用长期记忆").font(.system(size: 12, weight: .medium))
                    Text("将记忆来源同步到配置的服务，供后续检索使用。").font(.system(size: 10)).foregroundStyle(Theme.muted)
                }
                Spacer()
                Toggle("启用长期记忆", isOn: Binding(get: { enabled }, set: { enabled = $0; feedback = nil }))
                    .labelsHidden().toggleStyle(.switch).controlSize(.small)
            }
            .padding(.top, 18)
            VStack(alignment: .leading, spacing: 20) {
                MBInput(label: "服务地址", text: Binding(get: { endpoint }, set: { endpoint = $0; feedback = nil }),
                        placeholder: "https://memory.example.com", hint: "填写后端能够访问的 Hindsight 服务地址。")
                MBInput(label: "访问令牌", text: Binding(get: { token }, set: { token = $0; feedback = nil }),
                        placeholder: plugin.hasToken ? "地址不变时，留空保留已有令牌" : "输入服务访问令牌", secure: true)
            }
            .padding(.top, 22)
            Text("模型调用与费用由该服务管理。停用不会删除外部数据。").font(.system(size: 11)).foregroundStyle(Theme.muted).padding(.top, 22).padding(.bottom, 22)
            Hairline()
            MBDisclosure(title: "诊断详情", open: $diagnosticsOpen) {
                VStack(alignment: .leading, spacing: 12) {
                    infoRow("服务协议", plugin.protocolName)
                    infoRow("连接状态", plugin.statusLabel)
                    if let error = plugin.error { infoRow("错误详情", error) }
                    Text("模型与认证在外部 Hindsight 服务配置；修改本页配置后需重启后端服务。").font(.system(size: 10)).foregroundStyle(Theme.muted)
                }
            }
            .padding(.vertical, 18)
            HStack(spacing: 10) {
                MBButton(title: busy ? "处理中…" : "保存插件配置", kind: .brand, busy: busy, enabled: canSave) { save(plugin) }
                MBButton(title: "测试连接", enabled: !trimmed.isEmpty && !busy) { test(plugin) }
            }
            if let line = feedbackLine(plugin) {
                Text(line.text).font(.system(size: 11)).foregroundStyle(line.isError ? Theme.danger : Theme.muted)
                    .textSelection(.enabled).padding(.top, 12).accessibilityAddTraits(.updatesFrequently)
            }
        }
    }

    private func feedbackLine(_ plugin: MemoryPluginState) -> (text: String, isError: Bool)? {
        if let feedback { return feedback }
        return plugin.restartRequired ? ("配置已变更，重启后端服务后生效。", false) : nil
    }

    private func load() {
        guard let plugin else { return }
        enabled = plugin.enabled; endpoint = plugin.endpoint; token = ""; loaded = true
    }

    private func save(_ plugin: MemoryPluginState) {
        busy = true; feedback = nil
        Task {
            defer { busy = false }
            do {
                let next = try await workspace.saveMemoryPlugin(enabled: enabled, endpoint: endpoint.trimmingCharacters(in: .whitespaces), token: token)
                enabled = next.enabled; endpoint = next.endpoint; token = ""
                feedback = ("配置已加密保存，重启后端服务后生效。", false)
            } catch { feedback = (mbFallbackMessage(error), true) }
        }
    }

    private func test(_ plugin: MemoryPluginState) {
        busy = true; feedback = nil
        Task {
            defer { busy = false }
            do {
                _ = try await workspace.testMemoryPlugin(endpoint: endpoint.trimmingCharacters(in: .whitespaces), token: token)
                feedback = ("连接测试通过，尚未更改配置。", false)
            } catch { feedback = (mbFallbackMessage(error), true) }
        }
    }
}

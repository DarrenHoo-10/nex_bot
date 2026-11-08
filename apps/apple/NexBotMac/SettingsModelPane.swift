import SwiftUI
import NexClientKit

/// Settings 模型 category (web `ProviderSettings`): providers ("供应商") on the left, the chosen one on the right with
/// its name, base URL, API format, key, 启用 and models. Each model has 启用, image input, limits and reasoning levels.
struct SettingsModelPane: View {
    let workspace: WorkspaceStore
    /// The 模型 category is showing (a provider's model list loads on first show).
    var active = true
    @State private var selected = ""

    private var connections: [ModelConnection] { workspace.state?.connections ?? [] }
    private var connection: ModelConnection? { connections.first { $0.id == selected } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            paneHeader("模型")
            HStack(alignment: .top, spacing: 0) {
                providerList.frame(width: 196)
                Hairline(vertical: true)
                VStack(alignment: .leading, spacing: 0) {
                    if let connection {
                        ProviderForm(workspace: workspace, connection: connection, onCreated: { _ in }).id("form-\(connection.id)-\(connection.version)")
                        if connection.configured { ProviderModels(workspace: workspace, connection: connection, active: active).id("models-\(connection.id)") }
                    } else {
                        ProviderForm(workspace: workspace, connection: nil, onCreated: { selected = $0 }).id("form-new")
                    }
                }
                .padding(20).frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border))
            .padding(.top, 20)
            if workspace.state?.config != nil {
                Hairline().padding(.vertical, 28)
                ImageModelSection(workspace: workspace, active: active).id("\(workspace.state?.config?.providerID ?? "")|\(workspace.state?.config?.endpoint ?? "")")
            }
            Hairline().padding(.vertical, 28)
            RetrievalSection(workspace: workspace, active: active)
        }
        .onAppear { if connection == nil { selected = connections.first?.id ?? "new" } }
        .onChange(of: connections.map(\.id)) { if selected != "new" && connection == nil { selected = connections.first?.id ?? "new" } }
    }

    private var providerList: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(connections) { item in
                Button { selected = item.id } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "shippingbox").font(.system(size: 12)).foregroundStyle(Theme.muted)
                        Text(item.name).font(.system(size: 12.5, weight: .medium)).lineLimit(1).truncationMode(.tail)
                        if item.isDefault { Text("默认").font(.system(size: 9.5)).foregroundStyle(Theme.brand).padding(.horizontal, 5).padding(.vertical, 1).background(Theme.brandSoft, in: RoundedRectangle(cornerRadius: 4)) }
                        Spacer(minLength: 4)
                        Circle().fill(item.usable ? Theme.success : Theme.offline.opacity(0.5)).frame(width: 7, height: 7)
                    }
                    .padding(.horizontal, 10).frame(height: 36)
                    .background(selected == item.id ? Theme.background : Color.clear, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(selected == item.id ? Theme.border : Color.clear))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel(item.name).accessibilityAddTraits(selected == item.id ? .isSelected : [])
            }
            Button { selected = "new" } label: {
                HStack(spacing: 6) { Image(systemName: "plus").font(.system(size: 11)); Text("添加供应商").font(.system(size: 12)) }
                    .foregroundStyle(Theme.muted).frame(maxWidth: .infinity).frame(height: 34)
                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Theme.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).padding(.top, 6)
            Spacer(minLength: 0)
        }
        .padding(10).frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.wash)
    }
}

/// Name, API format, base URL and key; for a saved provider also 启用, 设为默认 and 删除.
private struct ProviderForm: View {
    let workspace: WorkspaceStore
    let connection: ModelConnection?
    let onCreated: (String) -> Void
    @State private var name = ""
    @State private var provider = "openai"
    @State private var endpoint = ""
    @State private var apiKey = ""
    @State private var showKey = false
    @State private var saving = false
    @State private var saved = false
    @State private var error: String?
    @State private var confirmRemove = false

    private var changed: Bool {
        guard let connection else { return true }
        return name != connection.name || provider != connection.provider || endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) != connection.endpoint || !apiKey.isEmpty
    }
    private var valid: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty && !endpoint.trimmingCharacters(in: .whitespaces).isEmpty && (connection?.configured == true || !apiKey.isEmpty) }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 10) {
                Image(systemName: "shippingbox").font(.system(size: 16))
                Text(connection?.name ?? "添加供应商").font(.system(size: 16, weight: .semibold)).lineLimit(1)
                Spacer()
                if let connection {
                    Toggle("", isOn: Binding(get: { connection.enabled }, set: { value in run { try await workspace.updateConnection(connection, enabled: value) } }))
                        .toggleStyle(.switch).labelsHidden().controlSize(.small).disabled(saving || connection.isDefault)
                        .help(connection.isDefault ? "默认供应商不能停用" : "启用供应商").accessibilityLabel("启用供应商")
                    Menu {
                        Button(connection.isDefault ? "已是默认供应商" : "设为默认供应商") { run { try await workspace.setDefaultConnection(id: connection.id) } }.disabled(connection.isDefault)
                        Button("删除供应商", role: .destructive) { confirmRemove = true }.disabled(connection.isDefault)
                    } label: { Image(systemName: "ellipsis").font(.system(size: 13)).foregroundStyle(Theme.muted).frame(width: 28, height: 28) }
                        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().accessibilityLabel("更多操作")
                }
            }
            MBInput(label: "名称", text: edit($name), placeholder: "例如：公司 API", mono: false)
            MBInput(label: "Base URL", text: edit($endpoint), placeholder: "https://api.example.com/v1", mono: false)
            MBSelect(label: "API 格式", selection: edit($provider), options: [("openai", "OpenAI 兼容 (/chat/completions)"), ("anthropic", "Anthropic Messages (/v1/messages)")])
            keyField
            HStack(spacing: 14) {
                MBButton(title: saving ? "保存中…" : connection == nil ? "添加" : "保存", kind: .brand, busy: saving, enabled: valid && changed, action: save)
                if saved { HStack(spacing: 5) { Image(systemName: "checkmark").font(.system(size: 11)); Text("已保存").font(.system(size: 12)) }.foregroundStyle(Theme.muted) }
            }
            if let error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled) }
        }
        .disabled(saving)
        .onAppear { name = connection?.name ?? ""; provider = connection?.provider ?? "openai"; endpoint = connection?.endpoint ?? "" }
        .confirmationDialog("删除供应商「\(connection?.name ?? "")」？", isPresented: $confirmRemove) {
            Button("删除", role: .destructive) { if let connection { run { try await workspace.removeConnection(connection) } } }
        } message: { Text("它的 API Key 会被清除，正在用它的助手会改用默认供应商。") }
    }

    private var keyField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("API Key").font(.system(size: 12, weight: .medium))
            HStack(spacing: 6) {
                Group {
                    let prompt = Text(connection?.configured == true ? "留空保留已保存的 Key" : "输入 API Key").foregroundStyle(Theme.muted.opacity(0.7))
                    if showKey { TextField("", text: edit($apiKey), prompt: prompt) } else { SecureField("", text: edit($apiKey), prompt: prompt) }
                }
                .textFieldStyle(.plain).font(.system(size: 12)).autocorrectionDisabled().accessibilityLabel("API Key")
                Button { showKey.toggle() } label: {
                    Image(systemName: showKey ? "eye.slash" : "eye").font(.system(size: 13)).foregroundStyle(Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel(showKey ? "隐藏 API Key" : "显示 API Key")
            }
            .padding(.leading, 12).padding(.trailing, 6).frame(height: 38)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
        }
    }

    private func edit(_ binding: Binding<String>) -> Binding<String> { Binding(get: { binding.wrappedValue }, set: { binding.wrappedValue = $0; saved = false }) }

    private func run(_ body: @escaping () async throws -> Void) {
        saving = true; error = nil
        Task { defer { saving = false }; do { try await body() } catch { self.error = mbFallbackMessage(error) } }
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
                if connection == nil { onCreated(id) }
            } catch { self.error = mbFallbackMessage(error); saved = false }
        }
    }
}

/// A provider's models: 启用 (全选 / 全不选), 设为默认模型 and each model's settings.
private struct ProviderModels: View {
    let workspace: WorkspaceStore
    let connection: ModelConnection
    var active = true
    @State private var fetched: [String] = []
    @State private var loading = false
    @State private var error = ""
    @State private var notice = ""
    @State private var custom = ""
    @State private var query = ""
    @State private var editing = ""
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
        VStack(alignment: .leading, spacing: 10) {
            Hairline().padding(.vertical, 14)
            HStack {
                Text("模型列表").font(.system(size: 13, weight: .semibold))
                Spacer()
                MBButton(title: loading ? "获取中…" : "获取模型", enabled: !loading) { Task { await load() } }
            }
            HStack(spacing: 8) {
                TextField("", text: $custom, prompt: Text("手动添加模型 ID").foregroundStyle(Theme.muted.opacity(0.7)))
                    .textFieldStyle(.plain).font(.system(size: 12)).padding(.horizontal, 10).frame(height: 32)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
                    .onSubmit(addCustom).accessibilityLabel("添加模型 ID")
                MBButton(title: "添加模型", enabled: !custom.trimmingCharacters(in: .whitespaces).isEmpty, action: addCustom)
            }
            if !error.isEmpty { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled) }
            if let failure = autosave?.error, !failure.isEmpty { Text(failure).font(.system(size: 11)).foregroundStyle(Theme.danger) }
            if !notice.isEmpty { Text(notice).font(.system(size: 10)).foregroundStyle(Theme.muted) }
            HStack(spacing: 10) {
                Text("\(all.count) 个模型 · 已启用 \(enabled.count)\(autosave?.busy == true ? " · 保存中…" : "")").font(.system(size: 11)).foregroundStyle(Theme.muted)
                Spacer()
                if all.count > 12 || !query.isEmpty {
                    TextField("", text: $query, prompt: Text("搜索").foregroundStyle(Theme.muted.opacity(0.7))).textFieldStyle(.roundedBorder).font(.system(size: 11)).frame(width: 120).accessibilityLabel("搜索模型")
                }
                Button("全选") { bulk(true) }.buttonStyle(.plain).font(.system(size: 11.5)).foregroundStyle(Theme.brand).disabled(rows.isEmpty || rows.allSatisfy(enabled.contains))
                Button("全不选") { bulk(false) }.buttonStyle(.plain).font(.system(size: 11.5)).foregroundStyle(Theme.brand).disabled(!rows.contains(where: enabled.contains))
            }
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element) { index, model in
                    if index > 0 { Hairline() }
                    row(model)
                }
                if rows.isEmpty { Text(loading ? "正在获取模型…" : "没有模型，可点「获取模型」或手动添加").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(14).frame(maxWidth: .infinity, alignment: .leading) }
            }
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border))
        }
        .onAppear {
            guard autosave == nil else { return }
            let id = connection.id
            autosave = ModelSelectionAutosave(initial: stored) { [workspace] models, version in try await workspace.saveModelVisibility(connectionID: id, models: models, version: version) }
        }
        .onChange(of: stored) { autosave?.sync(stored) }
        .task(id: active) { if active && !loaded { loaded = true; await load() } }
    }

    @ViewBuilder private func row(_ model: String) -> some View {
        let options = connection.options[model], on = enabled.contains(model), isDefault = model == connection.defaultModel
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(model).font(.system(size: 12, design: .monospaced)).foregroundStyle(on ? Theme.foreground : Theme.muted).lineLimit(1).truncationMode(.middle)
                if isDefault { tag("默认", accent: true) }
                if options?.imageInput == true { tag("视觉") }
                if let levels = options?.reasoning, let first = levels.first { tag("推理 \(first.label)\(levels.count > 1 ? "–\(levels.last!.label)" : "")") }
                Spacer(minLength: 6)
                if !isDefault {
                    Button { Task { try? await workspace.updateConnection(connection, defaultModel: model) } } label: { Image(systemName: "star").font(.system(size: 12)).foregroundStyle(Theme.muted).frame(width: 26, height: 26) }
                        .buttonStyle(.plain).help("设为默认模型").accessibilityLabel("设为默认模型：\(model)")
                }
                Button { editing = editing == model ? "" : model } label: { Image(systemName: "pencil").font(.system(size: 12)).foregroundStyle(Theme.muted).frame(width: 26, height: 26) }
                    .buttonStyle(.plain).help("编辑").accessibilityLabel("编辑 \(model)")
                Toggle("", isOn: Binding(get: { on }, set: { _ in autosave?.toggle(model, all: all) })).toggleStyle(.switch).labelsHidden().controlSize(.mini).accessibilityLabel("启用 \(model)")
            }
            .padding(.leading, 12).padding(.trailing, 8).frame(minHeight: 40)
            if editing == model { ModelOptionsEditor(workspace: workspace, connection: connection, model: model) { editing = "" } }
        }
    }

    private func tag(_ text: String, accent: Bool = false) -> some View {
        Text(text).font(.system(size: 9.5)).foregroundStyle(accent ? Theme.brand : Theme.muted).padding(.horizontal, 5).padding(.vertical, 1)
            .background(accent ? Theme.brandSoft : Color.clear, in: RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(accent ? Color.clear : Theme.border))
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
        do {
            let result = try await workspace.listModels(connectionID: connection.id)
            fetched = result.models; notice = result.hasMore ? "服务仍有未返回的模型，可手动添加。" : ""
        } catch { self.error = mbFallbackMessage(error) }
    }
}

/// One model's settings: context window, output ceiling, image input and the reasoning levels it offers.
private struct ModelOptionsEditor: View {
    let workspace: WorkspaceStore
    let connection: ModelConnection
    let model: String
    let close: () -> Void
    @State private var info: ModelLimitInfo?
    @State private var context = ""
    @State private var output = ""
    @State private var imageInput = false
    @State private var levels: [ReasoningLevel] = []
    @State private var saving = false
    @State private var error = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                limitField("上下文窗口", text: $context, automatic: info?.automatic.contextWindow)
                limitField("最大输出", text: $output, automatic: info?.automatic.maxOutputTokens)
            }
            HStack(spacing: 14) {
                Toggle("支持图片输入", isOn: $imageInput).toggleStyle(.checkbox)
                Text("推理档位").foregroundStyle(Theme.muted)
                ForEach(ReasoningLevel.allCases, id: \.self) { level in
                    Toggle(level.label, isOn: Binding(get: { levels.contains(level) }, set: { on in levels = ReasoningLevel.allCases.filter { $0 == level ? on : levels.contains($0) } })).toggleStyle(.checkbox)
                }
            }
            .font(.system(size: 12))
            if !error.isEmpty { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled) }
            HStack { Spacer(); MBButton(title: "取消", action: close); MBButton(title: saving ? "保存中…" : "保存", kind: .brand, busy: saving, action: save) }
        }
        .padding(12).background(Theme.wash)
        .task {
            let stored = connection.options[model]
            imageInput = stored?.imageInput ?? false; levels = stored?.reasoning ?? []
            guard let result = try? await workspace.modelLimits(provider: connection.provider, endpoint: connection.endpoint, model: model) else { return }
            info = result
            context = result.manual.contextWindow.map(String.init) ?? ""; output = result.manual.maxOutputTokens.map(String.init) ?? ""
            // A model never configured starts from what the catalog says it can do.
            if stored == nil, let capabilities = result.capabilities { imageInput = capabilities.imageInput; if capabilities.reasoning { levels = [.low, .medium, .high] } }
        }
    }

    private func limitField(_ label: String, text: Binding<String>, automatic: Int?) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.system(size: 11)).foregroundStyle(Theme.muted)
            TextField("", text: text, prompt: Text(automatic.map { "自动 · \($0.formatted())" } ?? "自动").foregroundStyle(Theme.muted.opacity(0.7)))
                .textFieldStyle(.plain).font(.system(size: 12)).padding(.horizontal, 10).frame(height: 32)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
                .accessibilityLabel(label)
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
                close()
            } catch { self.error = mbFallbackMessage(error) }
        }
    }
}

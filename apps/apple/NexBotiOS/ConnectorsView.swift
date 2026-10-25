import SwiftUI
import NexClientKit

/// What the connector editor sheet edits: a new connector (optionally prefilled) or an existing one.
struct ConnectorEditorRequest: Identifiable {
    let id = UUID()
    var existing: ConnectorView?
    var name = "", url = "", transport = "http", token = ""
}

/// A connector pushed on the stack, with the notice to show on arrival (e.g. after saving).
struct ConnectorSelection: Hashable {
    let id: String
    var notice: String?
}

/// The 连接器 settings category (embedded in SettingsView's scroll view): header, list with search, and a pushed detail screen.
struct ConnectorsView: View {
    let workspace: WorkspaceStore
    @State private var query = ""
    @State private var editor: ConnectorEditorRequest?
    @State private var selection: ConnectorSelection?
    @State private var showingGmail = false

    private var connectors: [ConnectorView] { (workspace.state?.connectors ?? []).filter { !$0.isGmail && $0.kind != "feishu" } }
    private var filtered: [ConnectorView] {
        let q = query.trimmingCharacters(in: .whitespaces)
        return q.isEmpty ? connectors : connectors.filter { $0.name.localizedCaseInsensitiveContains(q) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            header
            GmailCatalogButton(workspace: workspace, open: { showingGmail = true })
            if workspace.state?.feishu != nil { FeishuSection(workspace: workspace) }
            if !connectors.isEmpty { list }
        }
        .sheet(item: $editor) { request in
            ConnectorEditor(workspace: workspace, request: request) { id in
                selection = ConnectorSelection(id: id, notice: "已保存。点击“测试连接”获取工具目录。")
            }
        }
        .navigationDestination(item: $selection) { item in
            ConnectorDetailView(workspace: workspace, connectorID: item.id, notice: item.notice)
        }
        .navigationDestination(isPresented: $showingGmail) { GmailConnectorView(workspace: workspace) }
        .onDebugUI { cmd, arg in
            switch cmd {
            case "c-add":
                let f = arg.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
                editor = ConnectorEditorRequest(name: f.first ?? "", url: f.count > 1 ? f[1] : "", transport: f.count > 2 && !f[2].isEmpty ? f[2] : "http", token: f.count > 3 ? f[3] : "")
            case "c-open": if let c = connectors.first(where: { $0.name == arg }) { selection = ConnectorSelection(id: c.id) }
            case "c-back": selection = nil
            default: break
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("连接器").font(.title3.weight(.bold))
            Button { editor = ConnectorEditorRequest() } label: {
                Label("添加连接器", systemImage: "plus").font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.white).padding(.horizontal, 16).padding(.vertical, 10)
                    .background(Theme.brand, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain).padding(.top, 8)
        }
    }

    private var empty: some View {
        VStack(spacing: 10) {
            Image(systemName: "powerplug").font(.system(size: 30)).foregroundStyle(Theme.muted)
            Text("把常用工具带进对话").font(.title3.weight(.bold))
            Text("添加 MCP 服务地址，测试连接后，为需要的 Agent 选择工具。").font(.subheadline).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            Button("添加第一个连接器") { editor = ConnectorEditorRequest() }.buttonStyle(PillButtonStyle(primary: true)).padding(.top, 4)
            Text("支持 Streamable HTTP 与 SSE，可使用 Bearer Token 认证。").font(.caption).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
        }
        .padding(24).frame(maxWidth: .infinity).cardStyle()
    }

    private var list: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.muted)
                TextField("搜索连接器", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled()
            }
            .padding(.horizontal, 12).padding(.vertical, 11).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            ForEach(filtered, id: \.id) { connector in
                Button { selection = ConnectorSelection(id: connector.id) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "powerplug").foregroundStyle(Theme.muted).frame(width: 36, height: 36)
                            .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(connector.name).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.foreground).lineLimit(1)
                            Text(connector.subtitle).font(.caption).foregroundStyle(connector.error != nil && connector.enabled ? Theme.danger : Theme.muted)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.footnote).foregroundStyle(Theme.muted)
                    }
                    .padding(12).frame(maxWidth: .infinity).cardStyle()
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// MARK: - Detail

/// One connector: status, metadata, test, enable, tool catalog, per-agent grants and removal.
struct ConnectorDetailView: View {
    let workspace: WorkspaceStore
    let connectorID: String
    @State var notice: String?
    @Environment(\.dismiss) private var dismiss
    @State private var editor: ConnectorEditorRequest?
    @State private var granting: Bot?
    @State private var testing = false
    @State private var toggling = false
    @State private var confirmRemove = false
    @State private var actionError: String?

    private var connector: ConnectorView? { workspace.state?.connectors.first { $0.id == connectorID } }

    init(workspace: WorkspaceStore, connectorID: String, notice: String?) {
        self.workspace = workspace; self.connectorID = connectorID; _notice = State(initialValue: notice)
    }

    var body: some View {
        ScrollView {
            if let connector {
                VStack(alignment: .leading, spacing: 20) {
                    top(connector)
                    metadata(connector)
                    actions(connector)
                    if let notice { InlineBanner(text: notice, tone: .good) }
                    if let message = actionError ?? connector.error { InlineBanner(text: message) }
                    catalog(connector)
                    grants(connector)
                    remove
                }
                .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 32)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(Theme.background)
        .navigationTitle(connector?.name ?? "连接器")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .refreshable { await workspace.refresh() }
        .onChange(of: connector == nil) { _, gone in if gone { dismiss() } }
        .sheet(item: $editor) { request in
            ConnectorEditor(workspace: workspace, request: request) { _ in
                notice = "已保存。点击“测试连接”获取工具目录。"; actionError = nil
            }
        }
        .sheet(item: $granting) { bot in
            if let connector { GrantEditor(workspace: workspace, connector: connector, bot: bot) { notice = "工具授权已更新。"; actionError = nil } }
        }
        .confirmationDialog("移除连接器及全部工具授权？", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("确认移除", role: .destructive) { Task { await removeConnector() } }
            Button("取消", role: .cancel) {}
        }
        .onDebugUI { cmd, arg in
            switch cmd {
            case "c-test": Task { await test() }
            case "c-toggle": Task { await toggle() }
            case "c-edit": if let connector { editor = ConnectorEditorRequest(existing: connector, name: connector.name, url: connector.url, transport: connector.transport) }
            case "c-grant": granting = workspace.bots.first { $0.name == arg }
            case "c-remove": confirmRemove = true
            case "c-removeconfirm": Task { await removeConnector() }
            default: break
            }
        }
    }

    private func top(_ c: ConnectorView) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "powerplug").font(.title3).foregroundStyle(Theme.muted).frame(width: 44, height: 44)
                .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 4) {
                Text(c.name).font(.title3.weight(.bold)).lineLimit(2)
                StatusChip(text: c.statusChip, tone: !c.enabled ? .neutral : c.error != nil ? .bad : c.checkedAt != nil ? .good : .neutral)
            }
            Spacer()
            Button("编辑") { editor = ConnectorEditorRequest(existing: c, name: c.name, url: c.url, transport: c.transport) }
                .font(.subheadline).foregroundStyle(Theme.muted)
        }
    }

    private func metadata(_ c: ConnectorView) -> some View {
        VStack(spacing: 0) {
            FactRow(title: "服务地址", value: c.url)
            Divider().overlay(Theme.border)
            FactRow(title: "认证", value: c.authLabel)
            Divider().overlay(Theme.border)
            FactRow(title: "传输方式", value: c.transportLabel)
        }
        .padding(.horizontal, 14).cardStyle()
    }

    private func actions(_ c: ConnectorView) -> some View {
        HStack(spacing: 10) {
            Button { Task { await test() } } label: {
                HStack(spacing: 6) {
                    if testing { ProgressView().controlSize(.small) } else { Image(systemName: "arrow.triangle.2.circlepath") }
                    Text("测试连接")
                }
            }
            .buttonStyle(PillButtonStyle()).disabled(testing || toggling)
            Button(c.enabled ? "停用" : "启用") { Task { await toggle() } }
                .buttonStyle(PillButtonStyle()).disabled(testing || toggling)
            Spacer()
        }
    }

    private func catalog(_ c: ConnectorView) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("工具目录").font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(c.tools.count)").font(.caption).foregroundStyle(Theme.muted)
            }
            if c.tools.isEmpty {
                Text("测试连接后，工具会显示在这里。").font(.footnote).foregroundStyle(Theme.muted)
            } else {
                VStack(spacing: 0) {
                    ForEach(c.tools, id: \.name) { tool in
                        DisclosureGroup {
                            Text(tool.inputSchemaText).font(.system(.caption, design: .monospaced)).foregroundStyle(Theme.muted)
                                .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled).padding(.vertical, 6)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(tool.name).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.foreground)
                                Text(tool.displayDescription).font(.caption).foregroundStyle(Theme.muted).multilineTextAlignment(.leading)
                            }
                        }
                        .padding(.vertical, 10)
                        if tool.name != c.tools.last?.name { Divider().overlay(Theme.border) }
                    }
                }
                .padding(.horizontal, 14).cardStyle()
            }
        }
    }

    private func grants(_ c: ConnectorView) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Agent 授权").font(.subheadline.weight(.semibold))
            Text("只开放选中的工具。实际调用会在该 Agent 的对话中请求批准。").font(.caption).foregroundStyle(Theme.muted)
            if workspace.bots.isEmpty {
                Text("创建 Agent 后，可以在这里授权。").font(.footnote).foregroundStyle(Theme.muted)
            } else {
                VStack(spacing: 0) {
                    ForEach(workspace.bots, id: \.id) { bot in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(bot.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                                Text("\(c.grant(for: bot.id)?.tools.count ?? 0) 项工具已授权").font(.caption).foregroundStyle(Theme.muted)
                            }
                            Spacer()
                            Button("管理授权") { granting = bot }.buttonStyle(PillButtonStyle()).disabled(c.checkedAt == nil)
                        }
                        .padding(.vertical, 10)
                        if bot.id != workspace.bots.last?.id { Divider().overlay(Theme.border) }
                    }
                }
                .padding(.horizontal, 14).cardStyle()
            }
        }
    }

    private var remove: some View {
        Button("移除连接器") { confirmRemove = true }.buttonStyle(PillButtonStyle(danger: true))
    }

    // MARK: Actions

    private func test() async {
        testing = true; notice = nil; actionError = nil
        defer { testing = false }
        do { _ = try await workspace.testConnector(connectorID); notice = "连接成功，工具目录已更新。" }
        catch { actionError = coreMessage(error) }
    }

    private func toggle() async {
        guard let connector else { return }
        toggling = true; notice = nil; actionError = nil
        defer { toggling = false }
        do { try await workspace.setConnectorEnabled(connectorID, enabled: !connector.enabled) }
        catch { actionError = coreMessage(error); await workspace.refresh() }
    }

    private func removeConnector() async {
        do { try await workspace.removeConnector(connectorID); dismiss() }
        catch { actionError = coreMessage(error); await workspace.refresh() }
    }
}

// MARK: - Grant editor

/// Sheet: choose the connector tools one agent may call.
private struct GrantEditor: View {
    let workspace: WorkspaceStore
    let connector: ConnectorView
    let bot: Bot
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var chosen: Set<String>
    @State private var busy = false
    @State private var errorText: String?

    init(workspace: WorkspaceStore, connector: ConnectorView, bot: Bot, onSaved: @escaping () -> Void) {
        self.workspace = workspace; self.connector = connector; self.bot = bot; self.onSaved = onSaved
        let names = Set(connector.tools.map(\.name))
        _chosen = State(initialValue: Set(connector.grant(for: bot.id)?.tools ?? []).intersection(names))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("为 \(bot.name) 选择工具").font(.title3.weight(.bold))
                    VStack(spacing: 0) {
                        ForEach(connector.tools, id: \.name) { tool in
                            Toggle(isOn: Binding(get: { chosen.contains(tool.name) }, set: { on in if on { chosen.insert(tool.name) } else { chosen.remove(tool.name) } })) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(tool.name).font(.subheadline.weight(.semibold))
                                    Text(tool.displayDescription).font(.caption).foregroundStyle(Theme.muted)
                                }
                            }
                            .padding(.vertical, 10)
                            if tool.name != connector.tools.last?.name { Divider().overlay(Theme.border) }
                        }
                    }
                    .padding(.horizontal, 14).cardStyle()
                    if let errorText { InlineBanner(text: errorText) }
                    PrimaryButton(title: "保存授权", busy: busy) { Task { await save() } }.disabled(busy)
                }
                .padding(16)
            }
            .background(Theme.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
            .onDebugUI { cmd, _ in
                if cmd == "c-grantall" { chosen = Set(connector.tools.map(\.name)) }
                if cmd == "c-grantsave" { Task { await save() } }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func save() async {
        busy = true; errorText = nil
        defer { busy = false }
        do {
            let ordered = connector.tools.map(\.name).filter(chosen.contains)
            try await workspace.grantConnector(connector.id, botID: bot.id, tools: ordered)
            onSaved(); dismiss()
        } catch { errorText = coreMessage(error) }
    }
}

// MARK: - Editor

/// Sheet: add or edit a connector.
private struct ConnectorEditor: View {
    let workspace: WorkspaceStore
    let request: ConnectorEditorRequest
    let onSaved: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var url: String
    @State private var transport: String
    @State private var token: String
    @State private var clearToken = false
    @State private var busy = false
    @State private var errorText: String?

    init(workspace: WorkspaceStore, request: ConnectorEditorRequest, onSaved: @escaping (String) -> Void) {
        self.workspace = workspace; self.request = request; self.onSaved = onSaved
        _name = State(initialValue: request.name); _url = State(initialValue: request.url)
        _transport = State(initialValue: request.transport); _token = State(initialValue: request.token)
    }

    private var editing: ConnectorView? { request.existing }
    private var valid: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty && !url.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    FormField(title: "名称") {
                        TextField("例如：团队知识库", text: $name).onChange(of: name) { _, v in if v.count > 80 { name = String(v.prefix(80)) } }
                    }
                    FormField(title: "MCP 服务地址") {
                        TextField("https://example.com/mcp", text: $url)
                            .keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("传输方式").font(.footnote.weight(.semibold))
                        Picker("传输方式", selection: $transport) {
                            Text("Streamable HTTP").tag("http")
                            Text("SSE").tag("sse")
                        }
                        .pickerStyle(.segmented)
                    }
                    FormField(title: "Bearer Token（选填）") {
                        SecureField(editing?.hasToken == true ? "留空保留原令牌；更换地址时需重新填写" : "服务无需认证时留空", text: $token)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                    if editing?.hasToken == true {
                        Toggle("清除已保存的令牌", isOn: $clearToken).font(.subheadline)
                    }
                    Text("地址由后端 Core 访问。本机地址指后端所在的电脑。").font(.caption).foregroundStyle(Theme.muted)
                    if let errorText { InlineBanner(text: errorText) }
                    PrimaryButton(title: busy ? "保存中…" : "保存连接器", busy: busy) { Task { await save() } }.disabled(!valid || busy)
                }
                .padding(16)
            }
            .background(Theme.background)
            .navigationTitle(editing == nil ? "添加连接器" : "编辑连接器")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(busy) } }
            .onDebugUI { cmd, _ in if cmd == "c-submit" { Task { await save() } } }
        }
        .interactiveDismissDisabled(busy)
    }

    private func save() async {
        guard valid, !busy else { return }
        busy = true; errorText = nil
        defer { busy = false }
        do {
            let id = try await workspace.saveConnector(existing: editing, name: name.trimmingCharacters(in: .whitespaces), url: url.trimmingCharacters(in: .whitespaces), transport: transport, token: token, clearToken: clearToken)
            onSaved(id); dismiss()
        } catch { errorText = coreMessage(error) }
    }
}

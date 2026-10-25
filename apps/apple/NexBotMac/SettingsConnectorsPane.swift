import SwiftUI
import NexClientKit

/// Settings 连接器 category: MCP connectors, their tool catalogs and per-agent grants (web `ConnectorsPage` inside settings).
struct SettingsConnectorsPane: View {
    let workspace: WorkspaceStore

    private struct Feedback { var text: String; var isError = false }
    private struct Editor: Identifiable { var id: String; var existing: ConnectorView? }

    @State private var selectedID: String?
    @State private var search = ""
    @State private var feedback: Feedback?
    @State private var editor: Editor?
    @State private var testing = false
    @State private var busy = false
    @State private var grantBot: String?
    @State private var grantSelection: Set<String> = []
    @State private var confirmingRemove = false
    @State private var scrollTarget: String?
    @State private var openTools: Set<String> = []
    @State private var showingGmail = false

    private var connectors: [ConnectorView] { (workspace.state?.connectors ?? []).filter { !$0.isGmail && $0.kind != "feishu" } }
    private var visible: [ConnectorView] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        return q.isEmpty ? connectors : connectors.filter { $0.name.lowercased().contains(q) }
    }
    private var selected: ConnectorView? { visible.first { $0.id == selectedID } ?? visible.first }

    var body: some View {
        ZStack {
            if showingGmail { GmailConnectorView(workspace: workspace, back: { showingGmail = false }) }
            else {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        header
                        GmailCatalogButton(workspace: workspace, open: { showingGmail = true }).padding(.top, 20)
                        if let feedback { MBBanner(text: feedback.text, isError: feedback.isError).padding(.top, 24) }
                        if workspace.state?.feishu != nil { SettingsFeishuCard(workspace: workspace).padding(.top, 24) }
                        if workspace.state != nil, connectors.isEmpty { emptyState.padding(.top, 28) }
                        else if !connectors.isEmpty { twoPane.padding(.top, 24) }
                        if !connectors.isEmpty { twoPane.padding(.top, 24) }
                    }
                    .padding(.bottom, 34)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                #if DEBUG
                .onChange(of: scrollTarget) { _, id in if let id { proxy.scrollTo(id, anchor: .top) } }
                #endif
            }
            }
            if let editor {
                ConnectorEditor(existing: editor.existing, close: { self.editor = nil }) { name, url, transport, token, clear in
                    let id = try await workspace.saveConnector(existing: editor.existing, name: name, url: url, transport: transport, token: token, clearToken: clear)
                    selectedID = id; search = ""
                    feedback = Feedback(text: "已保存。点击“测试连接”获取工具目录。")
                    self.editor = nil
                }
            }
        }
        .onChange(of: selected?.id) { grantBot = nil; confirmingRemove = false }
        #if DEBUG
        .task { MBDebug.start() }
        .onReceive(NotificationCenter.default.publisher(for: .mbDebug)) { handleDebug($0) }
        #endif
    }

    // MARK: Header and empty state

    private var header: some View {
        paneHeader("连接器", "") {
            MBButton(title: "添加连接器", kind: .brand, icon: "plus") { editor = Editor(id: "new", existing: nil) }
        }
    }

    private var emptyState: some View {
        MBCard(padding: 48) {
            VStack(spacing: 10) {
                Image(systemName: "powerplug").font(.system(size: 22)).foregroundStyle(Theme.muted).padding(.bottom, 6)
                Text("把常用工具带进对话").font(.system(size: 17, weight: .bold))
                Text("添加 MCP 服务地址，测试连接后，为需要的 Agent 选择工具。").font(.system(size: 12)).foregroundStyle(Theme.muted)
                MBButton(title: "添加第一个连接器", kind: .primary) { editor = Editor(id: "new", existing: nil) }.padding(.top, 10)
                Text("支持 Streamable HTTP 与 SSE，可使用 Bearer Token 认证。").font(.system(size: 10)).foregroundStyle(Theme.muted).padding(.top, 4)
            }
            .frame(maxWidth: .infinity)
        }
    }

    // MARK: List and detail

    private var twoPane: some View {
        HStack(alignment: .top, spacing: 0) {
            list.frame(width: 236)
            Theme.border.frame(width: 1)
            Group {
                if let c = selected { detail(c) }
                else { Text("没有匹配的连接器").font(.system(size: 12)).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, minHeight: 200) }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border))
        .frame(minHeight: 520, alignment: .top)
    }

    private var list: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundStyle(Theme.muted)
                TextField("", text: $search, prompt: Text("搜索连接器").foregroundStyle(Theme.muted)).textFieldStyle(.plain).font(.system(size: 12))
                    .accessibilityLabel("搜索连接器")
            }
            .padding(.horizontal, 12).frame(height: 36)
            .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            ForEach(visible) { c in
                let on = c.id == selected?.id
                Button { selectedID = c.id } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "powerplug").font(.system(size: 13)).foregroundStyle(Theme.muted).frame(width: 22)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(c.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                            Text(c.subtitle).font(.system(size: 10)).foregroundStyle(Theme.muted)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.system(size: 10)).foregroundStyle(Theme.muted)
                    }
                    .padding(.horizontal, 14).frame(height: 60)
                    .background(on ? Theme.secondary : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .accessibilityLabel("连接器列表")
    }

    private func detail(_ c: ConnectorView) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "powerplug").font(.system(size: 14)).foregroundStyle(Theme.muted)
                    .frame(width: 38, height: 38).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                VStack(alignment: .leading, spacing: 6) {
                    Text(c.name).font(.system(size: 16, weight: .bold))
                    Text(c.statusChip).font(.system(size: 10, weight: .medium)).foregroundStyle(chipColor(c))
                }
                Spacer()
                Button("编辑") { editor = Editor(id: c.id, existing: c) }.buttonStyle(.plain)
                    .font(.system(size: 11)).foregroundStyle(Theme.muted).padding(.top, 6)
            }
            VStack(alignment: .leading, spacing: 12) {
                MBInfoRow(label: "服务地址", value: c.url, mono: true)
                MBInfoRow(label: "认证", value: c.authLabel)
                MBInfoRow(label: "传输方式", value: c.transportLabel)
            }
            .padding(.top, 22)
            HStack(spacing: 8) {
                MBButton(title: "测试连接", icon: "arrow.triangle.2.circlepath", busy: testing) { test(c) }
                MBButton(title: c.enabled ? "停用" : "启用", enabled: !testing) {
                    perform(nil) { try await workspace.setConnectorEnabled(c.id, enabled: !c.enabled) }
                }
            }
            .padding(.top, 20)
            if let error = c.error {
                Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled)
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .padding(.top, 14)
            }
            catalog(c).padding(.top, 28)
            grants(c).padding(.top, 28).id("grants")
            Hairline().padding(.top, 28)
            removal(c).padding(.top, 18).id("remove")
        }
        .padding(24)
        .accessibilityLabel("连接器详情")
    }

    private func chipColor(_ c: ConnectorView) -> Color {
        c.error != nil && c.enabled ? Theme.danger : c.enabled && c.checkedAt != nil ? Theme.success : Theme.muted
    }

    private func catalog(_ c: ConnectorView) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("工具目录").font(.system(size: 12, weight: .bold))
                Spacer()
                Text("\(c.tools.count)").font(.system(size: 10)).foregroundStyle(Theme.muted)
            }
            .padding(.bottom, 12)
            Hairline()
            if c.tools.isEmpty {
                Text("测试连接后，工具会显示在这里。").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.top, 14)
            }
            ForEach(c.tools) { tool in
                let key = c.id + "/" + tool.name
                let open = openTools.contains(key)
                VStack(alignment: .leading, spacing: 0) {
                    Button { if open { openTools.remove(key) } else { openTools.insert(key) } } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(tool.name).font(.system(size: 11, weight: .semibold))
                                Text(tool.displayDescription).font(.system(size: 11)).foregroundStyle(Theme.muted).multilineTextAlignment(.leading)
                            }
                            Spacer()
                            Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 10, weight: .semibold))
                        }
                        .padding(.vertical, 16).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if open {
                        Text(tool.inputSchemaText.isEmpty ? "{}" : tool.inputSchemaText)
                            .font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .padding(.bottom, 14)
                    }
                    Hairline()
                }
            }
        }
    }

    private func grants(_ c: ConnectorView) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Agent 授权").font(.system(size: 12, weight: .bold))
                Spacer()
                Image(systemName: "checkmark.shield").font(.system(size: 12)).foregroundStyle(Theme.muted)
            }
            Text("只开放选中的工具。实际调用会在该 Agent 的对话中请求批准。").font(.system(size: 11)).foregroundStyle(Theme.muted).padding(.top, 12)
            if workspace.bots.isEmpty {
                Text("创建 Agent 后，可以在这里授权。").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.top, 14)
            }
            ForEach(workspace.bots) { bot in
                HStack {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(bot.name).font(.system(size: 12, weight: .semibold))
                        Text("\(c.grant(for: bot.id)?.tools.count ?? 0) 项工具已授权").font(.system(size: 10)).foregroundStyle(Theme.muted)
                    }
                    Spacer()
                    MBButton(title: "管理授权", enabled: c.checkedAt != nil) {
                        grantBot = bot.id
                        grantSelection = Set(c.grant(for: bot.id)?.tools ?? [])
                    }
                }
                .padding(.vertical, 14)
                .overlay(alignment: .bottom) { Hairline() }
            }
            if let id = grantBot, let bot = workspace.bot(id) { grantEditor(c, bot) }
        }
    }

    private func grantEditor(_ c: ConnectorView, _ bot: Bot) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("为 \(bot.name) 选择工具").font(.system(size: 12, weight: .bold))
            ForEach(c.tools) { tool in
                Toggle(isOn: Binding(get: { grantSelection.contains(tool.name) },
                                     set: { if $0 { grantSelection.insert(tool.name) } else { grantSelection.remove(tool.name) } })) {
                    Text(tool.name).font(.system(size: 12))
                }
                .toggleStyle(.checkbox)
            }
            HStack(spacing: 8) {
                MBButton(title: "保存授权", kind: .primary, busy: busy) {
                    let names = c.tools.map(\.name).filter(grantSelection.contains)
                    perform("工具授权已更新。") { try await workspace.grantConnector(c.id, botID: bot.id, tools: names); grantBot = nil }
                }
                MBButton(title: "取消") { grantBot = nil }
            }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.top, 14)
    }

    @ViewBuilder private func removal(_ c: ConnectorView) -> some View {
        if confirmingRemove {
            VStack(alignment: .leading, spacing: 12) {
                Text("移除连接器及全部工具授权？").font(.system(size: 12, weight: .semibold))
                HStack(spacing: 8) {
                    MBButton(title: "确认移除", kind: .danger, busy: busy) {
                        perform(nil) { try await workspace.removeConnector(c.id); confirmingRemove = false; selectedID = nil }
                    }
                    MBButton(title: "取消") { confirmingRemove = false }
                }
            }
        } else {
            Button { confirmingRemove = true } label: {
                HStack(spacing: 6) { Image(systemName: "trash").font(.system(size: 11)); Text("移除连接器").font(.system(size: 12)) }
                    .foregroundStyle(Theme.danger).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: Actions

    private func test(_ c: ConnectorView) {
        testing = true
        Task {
            defer { testing = false }
            do { _ = try await workspace.testConnector(c.id); feedback = Feedback(text: "连接成功，工具目录已更新。") }
            catch { feedback = Feedback(text: mbFallbackMessage(error), isError: true) }
        }
    }

    /// Runs a mutation; on failure shows Core's text and reloads the state.
    private func perform(_ success: String?, _ work: @escaping () async throws -> Void) {
        busy = true
        Task {
            defer { busy = false }
            do { try await work(); feedback = success.map { Feedback(text: $0) } }
            catch { feedback = Feedback(text: mbFallbackMessage(error), isError: true); await workspace.refresh() }
        }
    }

    #if DEBUG
    private func handleDebug(_ note: Notification) {
        guard let cmd = note.mbCommand, cmd.prefix == "cx" else { return }
        switch cmd.verb {
        case "scroll": scrollTarget = nil; DispatchQueue.main.async { scrollTarget = cmd.arg }
        case "add": editor = Editor(id: "new", existing: nil)
        case "edit": if let c = selected { editor = Editor(id: c.id, existing: c) }
        case "search": search = cmd.arg
        case "test": if let c = selected { test(c) }
        case "toggle": if let c = selected { perform(nil) { try await workspace.setConnectorEnabled(c.id, enabled: !c.enabled) } }
        case "expand": if let c = selected { openTools.insert(c.id + "/" + cmd.arg) }
        case "grant":
            if let c = selected, let bot = workspace.bots.first(where: { $0.name == cmd.arg }) {
                grantBot = bot.id; grantSelection = Set(c.grant(for: bot.id)?.tools ?? [])
            }
        case "check": if grantSelection.contains(cmd.arg) { grantSelection.remove(cmd.arg) } else { grantSelection.insert(cmd.arg) }
        case "savegrant":
            if let c = selected, let id = grantBot {
                let names = c.tools.map(\.name).filter(grantSelection.contains)
                perform("工具授权已更新。") { try await workspace.grantConnector(c.id, botID: id, tools: names); grantBot = nil }
            }
        case "confirmremove": confirmingRemove = true
        case "remove": if let c = selected { perform(nil) { try await workspace.removeConnector(c.id); confirmingRemove = false; selectedID = nil } }
        default: break
        }
    }
    #endif
}

/// The 添加连接器 / 编辑连接器 modal.
private struct ConnectorEditor: View {
    let existing: ConnectorView?
    let close: () -> Void
    let save: (_ name: String, _ url: String, _ transport: String, _ token: String, _ clearToken: Bool) async throws -> Void

    @State private var name: String
    @State private var url: String
    @State private var transport: String
    @State private var token = ""
    @State private var clearToken = false
    @State private var busy = false
    @State private var error: String?

    init(existing: ConnectorView?, close: @escaping () -> Void,
         save: @escaping (String, String, String, String, Bool) async throws -> Void) {
        self.existing = existing; self.close = close; self.save = save
        _name = State(initialValue: existing?.name ?? "")
        _url = State(initialValue: existing?.url ?? "")
        _transport = State(initialValue: existing?.transport ?? "http")
    }

    private var valid: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty && !url.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        MBModal(title: existing == nil ? "添加连接器" : "编辑连接器", closeLabel: "关闭连接器编辑", canClose: !busy, close: close) {
            VStack(alignment: .leading, spacing: 16) {
                MBInput(label: "名称", text: $name, placeholder: "例如：团队知识库")
                MBInput(label: "MCP 服务地址", text: $url, placeholder: "https://example.com/mcp", mono: true)
                MBSelect(label: "传输方式", selection: $transport, options: [("http", "Streamable HTTP"), ("sse", "SSE")])
                MBInput(label: "Bearer Token（选填）", text: $token,
                        placeholder: existing?.hasToken == true ? "留空保留原令牌；更换地址时需重新填写" : "服务无需认证时留空", secure: true)
                if existing?.hasToken == true {
                    Toggle("清除已保存的令牌", isOn: $clearToken).toggleStyle(.checkbox).font(.system(size: 12))
                }
                Text("地址由后端 Core 访问。本机地址指后端所在的电脑。").font(.system(size: 10)).foregroundStyle(Theme.muted)
                if let error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled) }
                HStack(spacing: 8) {
                    MBButton(title: busy ? "保存中…" : "保存连接器", kind: .primary, busy: busy, enabled: valid, action: submit)
                    MBButton(title: "取消", enabled: !busy, action: close)
                }
            }
        }
        #if DEBUG
        .onReceive(NotificationCenter.default.publisher(for: .mbDebug)) { note in
            guard let cmd = note.mbCommand, cmd.prefix == "cx" else { return }
            switch cmd.verb {
            case "fill":
                let p = cmd.arg.components(separatedBy: "|")
                if p.count > 0 { name = p[0] }; if p.count > 1 { url = p[1] }; if p.count > 2 { token = p[2] }
                if p.count > 3 { transport = p[3] }
            case "submit": submit()
            case "cleartoken": clearToken = true
            default: break
            }
        }
        #endif
    }

    private func submit() {
        guard valid, !busy else { return }
        busy = true; error = nil
        Task {
            defer { busy = false }
            do { try await save(name.trimmingCharacters(in: .whitespaces), url.trimmingCharacters(in: .whitespaces), transport, token, clearToken) }
            catch { self.error = mbFallbackMessage(error) }
        }
    }
}

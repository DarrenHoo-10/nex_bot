import SwiftUI
import NexClientKit

struct GithubMark: View {
    var size: CGFloat = 60
    var body: some View {
        Image(systemName: "chevron.left.forwardslash.chevron.left").font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(.white).frame(width: size, height: size)
            .background(Color(white: 0.12), in: RoundedRectangle(cornerRadius: size * 0.25))
            .overlay(RoundedRectangle(cornerRadius: size * 0.25).strokeBorder(Theme.border)).accessibilityHidden(true)
    }
}

/// The catalog row. Connect uses the device flow (no server configuration needed); the row
/// itself still opens the details. Leaving the catalog cancels a pending attempt.
@MainActor
struct GithubCatalogButton: View {
    let workspace: WorkspaceStore
    let open: () -> Void
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var authorization: ConnectorAuthorization

    init(workspace: WorkspaceStore, open: @escaping () -> Void) {
        #if DEBUG
        self.init(workspace: workspace, open: open, authorization: ConnectorAuthorization(workspace: workspace, provider: "github", allowLoopbackFixture: true))
        #else
        self.init(workspace: workspace, open: open, authorization: ConnectorAuthorization(workspace: workspace, provider: "github"))
        #endif
    }
    /// Lets render fixtures start from an attempt that is already in flight.
    init(workspace: WorkspaceStore, open: @escaping () -> Void, authorization: ConnectorAuthorization) {
        self.workspace = workspace; self.open = open
        _authorization = State(initialValue: authorization)
    }
    private var added: Bool { workspace.state?.connectors.contains { $0.isGithub } == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Button(action: open) {
                    HStack(spacing: 16) {
                        GithubMark(size: 54)
                        VStack(alignment: .leading, spacing: 5) {
                            Text("GitHub").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.foreground)
                            Text("仓库、PR、CI 与 issue。").font(.system(size: 13)).foregroundStyle(Theme.muted)
                        }
                        Spacer(minLength: 8)
                        if added {
                            Image(systemName: "checkmark").foregroundStyle(Theme.success)
                            Text("已添加").font(.system(size: 12)).foregroundStyle(Theme.muted)
                        } else { Image(systemName: "chevron.right").foregroundStyle(Theme.muted) }
                    }
                    .padding(.vertical, 16).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityIdentifier("github-catalog")
            }
            if authorization.attempt != nil { status }
        }
        .task(id: "\(authorization.attempt?.id ?? "")-\(scenePhase == .active)") {
            if scenePhase == .active { await authorization.waitForCompletion() }
        }
        .onDisappear { authorization.cancel() }
    }

    private func launch(_ url: URL) { openURL(url) { accepted in if !accepted { authorization.failedToOpenBrowser() } } }

    @ViewBuilder private var status: some View {
        if let url = authorization.authorizationURL {
            let waiting = HStack(spacing: 8) { ProgressView().controlSize(.small); Text("等待 GitHub 授权").lineLimit(1).fixedSize() }
            let actions = HStack(spacing: 14) {
                Button("继续授权") { launch(url) }
                Button("取消连接") { authorization.cancel() }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 14) { waiting; Spacer(minLength: 8); actions }
                VStack(alignment: .leading, spacing: 8) { waiting; actions }
            }
            .font(.system(size: 13)).buttonStyle(.borderless).padding(.leading, 70).padding(.bottom, 12)
            .accessibilityIdentifier("github-catalog-authorizing")
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 14) {
                    HStack(spacing: 8) { ProgressView().controlSize(.small); Text("等待 GitHub 授权").lineLimit(1).fixedSize() }
                    Button("取消连接") { authorization.cancel() }
                }
                if let code = authorization.userCode {
                    Text("在打开的页面输入 \(code)").font(.system(size: 13, design: .monospaced)).textSelection(.enabled)
                }
            }
            .font(.system(size: 13)).buttonStyle(.borderless).padding(.leading, 70).padding(.bottom, 12)
            .accessibilityIdentifier("github-catalog-authorizing")
        }
    }
}

/// Shared native page: every GitHub connection's tools are available to every assistant.
@MainActor
struct GithubConnectorView: View {
    let workspace: WorkspaceStore
    var back: (() -> Void)?
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var authorization: ConnectorAuthorization
    @State private var removing: String?
    @State private var busy = false
    @State private var toolsOpen = false
    @State private var feedback: String?
    @State private var failed = false
    @State private var token = ""
    @State private var monitorEditor: ConnectorMonitor?
    @State private var addingMonitor = false
    @State private var webhookNote: String?

    init(workspace: WorkspaceStore, back: (() -> Void)? = nil) {
        self.workspace = workspace; self.back = back
        #if DEBUG
        _authorization = State(initialValue: ConnectorAuthorization(workspace: workspace, provider: "github", allowLoopbackFixture: true))
        #else
        _authorization = State(initialValue: ConnectorAuthorization(workspace: workspace, provider: "github"))
        #endif
    }
    private var accounts: [ConnectorView] { workspace.state?.connectors.filter(\.isGithub) ?? [] }
    private var locked: Bool { busy || authorization.busy }
    private var names: [String] { accounts.first?.tools.map(\.name) ?? GithubTools.names }
    private var usable: Set<String> { Set(accounts.filter(\.isReady).flatMap { $0.tools.map(\.name) }) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                if let back { Button(action: back) { Label("连接器", systemImage: "chevron.left") }.buttonStyle(.plain).foregroundStyle(Theme.muted) }
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 18) {
                        GithubMark(size: 68)
                        VStack(alignment: .leading, spacing: 5) {
                            Text("GitHub").font(.system(size: 26, weight: .semibold))
                            Text("github.com").font(.system(size: 13)).foregroundStyle(Theme.muted)
                        }
                    }
                    Text("仓库、PR、CI 与 issue。").font(.system(size: 15)).foregroundStyle(Theme.muted)
                }
                if let message = authorization.error ?? feedback {
                    Text(message).font(.system(size: 13)).foregroundStyle(authorization.error != nil || failed ? Theme.danger : Theme.muted)
                        .accessibilityIdentifier("github-feedback")
                }
                section("账户") {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(accounts) { account in
                            if account.id != accounts.first?.id { Divider().overlay(Theme.border) }
                            accountRow(account).padding(20)
                        }
                        authorizationControls.padding(20).padding(.top, accounts.isEmpty ? 0 : -12)
                    }.githubSurface()
                }
                section("工具") {
                    DisclosureGroup(isExpanded: $toolsOpen) {
                        VStack(spacing: 0) {
                            ForEach(names, id: \.self) { name in
                                Divider().overlay(Theme.border)
                                HStack {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(GithubTools.label(name)).font(.system(size: 14))
                                        Text(GithubTools.detail(name)).font(.system(size: 12)).foregroundStyle(Theme.muted)
                                    }
                                    Spacer(minLength: 8)
                                    if usable.contains(name) { Image(systemName: "checkmark").foregroundStyle(Theme.success) }
                                }.padding(.vertical, 14)
                            }
                        }.padding(.top, 10)
                    } label: {
                        Text(accounts.isEmpty ? "\(names.count) 个工具" : "可用 \(usable.count)/\(names.count) 个").font(.system(size: 14))
                    }.tint(Theme.muted).padding(20).githubSurface().accessibilityIdentifier("github-tools")
                }
                section("监视") {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(workspace.githubMonitors, id: \.id) { monitor in
                            if monitor.id != workspace.githubMonitors.first?.id { Divider().overlay(Theme.border) }
                            monitorRow(monitor).padding(20)
                        }
                        Button { addingMonitor = true } label: {
                            HStack(spacing: 8) { Image(systemName: "plus"); Text("添加监视") }.font(.system(size: 14))
                        }.buttonStyle(.borderless).foregroundStyle(workspace.githubMonitors.isEmpty ? Theme.brand : Theme.muted).padding(20)
                    }.githubSurface()
                }
            }.foregroundStyle(Theme.foreground).padding(.bottom, 28)
            #if os(iOS)
            .padding(.horizontal, 20).padding(.top, 20)
            #endif
        }
        .navigationTitle("GitHub")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .background(Theme.background)
        .task(id: "\(authorization.attempt?.id ?? "")-\(scenePhase == .active)") {
            if scenePhase == .active { await authorization.waitForCompletion() }
        }
        .onDisappear { authorization.cancel() }
        .onChange(of: authorization.connectedID) { _, id in if id != nil { failed = false; feedback = "GitHub 已连接" } }
        .sheet(isPresented: Binding(get: { monitorEditor != nil || addingMonitor }, set: { if !$0 { monitorEditor = nil; addingMonitor = false } })) {
            GithubMonitorEditor(workspace: workspace, connectorId: firstConnectorID, existing: monitorEditor) { saved in
                if let secret = saved.webhookSecret { webhookNote = "地址：\(saved.webhookPath ?? "")\n密钥（仅显示一次）：\(secret)" }
                feedback = "监视已保存"; failed = false
            }
        }
        .alert("Webhook 配置", isPresented: Binding(get: { webhookNote != nil }, set: { if !$0 { webhookNote = nil } })) {
            Button("知道了", role: .cancel) {}
        } message: { Text(webhookNote ?? "") }
        .confirmationDialog("断开此连接？", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            if let id = removing { Button("确认断开", role: .destructive) { perform { try await workspace.disconnectGmail(id) } } }
            Button("取消", role: .cancel) { removing = nil }
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.system(size: 13)).foregroundStyle(Theme.muted).padding(.leading, 18)
            content()
        }
    }
    private func accountRow(_ account: ConnectorView) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(account.account ?? "令牌连接").font(.system(size: 14)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Text(account.statusChip).font(.system(size: 12)).foregroundStyle(account.isReady ? Theme.success : Theme.muted).fixedSize()
                Menu {
                    Button("测试连接") { perform { _ = try await workspace.testConnector(account.id); return "连接成功" } }.disabled(!account.hasToken)
                    Button(account.enabled ? "停用" : "启用") { perform { try await workspace.setConnectorEnabled(account.id, enabled: !account.enabled); return nil } }
                    Button("重新授权") { connect(account.id) }
                    Divider()
                    Button("断开连接", role: .destructive) { removing = account.id }
                } label: { Image(systemName: "ellipsis").frame(width: 24, height: 24).contentShape(Rectangle()) }
                    #if os(macOS)
                    .menuStyle(.borderlessButton).menuIndicator(.hidden)
                    #endif
                    .fixedSize().disabled(locked).accessibilityLabel("管理 \(account.account ?? "令牌") 账户")
            }
            if let error = account.error { Text(error).font(.system(size: 12)).foregroundStyle(Theme.danger) }
            if !account.hasToken { Button("重新授权") { connect(account.id) }.disabled(locked) }
        }.accessibilityIdentifier("github-account-\(account.id)")
    }
    @ViewBuilder private var authorizationControls: some View {
        if let url = authorization.deviceURL {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("等待 GitHub 授权").font(.system(size: 13)) }
                if let code = authorization.userCode {
                    Text("在 GitHub 设备页输入 \(code)").font(.system(size: 13, design: .monospaced)).textSelection(.enabled)
                }
                HStack(spacing: 18) {
                    Button("打开设备页") { launch(url) }
                    Button("取消连接") { authorization.cancel() }
                }.font(.system(size: 13)).buttonStyle(.borderless)
            }.accessibilityIdentifier("github-authorizing")
        } else {
            Button { connect() } label: {
                HStack(spacing: 8) {
                    if authorization.starting { ProgressView().controlSize(.small) }
                    else if !accounts.isEmpty { Image(systemName: "plus") }
                    Text(authorization.starting ? "准备连接…" : accounts.isEmpty ? "连接 GitHub" : "添加其他账户")
                }.font(.system(size: 14))
            }.buttonStyle(.borderless).foregroundStyle(accounts.isEmpty ? Theme.brand : Theme.muted).disabled(locked)
            HStack(spacing: 8) {
                SecureField("或粘贴个人令牌（PAT）", text: $token).autocorrectionDisabled()
                    .onSubmit { Task { await saveToken() } }
                Button("用令牌连接") { Task { await saveToken() } }.disabled(token.isEmpty || locked)
            }.font(.system(size: 13)).padding(.top, 4)
        }
    }
    private func saveToken() async {
        let value = token.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty, !locked else { return }
        busy = true; feedback = nil
        defer { busy = false }
        do { _ = try await workspace.saveGithubToken(value); token = ""; failed = false; feedback = "GitHub 已连接" }
        catch { feedback = CoreError.wrap(error).message; failed = true; await workspace.refresh() }
    }
    private func connect(_ id: String? = nil) {
        feedback = nil
        Task {
            if let url = await authorization.start(connectorID: id) { launch(url) }
        }
    }
    private func launch(_ url: URL) { openURL(url) { accepted in if !accepted { authorization.failedToOpenBrowser() } } }
    private func perform(_ work: @escaping @MainActor () async throws -> String?) {
        guard !busy else { return }
        busy = true; feedback = nil
        Task {
            defer { busy = false }
            do { feedback = try await work(); failed = false }
            catch { feedback = CoreError.wrap(error).message; failed = true; await workspace.refresh() }
        }
    }
}

extension GithubConnectorView {
    var firstConnectorID: String { workspace.state?.connectors.first { $0.isGithub }?.id ?? "" }
    private func monitorRow(_ monitor: ConnectorMonitor) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(monitor.name).font(.system(size: 14))
                Spacer(minLength: 0)
                Text(monitor.enabled ? "已启用" : "已停用").font(.system(size: 12)).foregroundStyle(monitor.enabled ? Theme.success : Theme.muted).fixedSize()
                Menu {
                    Button(monitor.enabled ? "停用" : "启用") { perform { try await workspace.toggleGithubMonitor(monitor.id, enabled: !monitor.enabled); return nil } }
                    Button("编辑") { monitorEditor = monitor }
                    Divider()
                    Button("删除监视", role: .destructive) { perform { try await workspace.deleteGithubMonitor(monitor.id); return "监视已删除" } }
                } label: { Image(systemName: "ellipsis").frame(width: 24, height: 24).contentShape(Rectangle()) }
                    #if os(macOS)
                    .menuStyle(.borderlessButton).menuIndicator(.hidden)
                    #endif
                    .fixedSize().disabled(busy).accessibilityLabel("管理监视 \(monitor.name)")
            }
            Text(monitor.repos.joined(separator: "、")).font(.system(size: 12)).foregroundStyle(Theme.muted).textSelection(.enabled)
            Text(ciModeLabel(monitor.ciMode) + " · " + (monitor.delivery == "task" ? "任务" : "通知") + " · 每 \(max(1, monitor.intervalSeconds / 60)) 分钟\(monitor.webhookConfigured ? " · Webhook 已配置" : "")").font(.system(size: 12)).foregroundStyle(Theme.muted)
            if let error = monitor.lastError { Text(error).font(.system(size: 12)).foregroundStyle(Theme.danger) }
        }.accessibilityIdentifier("github-monitor-\(monitor.id)")
    }
    private func ciModeLabel(_ mode: String) -> String {
        switch mode {
        case "default_branch": return "仅默认分支"
        case "mine": return "我的 PR"
        case "all": return "全部 PR"
        default: return "关闭"
        }
    }
}

/// 监视配置表单：仓库、CI 范围、投递目标与方式。
struct GithubMonitorEditor: View {
    let workspace: WorkspaceStore
    let connectorId: String
    let existing: ConnectorMonitor?
    let onSaved: (ConnectorMonitorSaved) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var repos: String
    @State private var ciMode: String
    @State private var delivery: String
    @State private var botId: String
    @State private var intervalSeconds: Int
    @State private var muted: String
    @State private var ignore: String
    @State private var webhook = false
    @State private var regenerate = false
    @State private var busy = false
    @State private var errorText: String?

    init(workspace: WorkspaceStore, connectorId: String, existing: ConnectorMonitor?, onSaved: @escaping (ConnectorMonitorSaved) -> Void) {
        self.workspace = workspace; self.connectorId = connectorId; self.existing = existing; self.onSaved = onSaved
        _name = State(initialValue: existing?.name ?? "GitHub 监视")
        _repos = State(initialValue: existing?.repos.joined(separator: "\n") ?? "")
        _ciMode = State(initialValue: existing?.ciMode ?? "mine")
        _delivery = State(initialValue: existing?.delivery ?? "notify")
        _botId = State(initialValue: existing?.botId ?? "")
        _intervalSeconds = State(initialValue: existing?.intervalSeconds ?? 300)
        _muted = State(initialValue: existing?.mutedRepos.joined(separator: ", ") ?? "")
        _ignore = State(initialValue: existing?.ignoreBranches.joined(separator: ", ") ?? "")
    }

    private var valid: Bool { !repos.isEmpty && !botId.isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                TextField("名称", text: $name)
                Section("仓库（每行一个 owner/name）") {
                    TextEditor(text: $repos).frame(minHeight: 80).font(.system(size: 13, design: .monospaced)).autocorrectionDisabled()
                }
                Picker("CI 提醒范围", selection: $ciMode) {
                    Text("我的 PR").tag("mine"); Text("仅默认分支").tag("default_branch"); Text("全部 PR").tag("all"); Text("关闭").tag("off")
                }
                Picker("投递方式", selection: $delivery) {
                    Text("通知（直达话题）").tag("notify"); Text("任务（助手处理）").tag("task")
                }
                Picker("投递目标助手", selection: $botId) {
                    ForEach(workspace.state?.bots ?? [], id: \.id) { bot in
                        Text(bot.name).tag(String(bot.id))
                    }
                }
                Picker("轮询间隔", selection: $intervalSeconds) {
                    Text("1 分钟").tag(60); Text("5 分钟").tag(300); Text("15 分钟").tag(900); Text("30 分钟").tag(1800); Text("1 小时").tag(3600)
                }
                TextField("忽略分支（逗号分隔，支持 *）", text: $ignore)
                TextField("静音仓库（逗号分隔）", text: $muted)
                if existing == nil { Toggle("同时生成 Webhook（实时推送）", isOn: $webhook) }
                if existing?.webhookConfigured == true { Toggle("重新生成 Webhook 密钥", isOn: $regenerate) }
                if let errorText { Text(errorText).font(.system(size: 12)).foregroundStyle(Theme.danger) }
                Button { Task { await save() } } label: {
                    HStack(spacing: 6) { if busy { ProgressView().controlSize(.small) }; Text(busy ? "保存中…" : "保存监视") }
                }.disabled(!valid || busy)
            }
            .navigationTitle(existing == nil ? "添加监视" : "编辑监视")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(busy) } }
        }.interactiveDismissDisabled(busy)
    }

    private func save() async {
        guard valid, !busy else { return }
        busy = true; errorText = nil
        defer { busy = false }
        do {
            let repos = repos.split(whereSeparator: { $0 == "\n" || $0 == "," || $0 == " " }).map(String.init)
            let saved = try await workspace.saveGithubMonitor(existing: existing, connectorId: connectorId, botId: botId, name: name, repos: repos, ciMode: ciMode, delivery: delivery, intervalSeconds: intervalSeconds, mutedRepos: muted.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }, ignoreBranches: ignore.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }, enableWebhook: webhook, regenerateWebhookSecret: regenerate)
            onSaved(saved); dismiss()
        } catch { errorText = CoreError.wrap(error).message }
    }
}

private extension View {
    func githubSurface() -> some View {
        frame(maxWidth: .infinity, alignment: .leading).background(Theme.card, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.border))
    }
}

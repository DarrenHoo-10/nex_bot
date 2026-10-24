import SwiftUI
import NexClientKit

struct GmailMark: View {
    var size: CGFloat = 60
    var body: some View {
        Image("Gmail").resizable().scaledToFit().padding(size * 0.12)
            .frame(width: size, height: size).background(.white, in: RoundedRectangle(cornerRadius: size * 0.25))
            .overlay(RoundedRectangle(cornerRadius: size * 0.25).strokeBorder(Theme.border)).accessibilityHidden(true)
    }
}

@MainActor
struct GmailCatalogButton: View {
    let workspace: WorkspaceStore
    let open: () -> Void
    private var added: Bool { workspace.state?.connectors.contains { $0.isGmail } == true }
    var body: some View {
        Button(action: open) {
            HStack(spacing: 16) {
                GmailMark(size: 54)
                VStack(alignment: .leading, spacing: 5) {
                    Text("Gmail").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.foreground)
                    Text("搜索、读取邮件与会话。").font(.system(size: 13)).foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 8)
                if added {
                    Image(systemName: "checkmark").foregroundStyle(Theme.success)
                    Text("已添加").font(.system(size: 12)).foregroundStyle(Theme.muted)
                } else { Image(systemName: "chevron.right").foregroundStyle(Theme.muted) }
            }
            .padding(.vertical, 16).contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityIdentifier("gmail-catalog")
    }
}

private struct GmailGrantTarget: Identifiable {
    let connectorID: String, botID: String
    var id: String { connectorID + "/" + botID }
}

/// Shared native page: the provider's identity stays separate from each mailbox's grants.
@MainActor
struct GmailConnectorView: View {
    let workspace: WorkspaceStore
    var back: (() -> Void)?
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var authorization: ConnectorAuthorization
    @State private var granting: GmailGrantTarget?
    @State private var removing: String?
    @State private var busy = false
    @State private var toolsOpen = false
    @State private var feedback: String?
    @State private var failed = false

    init(workspace: WorkspaceStore, back: (() -> Void)? = nil) {
        self.workspace = workspace; self.back = back
        #if DEBUG
        _authorization = State(initialValue: ConnectorAuthorization(workspace: workspace, allowLoopbackFixture: true))
        #else
        _authorization = State(initialValue: ConnectorAuthorization(workspace: workspace))
        #endif
    }
    private var accounts: [ConnectorView] { workspace.state?.connectors.filter(\.isGmail) ?? [] }
    private var available: Bool { workspace.state?.gmailAvailable == true }
    private var locked: Bool { busy || authorization.busy }
    private var names: [String] { accounts.first?.tools.map(\.name) ?? GmailTools.names }
    private var usable: Set<String> { available ? Set(accounts.filter(\.isReady).flatMap { $0.tools.map(\.name) }) : [] }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                if let back { Button(action: back) { Label("连接器", systemImage: "chevron.left") }.buttonStyle(.plain).foregroundStyle(Theme.muted) }
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 18) {
                        GmailMark(size: 68)
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Gmail").font(.system(size: 26, weight: .semibold))
                            Text("Google").font(.system(size: 13)).foregroundStyle(Theme.muted)
                        }
                    }
                    Text("搜索、读取邮件与会话。").font(.system(size: 15)).foregroundStyle(Theme.muted)
                }
                if let message = authorization.error ?? feedback {
                    Text(message).font(.system(size: 13)).foregroundStyle(authorization.error != nil || failed ? Theme.danger : Theme.muted)
                        .accessibilityIdentifier("gmail-feedback")
                }
                section("账户") {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(accounts) { account in
                            if account.id != accounts.first?.id { Divider().overlay(Theme.border) }
                            accountRow(account).padding(20)
                        }
                        authorizationControls.padding(20).padding(.top, accounts.isEmpty ? 0 : -12)
                    }.gmailSurface()
                }
                section("工具") {
                    DisclosureGroup(isExpanded: $toolsOpen) {
                        VStack(spacing: 0) {
                            ForEach(names, id: \.self) { name in
                                Divider().overlay(Theme.border)
                                HStack {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(GmailTools.label(name)).font(.system(size: 14))
                                        Text(GmailTools.detail(name)).font(.system(size: 12)).foregroundStyle(Theme.muted)
                                    }
                                    Spacer(minLength: 8)
                                    if usable.contains(name) { Image(systemName: "checkmark").foregroundStyle(Theme.success) }
                                }.padding(.vertical, 14)
                            }
                        }.padding(.top, 10)
                    } label: {
                        Text(accounts.isEmpty ? "\(names.count) 个工具" : "可用 \(usable.count)/\(names.count) 个").font(.system(size: 14))
                    }.tint(Theme.muted).padding(20).gmailSurface().accessibilityIdentifier("gmail-tools")
                }
                section("应用  1") {
                    HStack(spacing: 14) {
                        Image(systemName: "powerplug").foregroundStyle(Theme.muted)
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Gmail").font(.system(size: 14))
                            Text("连接器").font(.system(size: 12)).foregroundStyle(Theme.muted)
                        }
                        Spacer()
                    }.padding(20).gmailSurface()
                }
                section("信息") {
                    VStack(spacing: 18) {
                        information("服务提供方", "Google")
                        information("访问权限", "只读")
                        information("类别", "邮件")
                    }.padding(20).gmailSurface()
                }
            }.foregroundStyle(Theme.foreground).padding(.bottom, 28)
            #if os(iOS)
            .padding(.horizontal, 20).padding(.top, 20)
            #endif
        }
        .navigationTitle("Gmail")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .background(Theme.background)
        .task(id: "\(authorization.attempt?.id ?? "")-\(scenePhase == .active)") {
            if scenePhase == .active { await authorization.waitForCompletion() }
        }
        .onDisappear { authorization.cancel() }
        .onChange(of: authorization.connectedID) { _, id in if id != nil { failed = false; feedback = "Gmail 已连接" } }
        .sheet(item: $granting) { target in GmailGrantSheet(workspace: workspace, connectorID: target.connectorID, botID: target.botID) }
        .confirmationDialog("断开此邮箱并移除助手授权？", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
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
    private func information(_ label: String, _ value: String) -> some View {
        HStack { Text(label); Spacer(); Text(value).foregroundStyle(Theme.muted) }.font(.system(size: 13))
    }
    private func accountRow(_ account: ConnectorView) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(account.account ?? account.name).font(.system(size: 14)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Text(available ? account.statusChip : "暂不可用").font(.system(size: 12)).foregroundStyle(available && account.isReady ? Theme.success : Theme.muted).fixedSize()
                Menu {
                    Button("测试连接") { perform { _ = try await workspace.testConnector(account.id); return "连接成功" } }.disabled(!available || !account.hasToken)
                    Button(account.enabled ? "停用" : "启用") { perform { try await workspace.setConnectorEnabled(account.id, enabled: !account.enabled); return nil } }
                    Button("重新授权") { connect(account.id) }.disabled(!available)
                    Divider()
                    Button("断开连接", role: .destructive) { removing = account.id }
                } label: { Image(systemName: "ellipsis").frame(width: 24, height: 24).contentShape(Rectangle()) }
                    #if os(macOS)
                    .menuStyle(.borderlessButton).menuIndicator(.hidden)
                    #endif
                    .fixedSize().disabled(locked).accessibilityLabel("管理 \(account.account ?? account.name) 账户")
            }
            if let error = account.error { Text(error).font(.system(size: 12)).foregroundStyle(Theme.danger) }
            ForEach(workspace.bots) { bot in
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(bot.name).font(.system(size: 13))
                        Text("\(account.grant(for: bot.id)?.tools.count ?? 0) 项工具已授权").font(.system(size: 11))
                    }.foregroundStyle(Theme.muted)
                    Spacer(minLength: 8)
                    Button("管理授权") { granting = GmailGrantTarget(connectorID: account.id, botID: bot.id) }
                        .buttonStyle(.borderless).font(.system(size: 12)).padding(.horizontal, 12).padding(.vertical, 7)
                        .background(Theme.secondary, in: Capsule()).disabled(locked || !account.hasToken || account.checkedAt == nil)
                }
            }
            if !account.hasToken { Button("重新授权") { connect(account.id) }.disabled(locked || !available) }
        }.accessibilityIdentifier("gmail-account-\(account.id)")
    }
    @ViewBuilder private var authorizationControls: some View {
        if let url = authorization.authorizationURL {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("等待 Google 授权").font(.system(size: 13)) }
                HStack(spacing: 18) {
                    Button("继续授权") { launch(url) }
                    Button("取消连接") { authorization.cancel() }
                }.font(.system(size: 13)).buttonStyle(.borderless)
            }
        } else {
            Button { connect() } label: {
                HStack(spacing: 8) {
                    if authorization.starting { ProgressView().controlSize(.small) }
                    else if !accounts.isEmpty { Image(systemName: "plus") }
                    Text(authorization.starting ? "准备连接…" : accounts.isEmpty ? "连接 Gmail" : "添加其他账户")
                }.font(.system(size: 14))
            }.buttonStyle(.borderless).foregroundStyle(accounts.isEmpty ? Theme.brand : Theme.muted).disabled(locked || !available)
            if !available { Text("暂时无法连接").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.top, 8) }
        }
    }
    private func connect(_ id: String? = nil) {
        feedback = nil
        Task { if let url = await authorization.start(connectorID: id) { launch(url) } }
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

@MainActor
private struct GmailGrantSheet: View {
    let workspace: WorkspaceStore
    let connectorID: String, botID: String
    @Environment(\.dismiss) private var dismiss
    @State private var selection: Set<String>
    @State private var busy = false
    @State private var error: String?
    init(workspace: WorkspaceStore, connectorID: String, botID: String) {
        self.workspace = workspace; self.connectorID = connectorID; self.botID = botID
        _selection = State(initialValue: Set(workspace.state?.connectors.first { $0.id == connectorID }?.grant(for: botID)?.tools ?? []))
    }
    private var connector: ConnectorView? { workspace.state?.connectors.first { $0.id == connectorID } }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("为 \(workspace.bot(botID)?.name ?? "助手") 选择工具").font(.headline)
            ForEach(connector?.tools ?? [], id: \.name) { tool in
                Toggle(GmailTools.label(tool.name), isOn: Binding(get: { selection.contains(tool.name) }, set: { on in
                    if on { selection.insert(tool.name) } else { selection.remove(tool.name) }
                })).disabled(busy)
            }
            if let error { Text(error).font(.callout).foregroundStyle(Theme.danger) }
            HStack {
                Button("取消") { dismiss() }.disabled(busy)
                Spacer()
                Button("保存授权") {
                    busy = true
                    Task {
                        defer { busy = false }
                        do { try await workspace.grantConnector(connectorID, botID: botID, tools: (connector?.tools ?? []).map(\.name).filter(selection.contains)); dismiss() }
                        catch { self.error = CoreError.wrap(error).message }
                    }
                }.disabled(busy || connector == nil).buttonStyle(.borderedProminent).tint(Theme.brand)
            }
        }.padding(24).frame(minWidth: 300, idealWidth: 420).foregroundStyle(Theme.foreground).background(Theme.card)
        #if os(iOS)
        .presentationDetents([.medium, .large])
        #endif
    }
}

private extension View {
    func gmailSurface() -> some View {
        frame(maxWidth: .infinity, alignment: .leading).background(Theme.card, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.border))
    }
}

import SwiftUI
import NexClientKit

/// Level 1 Settings screen: a clean grouped list of settings categories that push into their detail pages.
struct SettingsView: View {
    let model: AppModel
    let workspace: WorkspaceStore
    @Environment(Navigation.self) private var nav

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(Array(SettingsCategory.allCases.enumerated()), id: \.element) { index, item in
                    Button { nav.openSettings(item) } label: {
                        HStack(spacing: 12) {
                            Image(systemName: item.icon)
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(Theme.brand)
                                .frame(width: 32, height: 32)
                                .background(Theme.wash, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                            Text(item.rawValue)
                                .font(.body)
                                .foregroundStyle(Theme.foreground)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Theme.muted)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if index < SettingsCategory.allCases.count - 1 {
                        Divider().overlay(Theme.border).padding(.leading, 58)
                    }
                }
            }
            .cardStyle()
            .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 32)
        }
        .background(Theme.background)
        .navigationTitle("设置")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .toolbarBackground(Theme.background, for: .navigationBar)
    }
}

/// Level 2 Settings screen: renders a single chosen category with native Back navigation to the Settings index.
struct SettingsDetailView: View {
    let model: AppModel
    let workspace: WorkspaceStore
    let category: SettingsCategory
    @State private var confirmLogout = false
    @State private var revoking: ClientSession?
    @State private var errorText: String?
    @State private var sessionsLoaded = false
    @State private var sessionsFailed = false
    @State private var modelForm: ModelForm

    init(model: AppModel, workspace: WorkspaceStore, category: SettingsCategory) {
        self.model = model; self.workspace = workspace; self.category = category
        _modelForm = State(initialValue: ModelForm(config: workspace.state?.config))
    }

    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                switch category {
                case .account: account
                case .model: SettingsModelView(workspace: workspace, form: modelForm)
                case .memory: SettingsMemoryView(workspace: workspace)
                case .connectors: ConnectorsView(workspace: workspace)
                case .devices: DevicesView(workspace: workspace)
                case .about: AboutSettingsView(workspace: workspace)
                }
            }
            .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
            Color.clear.frame(height: 1).id("bottom")
        }
        .onDebugUI { cmd, _ in
            if cmd == "s-bottom" { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        }
        .background(Theme.background)
        .navigationTitle(category.rawValue)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .onAppear {
            workspace.setResourceVisible("settings", category == .connectors || category == .devices)
        }
        .onDisappear { workspace.setResourceVisible("settings", false) }
        .task { if category == .account { await load() } }
        .refreshable {
            if category == .account { await load() }
            await workspace.refresh()
        }
        .errorAlert($errorText)
        .onDebugUI { cmd, _ in if cmd == "settingslogout" { confirmLogout = true } }
        .sheet(isPresented: $confirmLogout) { LogoutConfirmationSheet(model: model, isPresented: $confirmLogout) }
        .confirmationDialog("撤销该设备的登录？", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible, presenting: revoking) { session in
            Button("撤销「\(session.name)」", role: .destructive) {
                Task {
                    do { try await workspace.revokeSession(session.sessionID) }
                    catch { errorText = coreMessage(error) }
                }
            }
        }
    }

    // MARK: Account

    private var account: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 12) {
                AccountAvatar(size: 44, initial: accountInitial(workspace))
                Text(workspace.account?.displayName ?? "NexorAI 用户").font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer()
                Button("退出登录") { confirmLogout = true }.buttonStyle(PillButtonStyle())
            }
            .padding(14).cardStyle()
            VStack(spacing: 0) {
                FactRow(title: "本次登录有效期", value: model.credential.map { Self.date(Date(timeIntervalSince1970: $0.expiresAt / 1000)) } ?? "—")
            }
            .padding(.horizontal, 14).cardStyle()
            HStack {
                Text("登录设备").font(.subheadline.weight(.semibold))
                Spacer()
                if sessionsLoaded { Text("\(activeSessions.count) 个有效登录").font(.caption).foregroundStyle(Theme.muted) }
            }
            VStack(spacing: 10) {
                ForEach(activeSessions) { session in sessionCard(session) }
                if sessionsFailed { Text("登录设备暂时无法加载，请稍后重新打开设置。").font(.footnote).foregroundStyle(Theme.muted) }
                else if !sessionsLoaded { Text("正在加载登录设备…").font(.footnote).foregroundStyle(Theme.muted) }
                else if activeSessions.filter({ $0.sessionID != workspace.currentSessionID }).isEmpty { Text("暂无其他有效登录。").font(.footnote).foregroundStyle(Theme.muted) }
            }
        }
    }

    /// Sessions that are not revoked and have not expired, current device first.
    private var activeSessions: [ClientSession] {
        workspace.sessions
            .filter { $0.row.double("revoked_at") == nil && ($0.expiresAt.map { $0 > Date() } ?? true) }
            .sorted { lhs, rhs in
                let lc = lhs.sessionID == workspace.currentSessionID
                let rc = rhs.sessionID == workspace.currentSessionID
                if lc != rc { return lc }
                return (lhs.expiresAt ?? .distantPast) > (rhs.expiresAt ?? .distantPast)
            }
    }

    private static func deviceSymbol(_ name: String) -> String {
        let lower = name.lowercased()
        if lower.range(of: #"\b(android|iphone|ipad|ios|mobile|phone|pixel|huawei|xiaomi|redmi|honor|oppo|vivo|oneplus|samsung)\b|手机"#, options: .regularExpression) != nil {
            return "iphone"
        }
        if lower.range(of: #"\b(browser|chrome|safari|firefox|edge|web)\b|浏览器"#, options: .regularExpression) != nil {
            return "globe"
        }
        return "laptopcomputer"
    }

    private func sessionCard(_ session: ClientSession) -> some View {
        let current = session.sessionID == workspace.currentSessionID
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: Self.deviceSymbol(session.name)).foregroundStyle(Theme.muted)
                Text(session.name.isEmpty ? "未命名设备" : session.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                if current {
                    Text("当前设备").font(.caption2.weight(.medium)).foregroundStyle(Theme.success)
                        .padding(.horizontal, 8).padding(.vertical, 2).background(Theme.successSoft, in: Capsule())
                }
                Spacer()
            }
            if let end = session.expiresAt { Text("到期时间：\(Self.date(end))").font(.caption).foregroundStyle(Theme.muted) }
            if !current {
                Button("撤销登录") { revoking = session }.buttonStyle(PillButtonStyle(danger: true))
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading).cardStyle()
    }

    // MARK: Pieces

    private static func date(_ date: Date) -> String { date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(Locale(identifier: "zh_CN"))) }

    private func load() async {
        do { try await workspace.loadSessions(); sessionsLoaded = true; sessionsFailed = false }
        catch { sessionsFailed = true }
    }
}

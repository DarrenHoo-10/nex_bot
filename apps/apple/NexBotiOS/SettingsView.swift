import SwiftUI
import NexClientKit

/// Global settings, pushed from the account menu. Five categories (chips), one shown at a time.
struct SettingsView: View {
    let model: AppModel
    let workspace: WorkspaceStore
    @Environment(Navigation.self) private var nav
    private var category: SettingsCategory { nav.settingsCategory }
    @State private var confirmLogout = false
    @State private var revoking: ClientSession?
    @State private var errorText: String?
    @State private var sessionsLoaded = false
    @State private var sessionsFailed = false
    @State private var modelForm: ModelForm
    @State private var memoryForm: MemoryForm

    init(model: AppModel, workspace: WorkspaceStore) {
        self.model = model; self.workspace = workspace
        _modelForm = State(initialValue: ModelForm(config: workspace.state?.config))
        _memoryForm = State(initialValue: MemoryForm(plugin: workspace.state?.memoryPlugin))
    }

    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("设置").font(.largeTitle.weight(.bold))
                chips
                switch category {
                case .account: account
                case .model: SettingsModelView(workspace: workspace, form: modelForm)
                case .memory: SettingsMemoryView(workspace: workspace, form: memoryForm)
                case .connectors: ConnectorsView(workspace: workspace)
                case .devices: DevicesView(workspace: workspace)
                }
            }
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
            Color.clear.frame(height: 1).id("bottom")
        }
        .onDebugUI { cmd, _ in
            if cmd == "s-bottom" { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        }
        .background(Theme.background)
        .navigationTitle("设置")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .task { await load() }
        .refreshable { await load(); await workspace.refresh() }
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

    private var chips: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
            ForEach(SettingsCategory.allCases, id: \.self) { item in
                let selected = item == category
                Button { nav.settingsCategory = item } label: {
                    HStack(spacing: 8) {
                        Image(systemName: item.icon)
                        Text(item.rawValue).lineLimit(1).minimumScaleFactor(0.8)
                        Spacer(minLength: 0)
                    }
                    .font(.footnote.weight(selected ? .semibold : .regular))
                    .foregroundStyle(selected ? Theme.brand : Theme.muted)
                    .padding(.horizontal, 14).padding(.vertical, 12)
                    .background(selected ? Theme.brandSoft : Color.clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: Account

    private var account: some View {
        VStack(alignment: .leading, spacing: 20) {
            PageHeading(title: "账号与登录设备")
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

    /// Sessions that are not revoked and have not expired.
    private var activeSessions: [ClientSession] {
        workspace.sessions.filter { $0.row.double("revoked_at") == nil && ($0.expiresAt.map { $0 > Date() } ?? true) }
    }

    private func sessionCard(_ session: ClientSession) -> some View {
        let current = session.sessionID == workspace.currentSessionID
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "iphone").foregroundStyle(Theme.muted)
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

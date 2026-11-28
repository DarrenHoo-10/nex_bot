import SwiftUI
import NexClientKit

/// Global settings, laid out like the web UI: category list on the left, one category on the right.
/// Every category stays mounted while hidden so unsaved drafts survive switching.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(LocalDeviceController.self) private var device
    @AppStorage(SettingsCategory.storageKey) private var category = SettingsCategory.account
    @State private var confirmingLogout = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("设置").font(.system(size: 28, weight: .bold))
            HStack(alignment: .top, spacing: 44) {
                VStack(spacing: 4) {
                    ForEach(SettingsCategory.allCases, id: \.self) { item in
                        SettingsNavItem(item: item, selected: category == item) { category = item }
                    }
                }
                .frame(width: 192)
                ZStack(alignment: .topLeading) {
                    pane(.account) { scroll { AccountPane { confirmingLogout = true } } }
                    if let ws = model.workspace {
                        pane(.model) { scroll { SettingsModelPane(workspace: ws, active: category == .model) } }
                        pane(.memory) { scroll { SettingsMemoryPane(workspace: ws, active: category == .memory) } }
                        pane(.team) { scroll { AgentTeamSettingsView(workspace: ws, active: category == .team) } }
                        pane(.connectors) { SettingsConnectorsPane(workspace: ws) }
                        pane(.devices) { SettingsDevicesPane(workspace: ws) }
                        pane(.about) { scroll { AboutSettingsPane(workspace: ws) } }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .padding(.top, 24)
        }
        .padding(.horizontal, 36).padding(.top, 28)
        .frame(minWidth: 820, idealWidth: 1020, minHeight: 600, idealHeight: 760, alignment: .topLeading)
        .background(Theme.background)
        .onChange(of: category, initial: true) { _, category in
            model.workspace?.setResourceVisible("settings", category == .connectors || category == .devices)
        }
        .onDisappear { model.workspace?.setResourceVisible("settings", false) }
        .logoutConfirmation(isPresented: $confirmingLogout) { AppUpdater.shared.stop(); await device.stop(revoke: true); await model.logout(); return model.workspace == nil }
    }

    private func scroll<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        let inner = content()
        return ScrollViewReader { proxy in
            ScrollView { VStack(spacing: 0) { inner.padding(.bottom, 34).frame(maxWidth: .infinity, alignment: .leading); Color.clear.frame(height: 1).id("pane-end") } }
            #if DEBUG
            .onReceive(NotificationCenter.default.publisher(for: .mbDebug)) { note in
                guard let cmd = note.mbCommand, cmd.verb == "scroll" else { return }
                proxy.scrollTo("pane-end", anchor: .bottom)
            }
            #endif
        }
    }

    private func pane<C: View>(_ item: SettingsCategory, @ViewBuilder _ content: () -> C) -> some View {
        let shown = category == item
        return content()
            .opacity(shown ? 1 : 0).allowsHitTesting(shown).disabled(!shown).accessibilityHidden(!shown)
            .zIndex(shown ? 1 : 0)
    }
}

/// "10/18 05:55", as in the web UI.
func stamp(_ date: Date) -> String {
    let f = DateFormatter(); f.dateFormat = "M/d HH:mm"; return f.string(from: date)
}

@MainActor func paneHeader(_ title: String, _ detail: String? = nil) -> some View {
    paneHeader(title, detail) { EmptyView() }
}

@MainActor func paneHeader<T: View>(_ title: String, _ detail: String? = nil, @ViewBuilder trailing: () -> T) -> some View {
    VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.system(size: 20, weight: .bold))
                if let detail { Text(detail).font(.system(size: 12)).foregroundStyle(Theme.muted) }
            }
            Spacer()
            trailing()
        }
        Hairline().padding(.top, 14)
    }
}

@MainActor func infoRow(_ label: String, _ value: String, mono: Bool = false) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 0) {
        Text(label).font(.system(size: 12)).foregroundStyle(Theme.muted).frame(width: 136, alignment: .leading)
        Text(value).font(.system(size: 12, design: mono ? .monospaced : .default)).textSelection(.enabled)
        Spacer()
    }
}

private struct SettingsNavItem: View {
    let item: SettingsCategory
    let selected: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: item.icon).font(.system(size: 13.5, weight: selected ? .semibold : .regular)).frame(width: 18)
                Text(item.rawValue).font(.system(size: 13, weight: selected ? .semibold : .regular))
                Spacer()
            }
            .foregroundStyle(selected ? Theme.brandInk : (hovering ? Theme.foreground : Theme.muted))
            .padding(.horizontal, 12).frame(height: 40)
            .background(selected ? Theme.brandSoft : (hovering ? Theme.wash : .clear), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct OutlineButton: View {
    let title: String
    var danger = false
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 12, weight: .medium))
                .foregroundStyle(danger ? (hovering ? .white : Theme.danger) : Theme.foreground)
                .padding(.horizontal, 14).frame(height: 34)
                .background(danger && hovering ? Theme.danger : (hovering ? Theme.wash : Theme.card), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(danger && hovering ? Theme.danger : Theme.borderStrong))
                .contentShape(Rectangle())
        }
        .plainActionFeedback()
        .onHover { hovering = $0 }
    }
}

private struct AccountPane: View {
    @Environment(AppModel.self) private var model
    let requestLogout: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            paneHeader("账号与登录设备")
            MBCard(padding: 20) {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 14) {
                        PersonAvatar(initial: model.workspace?.account?.initial ?? "N", size: 46, online: false)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(model.workspace?.account?.displayName ?? "NexorAI 用户").font(.system(size: 15, weight: .semibold))
                            if let credential = model.credential {
                                Text("本次登录有效期至 \(stamp(Date(timeIntervalSince1970: credential.expiresAt / 1000)))")
                                    .font(.system(size: 11.5)).foregroundStyle(Theme.muted)
                            }
                        }
                        Spacer()
                        OutlineButton(title: "退出登录", danger: true, action: requestLogout)
                    }
                }
            }
            if let workspace = model.workspace { SessionsSection(workspace: workspace) }
        }
    }
}

private func sessionDeviceSymbol(_ name: String) -> String {
    let lower = name.lowercased()
    if lower.range(of: #"\b(android|iphone|ipad|ios|mobile|phone|pixel|huawei|xiaomi|redmi|honor|oppo|vivo|oneplus|samsung)\b|手机"#, options: .regularExpression) != nil {
        return "iphone"
    }
    if lower.range(of: #"\b(browser|chrome|safari|firefox|edge|web)\b|浏览器"#, options: .regularExpression) != nil {
        return "globe"
    }
    return "laptopcomputer"
}

private struct SessionsSection: View {
    let workspace: WorkspaceStore
    @State private var error: String?
    @State private var loaded = false
    @State private var loadFailed = false
    @State private var revoking: ClientSession?

    private var orderedSessions: [ClientSession] {
        let now = Date()
        return workspace.sessions
            .filter { $0.row.double("revoked_at") == nil && ($0.expiresAt ?? .distantFuture) > now }
            .sorted { lhs, rhs in
                let lc = lhs.sessionID == workspace.currentSessionID
                let rc = rhs.sessionID == workspace.currentSessionID
                if lc != rc { return lc }
                let lt = lhs.lastSeenAt ?? lhs.expiresAt ?? .distantPast
                let rt = rhs.lastSeenAt ?? rhs.expiresAt ?? .distantPast
                return lt > rt
            }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("登录设备").font(.system(size: 13.5, weight: .semibold))
                Spacer()
                Text("\(orderedSessions.count) 个有效登录").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.brandInk)
                    .padding(.horizontal, 10).padding(.vertical, 3).background(Theme.brandSoft, in: Capsule())
            }
            if !orderedSessions.isEmpty {
                MBCard(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(Array(orderedSessions.enumerated()), id: \.element.id) { index, session in
                            let current = session.sessionID == workspace.currentSessionID
                            HStack(spacing: 12) {
                                Image(systemName: sessionDeviceSymbol(session.name))
                                    .font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.brand)
                                    .frame(width: 36, height: 36)
                                    .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border))
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack(spacing: 8) {
                                        Text(session.name.isEmpty ? "未命名设备" : session.name).font(.system(size: 13, weight: .semibold))
                                        if current {
                                            Text("当前设备").font(.system(size: 10.5, weight: .medium)).foregroundStyle(Theme.brandInk)
                                                .padding(.horizontal, 8).padding(.vertical, 2).background(Theme.brandSoft, in: Capsule())
                                        }
                                    }
                                    if let expires = session.expiresAt {
                                        Text("到期时间：\(stamp(expires))").font(.system(size: 11.5)).foregroundStyle(Theme.muted)
                                    }
                                }
                                Spacer()
                                if !current { OutlineButton(title: "撤销登录", danger: true) { revoking = session } }
                            }
                            .padding(.horizontal, 16).padding(.vertical, 13)
                            if index < orderedSessions.count - 1 { Hairline().padding(.leading, 64) }
                        }
                    }
                }
            }
            if loadFailed { Text("登录设备暂时无法加载，请稍后重新打开设置。").font(.system(size: 12)).foregroundStyle(Theme.muted) }
            else if !loaded && orderedSessions.isEmpty { Text("正在加载登录设备…").font(.system(size: 12)).foregroundStyle(Theme.muted) }
            else if orderedSessions.isEmpty { Text("暂无有效登录设备。").font(.system(size: 12)).foregroundStyle(Theme.muted) }
            if let error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger) }
        }
        .task { load() }
        .confirmationDialog("撤销该设备的登录？", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible, presenting: revoking) { session in
            Button("撤销「\(session.name.isEmpty ? "未命名设备" : session.name)」", role: .destructive) { revoke(session.sessionID) }
        }
    }

    private func load() {
        Task {
            do { try await workspace.loadSessions(); error = nil; loadFailed = false }
            catch { loadFailed = true }
            loaded = true
        }
    }

    private func revoke(_ id: String) {
        Task {
            do { try await workspace.revokeSession(id); error = nil }
            catch { self.error = message(of: error) }
        }
    }
}

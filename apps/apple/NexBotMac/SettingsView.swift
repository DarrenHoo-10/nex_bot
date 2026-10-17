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
                        Button { category = item } label: {
                            HStack(spacing: 10) {
                                Image(systemName: item.icon).font(.system(size: 12)).frame(width: 16)
                                Text(item.rawValue).font(.system(size: 12))
                                Spacer()
                            }
                            .foregroundStyle(category == item ? Theme.brand : Theme.muted)
                            .padding(.horizontal, 12).frame(height: 42)
                            .background(category == item ? Theme.brandSoft : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(category == item ? .isSelected : [])
                    }
                }
                .frame(width: 174)
                ZStack(alignment: .topLeading) {
                    pane(.account) { scroll { AccountPane { confirmingLogout = true } } }
                    if let ws = model.workspace {
                        pane(.model) { scroll { SettingsModelPane(workspace: ws) } }
                        pane(.memory) { scroll { SettingsMemoryPane(workspace: ws) } }
                        pane(.connectors) { SettingsConnectorsPane(workspace: ws) }
                        pane(.devices) { SettingsDevicesPane(workspace: ws) }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .padding(.top, 32)
        }
        .padding(.horizontal, 40).padding(.top, 34)
        .frame(width: 1080, height: 860, alignment: .topLeading)
        .background(Theme.background)
        .logoutConfirmation(isPresented: $confirmingLogout) { await device.stop(revoke: true); await model.logout(); return model.workspace == nil }
    }

    private func scroll<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        ScrollView { content().padding(.bottom, 34).frame(maxWidth: .infinity, alignment: .leading) }
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

private struct OutlineButton: View {
    let title: String
    var danger = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 12)).foregroundStyle(danger ? Theme.danger : Theme.foreground)
                .padding(.horizontal, 14).frame(height: 34)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct AccountPane: View {
    @Environment(AppModel.self) private var model
    let requestLogout: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            paneHeader("账号与登录设备")
            HStack(spacing: 14) {
                Circle().fill(Color(hex: 0x3B66E8)).frame(width: 44, height: 44)
                    .overlay(Image(systemName: "person").font(.system(size: 20)).foregroundStyle(.white))
                Text(model.workspace?.account?.displayName ?? "NexorAI 用户").font(.system(size: 15, weight: .semibold))
                Spacer()
                OutlineButton(title: "退出登录", action: requestLogout)
            }
            .padding(.top, 20)
            VStack(alignment: .leading, spacing: 18) {
                if let credential = model.credential {
                    infoRow("本次登录有效期", stamp(Date(timeIntervalSince1970: credential.expiresAt / 1000)))
                }
            }
            .padding(.top, 22).padding(.bottom, 26)
            Hairline()
            if let workspace = model.workspace { SessionsSection(workspace: workspace) }
        }
    }
}

private struct SessionsSection: View {
    let workspace: WorkspaceStore
    @State private var error: String?
    @State private var loaded = false
    @State private var loadFailed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("登录设备").font(.system(size: 13, weight: .semibold))
                Spacer()
                Text("\(workspace.sessions.count) 个有效登录").font(.system(size: 10)).foregroundStyle(Theme.muted)
                    .padding(.horizontal, 8).padding(.vertical, 4).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 5))
            }
            .padding(.top, 24)
            VStack(spacing: 14) {
                ForEach(workspace.sessions) { session in
                    let current = session.sessionID == workspace.currentSessionID
                    HStack(spacing: 12) {
                        Image(systemName: "laptopcomputer").font(.system(size: 14)).foregroundStyle(Theme.muted).frame(width: 20)
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) {
                                Text(session.name.isEmpty ? "未命名设备" : session.name).font(.system(size: 13, weight: .semibold))
                                if current {
                                    Text("当前设备").font(.system(size: 10)).foregroundStyle(Theme.brand)
                                        .padding(.horizontal, 7).padding(.vertical, 2).background(Theme.brandSoft, in: RoundedRectangle(cornerRadius: 5))
                                }
                            }
                            if let expires = session.expiresAt {
                                Text("到期时间：\(stamp(expires))").font(.system(size: 11)).foregroundStyle(Theme.muted)
                            }
                        }
                        Spacer()
                        if !current { OutlineButton(title: "撤销登录") { revoke(session.sessionID) } }
                    }
                }
            }
            .padding(.top, 18)
            if loadFailed { Text("登录设备暂时无法加载，请稍后重新打开设置。").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.top, 14) }
            else if !loaded && workspace.sessions.isEmpty { Text("正在加载登录设备…").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.top, 14) }
            else if workspace.sessions.isEmpty { Text("暂无其他有效登录。").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.top, 14) }
            if let error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).padding(.top, 10) }
        }
        .task { load() }
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

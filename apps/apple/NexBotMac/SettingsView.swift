import SwiftUI
import NexClientKit

/// Global settings, laid out like the web UI: category list on the left, one category on the right.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage(SettingsCategory.storageKey) private var category = SettingsCategory.account

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("设置").font(.system(size: 28, weight: .bold))
                Text("管理你的账号和助手偏好。").font(.system(size: 13)).foregroundStyle(Theme.muted).padding(.top, 6)
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
                        }
                    }
                    .frame(width: 174)
                    Group {
                        switch category {
                        case .account: AccountPane()
                        case .model: if let ws = model.workspace { SettingsModelPane(workspace: ws) }
                        case .memory: if let ws = model.workspace { SettingsMemoryPane(workspace: ws) }
                        case .system: SystemPane()
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.top, 32)
            }
            .padding(.horizontal, 40).padding(.vertical, 34)
        }
        .frame(width: 900, height: 640)
        .background(Theme.background)
    }
}

/// "10/18 05:55", as in the web UI.
private func stamp(_ date: Date) -> String {
    let f = DateFormatter(); f.dateFormat = "M/d HH:mm"; return f.string(from: date)
}

@MainActor private func paneHeader(_ title: String, _ detail: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
        Text(title).font(.system(size: 20, weight: .bold))
        Text(detail).font(.system(size: 12)).foregroundStyle(Theme.muted)
        Hairline().padding(.top, 14)
    }
}

@MainActor private func infoRow(_ label: String, _ value: String, mono: Bool = false) -> some View {
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

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            paneHeader("账号与登录设备", "管理个人身份，以及可以访问这个工作区的登录设备。")
            HStack(spacing: 14) {
                Circle().fill(Color(hex: 0x3B66E8)).frame(width: 44, height: 44)
                    .overlay(Image(systemName: "person").font(.system(size: 20)).foregroundStyle(.white))
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.workspace?.account?.displayName ?? "NexorAI 账号").font(.system(size: 15, weight: .semibold))
                    Text("NexorAI 账号 · 已认证").font(.system(size: 11)).foregroundStyle(Theme.muted)
                }
                Spacer()
                OutlineButton(title: "退出登录") { Task { await model.logout() } }
            }
            .padding(.top, 20)
            VStack(alignment: .leading, spacing: 18) {
                infoRow("工作区", "个人工作空间")
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

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("登录设备").font(.system(size: 13, weight: .semibold))
                Spacer()
                Text("\(workspace.sessions.count) 个有效登录").font(.system(size: 10)).foregroundStyle(Theme.muted)
                    .padding(.horizontal, 8).padding(.vertical, 4).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 5))
            }
            .padding(.top, 24)
            Text("移除不再使用的登录，即可撤销该设备对工作区的访问。").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.top, 14)
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
            if workspace.sessions.isEmpty { Text("正在加载…").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.top, 14) }
            if let error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).padding(.top, 10) }
        }
        .task { load() }
    }

    private func load() {
        Task {
            do { try await workspace.loadSessions(); error = nil }
            catch { self.error = message(of: error) }
        }
    }

    private func revoke(_ id: String) {
        Task {
            do { try await workspace.revokeSession(id); error = nil }
            catch { self.error = message(of: error) }
        }
    }
}

private struct SystemPane: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            paneHeader("系统信息", "查看当前连接和数据存储方式。")
            Text("服务连接").font(.system(size: 13, weight: .semibold)).padding(.top, 24)
            VStack(alignment: .leading, spacing: 18) {
                infoRow("Core 地址", model.credential?.origin ?? model.origin, mono: true)
                infoRow("此设备名称", model.credential?.name ?? model.deviceName)
                infoRow("应用版本", model.appVersion)
                infoRow("客户端协议", "v1")
            }
            .padding(.top, 20).padding(.bottom, 26)
            Hairline()
            Text("数据与隐私").font(.system(size: 13, weight: .semibold)).padding(.top, 24)
            Text("聊天、任务与配置保存在后端。桌面客户端只保存加密的登录资料。")
                .font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.top, 12)
        }
    }
}

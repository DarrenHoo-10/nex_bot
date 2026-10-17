import SwiftUI
import NexClientKit

/// Global settings, pushed from the account menu. Two categories, one shown at a time.
struct SettingsView: View {
    let model: AppModel
    let workspace: WorkspaceStore
    private enum Category: String, CaseIterable { case account = "账号与登录设备", system = "系统信息"
        var icon: String { self == .account ? "person" : "globe" } }
    @State private var category = Category.account
    @State private var confirmLogout = false
    @State private var revoking: ClientSession?
    @State private var errorText: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("设置").font(.largeTitle.weight(.bold))
                    Text("管理你的账号和助手偏好。").font(.subheadline).foregroundStyle(Theme.muted)
                }
                chips
                switch category {
                case .account: account
                case .system: system
                }
            }
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.background)
        .navigationTitle("设置")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .task { await load() }
        .refreshable { await load() }
        .errorAlert($errorText)
        .confirmationDialog("退出登录？", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("退出登录", role: .destructive) { Task { await model.logout() } }
        } message: {
            Text("将删除此设备上保存的登录信息。")
        }
        .confirmationDialog("撤销该设备的登录？", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible, presenting: revoking) { session in
            Button("撤销「\(session.name)」", role: .destructive) {
                Task {
                    do { try await workspace.revokeSession(session.sessionID) }
                    catch { errorText = (error as? CoreError)?.message ?? error.localizedDescription }
                }
            }
        }
    }

    private var chips: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
            ForEach(Category.allCases, id: \.self) { item in
                let selected = item == category
                Button { category = item } label: {
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
            heading("账号与登录设备", "管理 NexorAI 账号登录状态以及可访问此工作区的设备。")
            HStack(spacing: 12) {
                AccountAvatar(size: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text(accountName(workspace)).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text("NexorAI 账号 · 已认证").font(.caption).foregroundStyle(Theme.muted)
                }
                Spacer()
                Button("退出登录") { confirmLogout = true }.buttonStyle(PillButtonStyle())
            }
            .padding(14).cardStyle()
            VStack(spacing: 0) {
                row("工作区", "个人工作空间")
                Divider().overlay(Theme.border)
                row("本次登录有效期", model.credential.map { Self.date(Date(timeIntervalSince1970: $0.expiresAt / 1000)) } ?? "—")
            }
            .padding(.horizontal, 14).cardStyle()
            Text("登录设备").font(.subheadline.weight(.semibold))
            VStack(spacing: 10) {
                ForEach(workspace.sessions) { session in sessionCard(session) }
                if workspace.sessions.isEmpty { Text("正在加载…").font(.footnote).foregroundStyle(Theme.muted) }
            }
        }
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
            VStack(alignment: .leading, spacing: 2) {
                if let seen = session.lastSeenAt { Text("最近活动 \(seen.formatted(Date.RelativeFormatStyle(presentation: .named).locale(Locale(identifier: "zh_CN"))))") }
                if let end = session.expiresAt { Text("到期时间 \(Self.date(end))") }
            }
            .font(.caption).foregroundStyle(Theme.muted)
            if !current {
                Button("撤销登录") { revoking = session }.buttonStyle(PillButtonStyle(danger: true))
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading).cardStyle()
    }

    // MARK: System

    private var system: some View {
        VStack(alignment: .leading, spacing: 20) {
            heading("系统信息", "当前连接的服务与应用版本。")
            VStack(spacing: 0) {
                row("Core 地址", model.credential?.origin ?? model.origin)
                Divider().overlay(Theme.border)
                row("此设备名称", model.credential?.name ?? model.deviceName)
                Divider().overlay(Theme.border)
                row("版本", model.appVersion)
                Divider().overlay(Theme.border)
                row("客户端协议", "v1")
            }
            .padding(.horizontal, 14).cardStyle()
        }
    }

    // MARK: Pieces

    private func heading(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.title3.weight(.bold))
            Text(detail).font(.footnote).foregroundStyle(Theme.muted)
            Divider().overlay(Theme.border).padding(.top, 8)
        }
    }

    private func row(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.subheadline)
            Spacer(minLength: 16)
            Text(value).font(.subheadline).foregroundStyle(Theme.muted).multilineTextAlignment(.trailing).textSelection(.enabled)
        }
        .padding(.vertical, 12)
    }

    private static func date(_ date: Date) -> String { date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(Locale(identifier: "zh_CN"))) }

    private func load() async {
        do { try await workspace.loadSessions() }
        catch { errorText = (error as? CoreError)?.message ?? error.localizedDescription }
    }
}

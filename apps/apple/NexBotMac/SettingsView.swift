import SwiftUI
import NexClientKit

struct SettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Form {
            Section("账号") {
                LabeledContent("Core 地址", value: model.credential?.origin ?? model.origin)
                LabeledContent("此设备名称", value: model.credential?.name ?? model.deviceName)
                if let credential = model.credential {
                    LabeledContent("会话有效期至", value: Date(timeIntervalSince1970: credential.expiresAt / 1000).formatted(date: .abbreviated, time: .shortened))
                } else {
                    Text("未登录").foregroundStyle(.secondary)
                }
            }
            if let workspace = model.workspace {
                SessionsSection(workspace: workspace)
                Section {
                    Button("退出登录", role: .destructive) { Task { await model.logout() } }
                }
            }
            Section("关于") {
                LabeledContent("版本", value: model.appVersion)
            }
        }
        .formStyle(.grouped)
        .frame(width: 520, height: 520)
    }
}

private struct SessionsSection: View {
    let workspace: WorkspaceStore
    @State private var error: String?

    var body: some View {
        Section {
            ForEach(workspace.sessions) { session in
                let current = session.sessionID == workspace.currentSessionID
                HStack {
                    Image(systemName: current ? "laptopcomputer" : "desktopcomputer")
                    VStack(alignment: .leading) {
                        HStack(spacing: 6) {
                            Text(session.name.isEmpty ? "未命名设备" : session.name)
                            if current { Text("当前").font(.caption2).padding(.horizontal, 5).padding(.vertical, 1).background(Color.accentColor.opacity(0.2), in: Capsule()) }
                        }
                        if let seen = session.lastSeenAt {
                            Text("最近活动 \(seen.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    if !current {
                        Button("撤销", role: .destructive) { revoke(session.sessionID) }
                    }
                }
            }
            if workspace.sessions.isEmpty { Text("正在加载…").foregroundStyle(.secondary) }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        } header: {
            HStack {
                Text("已登录的设备")
                Spacer()
                Button { load() } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.borderless)
            }
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

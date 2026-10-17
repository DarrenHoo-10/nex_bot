import SwiftUI
import NexClientKit

struct SettingsView: View {
    let model: AppModel
    let workspace: WorkspaceStore
    @State private var confirmLogout = false
    @State private var revoking: ClientSession?
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            List {
                Section("账号") {
                    LabeledContent("Core 地址", value: model.credential?.origin ?? model.origin)
                    LabeledContent("此设备", value: model.credential?.name ?? model.deviceName)
                }
                Section("已登录的设备") {
                    ForEach(workspace.sessions) { session in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(session.name.isEmpty ? "未命名设备" : session.name)
                                if let seen = session.lastSeenAt {
                                    Text("最近活动 \(seen.formatted(.relative(presentation: .named)))").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            if session.sessionID == workspace.currentSessionID {
                                Text("当前").font(.caption).padding(.horizontal, 8).padding(.vertical, 2)
                                    .background(Color.accentColor.opacity(0.15), in: Capsule())
                            }
                        }
                        .swipeActions {
                            if session.sessionID != workspace.currentSessionID {
                                Button("撤销", role: .destructive) { revoking = session }
                            }
                        }
                    }
                    if workspace.sessions.isEmpty { Text("正在加载…").foregroundStyle(.secondary) }
                }
                Section {
                    Button("退出登录", role: .destructive) { confirmLogout = true }
                }
                Section { LabeledContent("版本", value: model.appVersion) }
            }
            .navigationTitle("设置")
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
    }

    private func load() async {
        do { try await workspace.loadSessions() }
        catch { errorText = (error as? CoreError)?.message ?? error.localizedDescription }
    }
}

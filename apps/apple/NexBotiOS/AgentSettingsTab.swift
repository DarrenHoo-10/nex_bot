import SwiftUI
import NexClientKit

/// Agent detail 设置 tab: about (bot身份信息), capabilities, usage, export and archive.
struct AgentSettingsTab: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(Navigation.self) private var nav
    @Environment(ContactPreferences.self) private var preferences
    @State private var showIdentity = false
    @State private var showPolicy = false
    @State private var confirmArchive = false
    @State private var copied = false
    @State private var archiving = false
    @State private var errorText: String?

    private var bot: Bot? { workspace.bot(botID) }
    private var state: WorkspaceState? { workspace.state }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            group("关于") {
                Button { showIdentity = true } label: {
                    HStack {
                        Text("bot身份信息").font(.subheadline)
                        Spacer()
                        Image(systemName: "chevron.right").font(.footnote).foregroundStyle(Theme.muted)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(Theme.brand)
                .padding(14).frame(maxWidth: .infinity, alignment: .leading).cardStyle()
            }

            group("能力") {
                row("驱动模型") {
                    Button { nav.openSettings(.model) } label: {
                        Text(state?.config?.defaultModel.isEmpty == false ? state!.config!.defaultModel : "未连接模型")
                            .font(.caption.weight(.medium)).lineLimit(1)
                            .padding(.horizontal, 10).padding(.vertical, 4)
                            .background(Theme.secondary, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
                row("工具权限", icon: "shield") {
                    Button { showPolicy = true } label: { Text(PolicyCatalog.summary(count: bot?.policyTools.count ?? 0)).font(.footnote) }
                        .buttonStyle(.plain).foregroundStyle(Theme.brand)
                }
            }

            group("用量") {
                let usage = state?.usage(botID: botID)
                row("累计调用") { Text("\(usage?.calls ?? 0) 次").font(.footnote) }
                row("输入 Token") { Text((usage?.inputTokens ?? 0).formatted()).font(.footnote) }
                row("输出 Token") { Text((usage?.outputTokens ?? 0).formatted()).font(.footnote) }
            }

            VStack(alignment: .leading, spacing: 12) {
                if let transcript = workspace.exportTranscript(botID: botID) {
                    HStack(spacing: 8) {
                        Button(copied ? "已复制记录" : "导出记录") {
                            UIPasteboard.general.string = transcript
                            copied = true
                            Task { try? await Task.sleep(for: .seconds(1.8)); copied = false }
                        }
                        .buttonStyle(PillButtonStyle())
                        ShareLink(item: transcript) { Image(systemName: "square.and.arrow.up").font(.footnote.weight(.semibold)) }
                            .buttonStyle(PillButtonStyle())
                            .accessibilityLabel("分享对话记录")
                    }
                }
                Button("归档 Agent") { confirmArchive = true }
                    .font(.footnote.weight(.semibold)).foregroundStyle(Theme.danger).buttonStyle(.plain)
                    .disabled(archiving)
            }
        }
        .sheet(isPresented: $showIdentity) { AgentEditorSheet(workspace: workspace, botID: botID) }
        .sheet(isPresented: $showPolicy) { PolicyEditorSheet(workspace: workspace, botID: botID) }
        .alert("归档这个 Agent？", isPresented: $confirmArchive) {
            Button("取消", role: .cancel) {}
            Button("确认", role: .destructive) { Task { await archive() } }
        } message: {
            Text("保留消息与记忆，停用例行任务。")
        }
        .errorAlert($errorText)
        .debugCommand { command, _ in
            switch command {
            case "policy": showPolicy = true
            case "archive": confirmArchive = true
            case "archiveconfirm": Task { await archive() }
            case "identity": showIdentity = true
            default: break
            }
        }
    }

    private func archive() async {
        confirmArchive = false
        archiving = true
        defer { archiving = false }
        do {
            try await workspace.archiveAgent(botID: botID)
            nav.path = []
        } catch { errorText = message(of: error) }
    }

    private func group<C: View>(_ title: String, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.footnote.weight(.bold))
            content()
        }
    }

    private func row<T: View>(_ title: String, icon: String? = nil, @ViewBuilder trailing: () -> T) -> some View {
        HStack(spacing: 8) {
            if let icon { Image(systemName: icon).foregroundStyle(Theme.muted) }
            Text(title).font(.subheadline)
            Spacer(minLength: 12)
            trailing()
        }
        .padding(.vertical, 2)
    }
}

import SwiftUI
import NexClientKit

/// Inspector 设置 tab: about (bot身份信息), capabilities, usage, export and archive.
struct InspectorSettingsTab: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(UIState.self) private var ui
    @State private var exported = false
    @State private var confirmArchive = false
    @State private var error: String?

    private var bot: Bot? { workspace.bot(botID) }

    var body: some View {
        let usage = workspace.state?.usage(botID: botID)
        VStack(alignment: .leading, spacing: 20) {
            Text("助手设置").font(.system(size: 12, weight: .bold))

            group("关于") {
                Button { AgentUI.shared.editIdentity(botID) } label: {
                    Text("bot身份信息").font(.system(size: 12)).foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .fieldCard()
            }

            group("能力") {
                VStack(spacing: 12) {
                    row(symbol: "bolt", title: "驱动模型") {
                        pillButton(workspace.state?.config?.defaultModel.nilIfEmpty ?? "未连接模型") { ui.openSettings(.model) }
                    }
                    row(symbol: "shield", title: "工具权限") {
                        pillButton(PolicyCatalog.summary(count: bot?.policyTools.count ?? 0)) { AgentUI.shared.editPolicy(botID) }
                    }
                }
                .fieldCard()
            }

            group("用量") {
                HStack {
                    stat("累计调用", "\(usage?.calls ?? 0) 次")
                    stat("输入 Token", (usage?.inputTokens ?? 0).formatted())
                    stat("输出 Token", (usage?.outputTokens ?? 0).formatted())
                }
                .fieldCard(padding: 14)
            }

            if let error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled) }

            Hairline()
            HStack {
                if !workspace.conversation(for: botID).messages.isEmpty {
                    Button(action: export) {
                        Text(exported ? "已复制记录" : "导出记录").font(.system(size: 11)).foregroundStyle(Theme.muted).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
                Button { confirmArchive = true } label: {
                    Text("归档 Agent").font(.system(size: 11)).foregroundStyle(Theme.danger).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .alert("归档这个 Agent？", isPresented: $confirmArchive) {
            Button("取消", role: .cancel) {}.keyboardShortcut(.cancelAction)
            Button("确认", role: .destructive) { archive() }
        } message: { Text("保留消息与记忆，停用例行任务。") }
    }

    private func group<C: View>(_ title: String, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 12, weight: .semibold))
            content()
        }
    }

    private func row<C: View>(symbol: String, title: String, @ViewBuilder trailing: () -> C) -> some View {
        HStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 11)).foregroundStyle(Theme.muted).frame(width: 14)
            Text(title).font(.system(size: 12))
            Spacer(minLength: 6)
            trailing()
        }
    }

    private func pillButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(size: 11)).foregroundStyle(Theme.foreground).lineLimit(1)
                .padding(.horizontal, 9).padding(.vertical, 4).background(Theme.card, in: Capsule())
                .overlay(Capsule().strokeBorder(Theme.border)).contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(spacing: 6) {
            Text(label).font(.system(size: 10)).foregroundStyle(Theme.muted)
            Text(value).font(.system(size: 13, weight: .semibold))
        }
        .frame(maxWidth: .infinity)
    }

    private func export() {
        guard let text = workspace.exportTranscript(botID: botID) else { return }
        AgentUI.shared.copyToPasteboard(text)
        exported = true
        Task { try? await Task.sleep(for: .seconds(1.8)); exported = false }
    }

    private func archive() {
        error = nil
        Task {
            do { try await workspace.archiveAgent(botID: botID) } catch { self.error = message(of: error) }
        }
    }
}

fileprivate extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

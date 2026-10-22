import SwiftUI
import NexClientKit

/// Agent detail 设置 tab: about (bot身份信息), capabilities, usage, export and archive.
struct AgentSettingsTab: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(Navigation.self) private var nav
    @Environment(ContactPreferences.self) private var preferences
    @State private var showPolicy = false
    @State private var confirmArchive = false
    @State private var copied = false
    @State private var archiving = false
    @State private var errorText: String?
    @State private var showModels = false

    private var bot: Bot? { workspace.bot(botID) }
    private var state: WorkspaceState? { workspace.state }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            group("关于") {
                IdentityField(workspace: workspace, botID: botID)
            }

            group("能力") {
                row("驱动模型") {
                    // Picks the assistant's model in place; 设置 only when nothing is connected.
                    Button { if state?.config == nil { nav.openSettings(.model) } else { showModels = true } } label: {
                        Text(bot?.selectedModel ?? (state?.config?.defaultModel.isEmpty == false ? state!.config!.defaultModel : "未连接模型"))
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
        .sheet(isPresented: $showPolicy) { PolicyEditorSheet(workspace: workspace, botID: botID) }
        .sheet(isPresented: $showModels) {
            ModelPickerSheet(title: "选择聊天模型", value: bot?.selectedModel ?? "", emptyLabel: "默认 · \(state?.config?.defaultModel ?? "")",
                             models: state?.modelVisibility.models, source: workspace.savedModelSource(), onSelect: setModel)
                .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
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

    private func setModel(_ next: String) {
        guard next != (bot?.selectedModel ?? "") else { return }
        Task { do { try await workspace.setAgentModel(botID: botID, model: next) } catch { errorText = message(of: error) } }
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

/// Inline bot identity (web `BotIdentity`): shows the instructions, tap to edit in place with 保存 / 取消.
private struct IdentityField: View {
    let workspace: WorkspaceStore
    let botID: String
    @State private var editing = false
    @State private var draft = ""
    @State private var pending = false
    @State private var errorText: String?
    @FocusState private var focused: Bool

    private var bot: Bot? { workspace.bot(botID) }
    private var text: String { bot?.instructions ?? "" }

    var body: some View {
        Group { if editing { editor } else { display } }
            .padding(14).frame(maxWidth: .infinity, alignment: .leading).cardStyle()
            .debugCommand { command, arg in
                switch command {
                case "identity": draft = text; errorText = nil; editing = true
                case "identityfill": draft = arg
                case "identitysave": Task { await save() }
                default: break
                }
            }
    }

    private var display: some View {
        Button { draft = text; errorText = nil; editing = true } label: {
            Text(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "bot身份信息" : text)
                .font(.subheadline).foregroundStyle(Theme.muted).multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("编辑 bot身份信息")
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("填写身份、职责与沟通方式", text: $draft, axis: .vertical)
                .lineLimit(5...10).font(.subheadline).focused($focused).disabled(pending)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Theme.background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border))
                .accessibilityLabel("bot身份信息")
            if let errorText { Text(errorText).font(.footnote).foregroundStyle(Theme.danger) }
            HStack(spacing: 8) {
                Button(pending ? "保存中…" : "保存") { Task { await save() } }
                    .buttonStyle(PillButtonStyle(primary: true)).disabled(pending)
                Button("取消") { editing = false }.buttonStyle(PillButtonStyle()).disabled(pending)
            }
        }
        .onAppear { focused = true }
    }

    private func save() async {
        guard !pending, let bot else { return }
        pending = true; errorText = nil
        defer { pending = false }
        do { try await workspace.updateIdentity(botID: botID, name: bot.name, instructions: draft); editing = false }
        catch { errorText = message(of: error) }
    }
}

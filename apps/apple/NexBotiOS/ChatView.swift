import SwiftUI
import NexClientKit

struct ChatView: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(\.scenePhase) private var scenePhase
    @Environment(Navigation.self) private var nav
    @State private var errorText: String?
    private let bottomID = "bottom"

    private var conversation: ConversationStore { workspace.conversation(for: botID) }
    private var bot: Bot? { workspace.bot(botID) }
    private var approvals: [Approval] { workspace.approvals.filter { $0.botID == botID } }

    var body: some View {
        let conv = conversation
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if conv.hasOlder {
                        ProgressView().frame(maxWidth: .infinity)
                            .onAppear { Task { await conv.loadOlder() } }
                    }
                    ForEach(Array(conv.messages.enumerated()), id: \.element.id) { index, message in
                        if let date = message.createdAt,
                           index == 0 || !Calendar.current.isDate(date, inSameDayAs: conv.messages[index - 1].createdAt ?? .distantPast) {
                            DateDivider(date: date)
                        }
                        MessageRow(message: message)
                    }
                    ForEach(conv.streaming, id: \.taskId) { part in
                        StreamingRow(text: part.text)
                    }
                    ForEach(approvals) { approval in
                        ApprovalCard(approval: approval, botName: bot?.name ?? "") { allow in await decide(approval, allow: allow) }
                    }
                    Color.clear.frame(height: 1).id(bottomID)
                }
                .padding(.horizontal, 16).padding(.vertical, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .overlay {
                if !conv.isLoaded { ProgressView() }
            }
            .onChange(of: conv.messages.last?.seq) { scrollToBottom(proxy) }
            .onChange(of: conv.streaming) { scrollToBottom(proxy) }
            .onChange(of: approvals.count) { scrollToBottom(proxy) }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let notice = workspace.notice { NoticeBanner(text: notice) }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ComposerView(conversation: conv, botName: bot?.name ?? "Agent")
        }
        .environment(\.openURL, OpenURLAction { Markdown.isOpenable($0) ? .systemAction : .discarded })
        .background(Theme.background)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { nav.openAgentDetail(botID) } label: { Image(systemName: "info.circle") }
                    .accessibilityLabel("Agent 资料")
            }
            ToolbarItem(placement: .principal) {
                Button { nav.openAgentDetail(botID) } label: {
                HStack(spacing: 8) {
                    if let bot { workspace.avatar(of: bot, size: 28) }
                    VStack(alignment: .leading, spacing: 0) {
                        Text(bot?.name ?? "会话").font(.subheadline.weight(.semibold)).lineLimit(1)
                        Text(status).font(.caption2).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(bot?.name ?? "Agent") 资料")
            }
        }
        .errorAlert($errorText)
        .onAppear {
            workspace.select(botID)
            conv.isActive = scenePhase == .active
        }
        .onDisappear {
            conv.isActive = false
            if workspace.selectedBotID == botID { workspace.select(nil) }
        }
        .onChange(of: scenePhase) { conv.isActive = scenePhase == .active }
        .onChange(of: conv.messages.last?.seq) { Task { await conv.markReadIfNeeded() } }
    }

    private var status: String {
        let phrase = conversation.activeTask?.phrase ?? ""
        return phrase.isEmpty ? workspace.companionState(of: botID).label : phrase
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomID, anchor: .bottom) }
    }

    private func decide(_ approval: Approval, allow: Bool) async {
        do { try await workspace.decide(approval, allow: allow) } catch { errorText = (error as? CoreError)?.message ?? error.localizedDescription }
    }
}

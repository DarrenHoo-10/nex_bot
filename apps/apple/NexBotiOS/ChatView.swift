import SwiftUI
import NexClientKit

struct ChatView: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(\.scenePhase) private var scenePhase
    @State private var errorText: String?
    private let bottomID = "bottom"

    private var conversation: ConversationStore { workspace.conversation(for: botID) }
    private var approvals: [Approval] { workspace.approvals.filter { $0.botID == botID } }

    var body: some View {
        let conv = conversation
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if conv.hasOlder {
                        ProgressView().frame(maxWidth: .infinity)
                            .onAppear { Task { await conv.loadOlder() } }
                    }
                    ForEach(conv.messages) { message in
                        MessageRow(message: message)
                    }
                    ForEach(conv.streaming, id: \.taskId) { part in
                        StreamingRow(text: part.text)
                    }
                    ForEach(approvals) { approval in
                        ApprovalCard(approval: approval) { allow in await decide(approval, allow: allow) }
                    }
                    Color.clear.frame(height: 1).id(bottomID)
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
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
            ComposerView(conversation: conv)
        }
        .environment(\.openURL, OpenURLAction { Markdown.isOpenable($0) ? .systemAction : .discarded })
        .navigationTitle(workspace.bot(botID)?.name ?? "会话")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(workspace.bot(botID)?.name ?? "会话").font(.headline)
                    if let phrase = conv.activeTask?.phrase, !phrase.isEmpty {
                        Text(phrase).font(.caption2).foregroundStyle(.secondary)
                    }
                }
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

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomID, anchor: .bottom) }
    }

    private func decide(_ approval: Approval, allow: Bool) async {
        do { try await workspace.decide(approval, allow: allow) } catch { errorText = (error as? CoreError)?.message ?? error.localizedDescription }
    }
}

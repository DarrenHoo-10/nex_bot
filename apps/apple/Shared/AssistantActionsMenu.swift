import SwiftUI
import NexClientKit

private struct LifecyclePreview: Decodable, Sendable {
    struct Counts: Decodable, Sendable { let messages, conversations, routines, todos: Int }
    let previewId, name: String
    let counts: Counts
    let blocked: Bool
}
private struct LifecycleResult: Decodable, Sendable { let status: String }

struct AssistantActionsMenu: View {
    let workspace: WorkspaceStore
    let bot: Bot
    @State private var preview: LifecyclePreview?
    @State private var deleting = false
    @State private var busy = false
    @State private var confirming = false
    @State private var notice: String?
    @State private var requestID = UUID().uuidString

    var body: some View {
        Menu {
            Button("重置记忆") { load(false) }
            Button("删除助手", role: .destructive) { load(true) }
        } label: {
            Image(systemName: "ellipsis").frame(width: 30, height: 24).contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        #if os(macOS)
        .menuIndicator(.hidden)
        #endif
        .fixedSize().disabled(busy)
        .accessibilityLabel("\(bot.name)的操作")
        .alert(deleting ? "永久删除「\(bot.name)」？" : "重置「\(bot.name)」的记忆？", isPresented: $confirming, presenting: preview) { ticket in
            Button("取消", role: .cancel) {}
            Button(deleting ? "删除助手" : "重置记忆", role: .destructive) { execute(ticket) }
        } message: { ticket in
            Text(deleting ? "将删除 \(ticket.counts.conversations) 个会话及 \(ticket.counts.routines) 条定时规则，解除 \(ticket.counts.todos) 项待办指派。此操作无法撤销。" :
                    "将清空 \(ticket.counts.messages) 条聊天消息和全部私有记忆。旧聊天无法再查看，共享记忆保留。")
        }
        .alert("助手操作", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) { Button("关闭") { notice = nil } } message: { Text(notice ?? "") }
    }
    private func load(_ remove: Bool) {
        guard !busy else { return }
        deleting = remove; busy = true
        Task {
            defer { busy = false }
            do {
                let ticket: LifecyclePreview = try await workspace.client.post("/api/bots/lifecycle/preview", body: ["botId": bot.id, "action": remove ? "delete" : "reset_memory"])
                if ticket.blocked { notice = "请先停止并核对该助手的未结束工作。"; return }
                preview = ticket; requestID = UUID().uuidString; confirming = true
            } catch { notice = error.localizedDescription }
        }
    }
    private func execute(_ ticket: LifecyclePreview) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let _: LifecycleResult = try await workspace.client.post("/api/bots/lifecycle/execute", body: ["requestId": requestID, "previewId": ticket.previewId])
                await workspace.refresh()
            } catch { notice = error.localizedDescription }
        }
    }
}

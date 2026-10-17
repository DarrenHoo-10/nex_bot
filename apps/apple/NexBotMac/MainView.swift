import SwiftUI
import NexClientKit

struct MainView: View {
    let workspace: WorkspaceStore
    @State private var columns: NavigationSplitViewVisibility = .all

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            ContactsList(workspace: workspace)
                .navigationSplitViewColumnWidth(min: 220, ideal: 270, max: 360)
        } content: {
            Group {
                if let id = workspace.selectedBotID, workspace.bot(id) != nil {
                    ConversationView(workspace: workspace, botID: id).id(id)
                } else {
                    ContentUnavailableView(workspace.bots.isEmpty && workspace.state != nil ? "还没有 Agent" : "选择一个 Agent",
                                           systemImage: "bubble.left.and.bubble.right",
                                           description: Text(workspace.bots.isEmpty && workspace.state != nil ? "请先在 Core 中创建 Agent。" : "从左侧选择会话。"))
                }
            }
            .navigationSplitViewColumnWidth(min: 380, ideal: 560)
            .safeAreaInset(edge: .top, spacing: 0) { NoticeBanner(workspace: workspace) }
        } detail: {
            InspectorView(workspace: workspace)
                .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 420)
        }
        #if DEBUG
        .task { await runDebugCommands(workspace: workspace) }
        #endif
        .onChange(of: workspace.bots.first?.id, initial: true) {
            if workspace.selectedBotID == nil, let first = workspace.bots.first { workspace.select(first.id) }
        }
    }
}

struct NoticeBanner: View {
    let workspace: WorkspaceStore

    var body: some View {
        if let notice = workspace.notice {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(notice).font(.callout)
                Spacer()
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(.regularMaterial)
            .overlay(alignment: .bottom) { Divider() }
            .accessibilityIdentifier("connection-notice")
        }
    }
}

/// Core's message text for an error (CoreError.wrap is internal to the kit).
func message(of error: Error) -> String {
    CoreError.wrap(error).message
}

#if DEBUG
/// DEBUG-only automation: when NEXBOT_DEBUG_COMMAND_FILE is set, the file is polled and consumed line by line.
/// Commands: `select <agent name>`, `send <text>`, `approve`, `deny`, `stop`. Lets fixture runs be scripted without accessibility access.
@MainActor func runDebugCommands(workspace: WorkspaceStore) async {
    guard let path = ProcessInfo.processInfo.environment["NEXBOT_DEBUG_COMMAND_FILE"] else { return }
    while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(400))
        guard let text = try? String(contentsOfFile: path, encoding: .utf8), !text.isEmpty else { continue }
        try? "".write(toFile: path, atomically: true, encoding: .utf8)
        for line in text.split(separator: "\n") {
            let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
            let arg = parts.count > 1 ? parts[1] : ""
            switch parts.first {
            case "select": if let bot = workspace.bots.first(where: { $0.name == arg }) { workspace.select(bot.id) }
            case "send": if let id = workspace.selectedBotID { await workspace.conversation(for: id).send(text: arg) }
            case "approve", "deny": if let a = workspace.approvals.first { try? await workspace.decide(a, allow: parts.first == "approve") }
            case "stop": if let id = workspace.selectedBotID { await workspace.conversation(for: id).stop() }
            default: break
            }
        }
    }
}
#endif

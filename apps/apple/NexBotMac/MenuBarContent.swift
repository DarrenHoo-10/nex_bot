import SwiftUI
import AppKit
import NexClientKit

struct MenuBarLabel: View {
    let count: Int

    var body: some View {
        if count > 0 {
            Label("\(count)", systemImage: "bell.badge.fill")
        } else {
            Label("NexBot", systemImage: "bubble.left.and.bubble.right")
        }
    }
}

struct MenuBarContent: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if let workspace = model.workspace {
            let approvals = workspace.approvals
            Text(approvals.isEmpty ? "没有待批准的操作" : "待批准 \(approvals.count) 项")
            ForEach(approvals) { approval in
                Button("\(workspace.bot(approval.botID)?.name ?? "Agent") · \(approval.title)") {
                    workspace.select(approval.botID)
                    show()
                }
            }
        } else {
            Text("未连接")
        }
        Divider()
        Button("打开 NexBot") { show() }
        Button("退出 NexBot") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }

    private func show() {
        openWindow(id: "main")
        NSApp.activate(ignoringOtherApps: true)
    }
}

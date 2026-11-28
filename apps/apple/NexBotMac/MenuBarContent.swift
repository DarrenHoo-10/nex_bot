import SwiftUI
import AppKit
import NexClientKit

struct MenuBarLabel: View {
    let count: Int
    var paused: Bool = false

    var body: some View {
        if count > 0 {
            Label("\(count)", systemImage: "bell.badge.fill")
        } else if paused {
            Label("NexBot · 已暂停", systemImage: "pause.circle")
        } else {
            Label("NexBot", systemImage: "bubble.left.and.bubble.right")
        }
    }
}

struct MenuBarContent: View {
    @Environment(AppModel.self) private var model
    @Environment(UIState.self) private var ui
    @Environment(LocalDeviceController.self) private var device
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if let workspace = model.workspace {
            let approvals = workspace.approvals
            Text(approvals.isEmpty ? "没有待批准的操作" : "待批准 \(approvals.count) 项")
            ForEach(approvals) { approval in
                Button("\(workspace.bot(approval.botID)?.name ?? "Agent") · \(approval.title)") {
                    ui.todosVisible = false
                    ui.agentsVisible = false
                    workspace.select(approval.botID)
                    show()
                }
            }
            if device.state.available && device.state.authorized {
                Divider()
                let paused = device.state.paused
                Text(paused ? "本机控制 · 已暂停" : (device.state.connected ? "本机控制 · 在线" : "本机控制 · 连接中"))
                Button(paused ? "恢复本机控制" : "暂停本机控制") {
                    Task { try? await device.setPaused(!paused) }
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
        NSApp.activate()
    }
}

import SwiftUI
import NexClientKit

/// The account menu card (settings, dark mode, logout).
struct AccountMenu: View {
    let dark: Bool
    /// Trailing counts: enabled connectors and online devices (hidden when 0).
    var connectorCount = 0
    var deviceCount = 0
    let openConnectors: () -> Void
    let openDevices: () -> Void
    let openSettings: () -> Void
    let toggleDark: () -> Void
    let logout: () -> Void

    var body: some View {
        VStack(spacing: 2) {
            MenuItem(icon: "puzzlepiece.extension", title: "连接器", trailing: connectorCount > 0 ? "\(connectorCount)" : nil, action: openConnectors)
            MenuItem(icon: "desktopcomputer", title: "设备", trailing: deviceCount > 0 ? "\(deviceCount)" : nil, action: openDevices)
            item("gearshape", "设置", openSettings)
            item("moon", dark ? "切换浅色模式" : "切换深色模式", toggleDark)
            Hairline().padding(.vertical, 6).padding(.horizontal, 6)
            item("rectangle.portrait.and.arrow.right", "退出当前账号", logout)
        }
        .padding(8)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.border))
        .shadow(color: .black.opacity(0.12), radius: 14, y: 4)
    }

    private func item(_ icon: String, _ title: String, _ action: @escaping () -> Void) -> some View {
        MenuItem(icon: icon, title: title, action: action)
    }
}

private struct MenuItem: View {
    let icon: String, title: String
    var trailing: String?
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.system(size: 13)).foregroundStyle(Theme.muted).frame(width: 18)
                Text(title).font(.system(size: 12))
                Spacer()
                if let trailing { Text(trailing).font(.system(size: 11)).foregroundStyle(Theme.muted) }
            }
            .padding(.horizontal, 10).frame(height: 36)
            .background(hover ? Theme.secondary : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

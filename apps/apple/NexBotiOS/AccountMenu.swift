import SwiftUI
import NexClientKit

/// The account drawer of the web UI as a sheet: settings, dark mode toggle and logout.
struct AccountMenu: View {
    let model: AppModel
    @Bindable var nav: Navigation
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage(AppearanceMode.key) private var mode = AppearanceMode.system.rawValue
    @State private var confirmLogout = false

    var body: some View {
        VStack(spacing: 14) {
            VStack(spacing: 0) {
                item("gearshape", "设置") { nav.openSettings() }
                item(colorScheme == .dark ? "sun.max" : "moon", colorScheme == .dark ? "切换浅色模式" : "切换深色模式") {
                    mode = (colorScheme == .dark ? AppearanceMode.light : .dark).rawValue
                }
                Divider().overlay(Theme.border).padding(.horizontal, 12).padding(.vertical, 4)
                item("rectangle.portrait.and.arrow.right", "退出当前账号") { confirmLogout = true }
            }
            .padding(6)
            .cardStyle()
            HStack(spacing: 10) {
                AccountAvatar(size: 36, initial: accountInitial(model.workspace))
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.workspace.map(accountName) ?? "NexorAI 账号").font(.subheadline.weight(.semibold)).lineLimit(1)
                }
                Spacer()
                Image(systemName: "chevron.up").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
            }
            .padding(12)
            .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .padding(.horizontal, 16).padding(.top, 20).padding(.bottom, 8)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.sidebar)
        .foregroundStyle(Theme.foreground)
        .presentationDetents([.height(340)])
        .presentationDragIndicator(.visible)
        .presentationBackground(Theme.sidebar)
        .sheet(isPresented: $confirmLogout) { LogoutConfirmationSheet(model: model, isPresented: $confirmLogout) }
        .onDebugUI { cmd, _ in if cmd == "menulogout" { confirmLogout = true } }
    }

    private func item(_ icon: String, _ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon).frame(width: 22).foregroundStyle(Theme.muted)
                Text(title).font(.subheadline.weight(.medium))
                Spacer()
            }
            .padding(.horizontal, 12).padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

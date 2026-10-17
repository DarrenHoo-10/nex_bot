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
                item("gearshape", "设置") {
                    nav.showMenu = false
                    nav.path.append(.settings)
                }
                item(colorScheme == .dark ? "sun.max" : "moon", colorScheme == .dark ? "切换浅色模式" : "切换深色模式") {
                    mode = (colorScheme == .dark ? AppearanceMode.light : .dark).rawValue
                }
                Divider().overlay(Theme.border).padding(.horizontal, 12).padding(.vertical, 4)
                item("rectangle.portrait.and.arrow.right", "退出当前账号") { confirmLogout = true }
            }
            .padding(6)
            .cardStyle()
            HStack(spacing: 10) {
                AccountAvatar(size: 36)
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.workspace.map(accountName) ?? "NexorAI 账号").font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text("个人工作空间").font(.caption).foregroundStyle(Theme.muted)
                }
                Spacer()
            }
            .padding(12)
            .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .padding(.horizontal, 16).padding(.top, 20).padding(.bottom, 8)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.sidebar)
        .foregroundStyle(Theme.foreground)
        .presentationDetents([.height(330)])
        .presentationDragIndicator(.visible)
        .presentationBackground(Theme.sidebar)
        .confirmationDialog("退出当前账号？", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("退出登录", role: .destructive) {
                nav.showMenu = false
                Task { await model.logout() }
            }
        } message: {
            Text("将删除此设备上保存的登录信息。")
        }
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

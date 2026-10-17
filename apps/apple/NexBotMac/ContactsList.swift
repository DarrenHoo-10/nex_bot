import SwiftUI
import NexClientKit

/// The sidebar of the web UI: brand, search, contacts and the account card.
struct ContactsList: View {
    let workspace: WorkspaceStore
    @Environment(UIState.self) private var ui
    @Environment(AppModel.self) private var model
    @State private var query = ""

    private var contacts: [Bot] {
        let q = query.trimmingCharacters(in: .whitespaces)
        return q.isEmpty ? workspace.bots : workspace.bots.filter { $0.name.localizedCaseInsensitiveContains(q) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                BrandMark(size: 26)
                Text("NexBot").font(.system(size: 15, weight: .bold))
                Spacer()
            }
            .padding(.horizontal, 22).padding(.top, 38).padding(.bottom, 14)

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(Theme.muted)
                TextField("搜索联系人", text: $query).textFieldStyle(.plain).font(.system(size: 12))
            }
            .padding(.horizontal, 12).frame(height: 34)
            .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .padding(.horizontal, 12)

            HStack {
                Text("对话")
                Spacer()
                Text("\(workspace.bots.count)")
            }
            .font(.system(size: 12)).foregroundStyle(Theme.muted)
            .padding(.horizontal, 22).padding(.top, 18).padding(.bottom, 8)

            if workspace.state == nil {
                VStack(spacing: 10) {
                    ProgressView()
                    Text(workspace.notice ?? "正在连接…").font(.system(size: 12)).foregroundStyle(Theme.muted)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(contacts) { bot in
                            Button { workspace.select(bot.id) } label: {
                                ContactRow(bot: bot, appearance: workspace.appearance(bot), state: workspace.companionState(bot.id),
                                           phrase: ToolLabels.taskPhrase(workspace.state?.unfinishedTask(botID: bot.id)),
                                           selected: workspace.selectedBotID == bot.id)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(bot.name)
                        }
                    }
                    .padding(.horizontal, 12)
                }
            }
            Spacer(minLength: 0)
            Hairline().padding(.horizontal, 12)
            accountCard
        }
        .background(Theme.sidebar)
    }

    private var accountCard: some View {
        Button { ui.accountMenuOpen.toggle() } label: {
            HStack(spacing: 10) {
                PersonAvatar(size: 34)
                VStack(alignment: .leading, spacing: 2) {
                    Text(accountName).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                    Text("个人工作空间").font(.system(size: 10)).foregroundStyle(Theme.muted)
                }
                Spacer()
                Image(systemName: ui.accountMenuOpen ? "chevron.down" : "chevron.up").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 10).frame(height: 54)
            .background(ui.accountMenuOpen ? Theme.secondary : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .accessibilityLabel("账号菜单")
    }

    private var accountName: String { workspace.account?.displayName ?? "NexorAI 账号" }
}

struct ContactRow: View {
    let bot: Bot
    let appearance: AgentAppearance
    let state: CompanionState
    let phrase: String
    let selected: Bool

    var body: some View {
        HStack(spacing: 12) {
            AgentAvatar(appearance: appearance, state: state, size: 36)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(bot.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Spacer(minLength: 4)
                    if let at = bot.lastMessageAt {
                        Text(Self.format(at)).font(.system(size: 10)).foregroundStyle(Theme.muted)
                    }
                }
                HStack(spacing: 6) {
                    if !phrase.isEmpty {
                        Text(phrase).font(.system(size: 11)).foregroundStyle(Theme.brand).lineLimit(1)
                    } else {
                        Text(Self.preview(bot.lastMessage)).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    if bot.unreadCount > 0 {
                        Text(bot.unreadCount > 99 ? "99+" : "\(bot.unreadCount)")
                            .font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.primaryForeground)
                            .frame(minWidth: 18, minHeight: 18).padding(.horizontal, bot.unreadCount > 9 ? 3 : 0)
                            .background(Theme.primary, in: Capsule())
                            .accessibilityLabel("\(bot.unreadCount) 条未读")
                    }
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 12)
        .background {
            if selected {
                RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.sidebarAccent)
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border.opacity(0.6)))
                    .shadow(color: .black.opacity(0.06), radius: 4, y: 1)
            }
        }
        .contentShape(Rectangle())
    }

    static func preview(_ text: String?) -> String {
        guard let text, !text.isEmpty else { return "暂无消息" }
        return text.replacingOccurrences(of: "\n", with: " ")
    }

    static func format(_ date: Date) -> String {
        Calendar.current.isDateInToday(date) ? date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute()) : date.formatted(.dateTime.month(.defaultDigits).day())
    }
}

/// The account menu card (settings, dark mode, logout).
struct AccountMenu: View {
    let dark: Bool
    let openSettings: () -> Void
    let toggleDark: () -> Void
    let logout: () -> Void

    var body: some View {
        VStack(spacing: 2) {
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
    let icon: String, title: String, action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.system(size: 13)).foregroundStyle(Theme.muted).frame(width: 18)
                Text(title).font(.system(size: 12))
                Spacer()
            }
            .padding(.horizontal, 10).frame(height: 36)
            .background(hover ? Theme.secondary : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

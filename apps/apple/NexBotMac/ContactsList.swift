import SwiftUI
import NexClientKit

/// The sidebar of the web UI: brand, search, contacts and the account card.
struct ContactsList: View {
    let workspace: WorkspaceStore
    @Environment(UIState.self) private var ui
    @Environment(AppModel.self) private var model
    @Environment(ContactPreferences.self) private var preferences

    private var query: String { ui.contactSearch }
    private var groups: (pinned: [Bot], rest: [Bot]) { preferences.groups(of: workspace.bots) }
    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var searching: Bool { !trimmedQuery.isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                BrandMark(size: 26)
                Text("NexBot").font(.system(size: 15, weight: .bold))
                Spacer()
                Button { AgentUI.shared.createAgent() } label: {
                    Image(systemName: "plus").font(.system(size: 15, weight: .regular)).foregroundStyle(Theme.foreground)
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain).help("添加 Agent").accessibilityLabel("添加 Agent")
                .disabled(workspace.state == nil)
            }
            .padding(.leading, 22).padding(.trailing, 14).padding(.top, 38).padding(.bottom, 14)

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(Theme.muted)
                TextField("搜索会话记录", text: Bindable(ui).contactSearch).textFieldStyle(.plain).font(.system(size: 12)).accessibilityLabel("搜索会话记录")
                    .onChange(of: query) { if query.count > ConversationSearch.maxLength { ui.contactSearch = String(query.prefix(ConversationSearch.maxLength)) } }
                if !query.isEmpty {
                    Button { ui.contactSearch = "" } label: {
                        Image(systemName: "xmark.circle.fill").font(.system(size: 12)).foregroundStyle(Theme.muted).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).help("清空搜索").accessibilityLabel("清空搜索")
                }
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
            } else if searching {
                ConversationSearchResults(workspace: workspace, query: trimmedQuery)
                    .id(SearchIdentity(query: trimmedQuery, sync: workspace.sync))
            } else {
                let g = groups
                ScrollView {
                    LazyVStack(spacing: 4) {
                        section("置顶", g.pinned)
                        section("我的 Agent", g.rest)
                        if g.pinned.isEmpty && g.rest.isEmpty {
                            VStack(spacing: 8) {
                                Text("你的 Agent 会出现在这里").font(.system(size: 12)).foregroundStyle(Theme.muted)
                                Button { AgentUI.shared.createAgent() } label: {
                                    Text("创建第一个 Agent").font(.system(size: 12)).foregroundStyle(Theme.brand).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                            .frame(maxWidth: .infinity).padding(.top, 28)
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
        .modifier(AgentSheetsHost(workspace: workspace))
        #if DEBUG
        .task { await runAgentDebugCommands(workspace: workspace, ui: ui, preferences: preferences) }
        #endif
    }

    @ViewBuilder private func section(_ title: String, _ bots: [Bot]) -> some View {
        if !bots.isEmpty {
            Text(title).font(.system(size: 11)).foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 2)
            ForEach(bots) { bot in
                Button { workspace.select(bot.id) } label: {
                    ContactRow(bot: bot, appearance: workspace.appearance(bot), state: workspace.companionState(bot.id),
                               phrase: ToolLabels.taskPhrase(workspace.state?.unfinishedTask(botID: bot.id)),
                               selected: workspace.selectedBotID == bot.id)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(bot.name)
            }
        }
    }

    private var accountCard: some View {
        Button { ui.accountMenuOpen.toggle() } label: {
            HStack(spacing: 10) {
                PersonAvatar(initial: workspace.account?.initial ?? "N", size: 34)
                VStack(alignment: .leading, spacing: 2) {
                    Text(accountName).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                    if workspace.connection != .connected { Text("正在重新连接…").font(.system(size: 10)).foregroundStyle(Theme.muted) }
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

/// A new search starts when the text changes or the account's history generation does (Core restarted, privacy reset).
private struct SearchIdentity: Hashable {
    let query: String
    let coreID: String?, bootID: String?, privacyEpoch: Int?
    init(query: String, sync: SyncIdentity?) {
        self.query = query; coreID = sync?.coreId; bootID = sync?.bootId; privacyEpoch = sync?.privacyEpoch
    }
}

struct ContactRow: View {
    let bot: Bot
    let appearance: AgentAppearance
    let state: CompanionState
    let phrase: String
    let selected: Bool
    @Environment(ContactPreferences.self) private var preferences

    var body: some View {
        HStack(spacing: 12) {
            // Sidebar contacts move only while thinking or working; idle and approval stay still.
            AgentAvatar(appearance: appearance, state: state, size: 40, animated: preferences.motionEnabled && (state == .thinking || state == .working))
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(bot.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Spacer(minLength: 4)
                    if let at = bot.lastMessageAt {
                        Text(TimeFormat.formatShortTime(at)).font(.system(size: 10)).foregroundStyle(Theme.muted)
                    }
                }
                HStack(spacing: 6) {
                    if !phrase.isEmpty {
                        Text(phrase).font(.system(size: 11)).foregroundStyle(Theme.brand).lineLimit(1)
                    } else {
                        Text(Self.preview(bot)).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1)
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

    /// Port of the web contact preview: last message, else the instructions, else 开始一段对话.
    static func preview(_ bot: Bot) -> String {
        if let text = bot.lastMessage, !text.isEmpty { return text.replacingOccurrences(of: "\n", with: " ") }
        if !bot.instructions.isEmpty { return bot.instructions.replacingOccurrences(of: "\n", with: " ") }
        return "开始一段对话"
    }
}

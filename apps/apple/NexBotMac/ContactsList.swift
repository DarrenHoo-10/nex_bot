import SwiftUI
import NexClientKit

/// The sidebar of the web UI: brand, search, contacts and the account card. It collapses to an avatar-only dock
/// (`UIState.railOpen`, persisted under `nexbot.rail`).
struct ContactsList: View {
    let workspace: WorkspaceStore
    @Environment(UIState.self) private var ui
    @Environment(AppModel.self) private var model
    @Environment(ContactPreferences.self) private var preferences
    @FocusState private var searchFocused: Bool
    @State private var focusSearchOnOpen = false

    private var collapsed: Bool { !ui.railOpen }
    private var query: String { ui.contactSearch }
    private var groups: (pinned: [Bot], rest: [Bot]) { preferences.groups(of: workspace.bots) }
    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var searching: Bool { !collapsed && !trimmedQuery.isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            searchField
            if !collapsed {
                HStack {
                    Text("对话")
                    Spacer()
                    Text("\(workspace.bots.count)")
                }
                .font(.system(size: 11)).foregroundStyle(Theme.muted)
                .padding(.horizontal, 10).padding(.top, 14).padding(.bottom, 6)
            }

            if workspace.state == nil {
                VStack(spacing: 10) {
                    ProgressView()
                    if !collapsed { Text(workspace.notice ?? "正在连接…").font(.system(size: 12)).foregroundStyle(Theme.muted) }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if searching {
                ConversationSearchResults(workspace: workspace, query: trimmedQuery)
                    .id(SearchIdentity(query: trimmedQuery, sync: workspace.sync))
            } else {
                let g = groups
                ScrollView {
                    LazyVStack(spacing: 0) {
                        section("置顶", g.pinned)
                        section("我的 Agent", g.rest)
                        if g.pinned.isEmpty && g.rest.isEmpty && !collapsed {
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
                }
                .scrollIndicators(.never)
                .padding(.horizontal, collapsed ? -11 : 0)
                if collapsed { dockAdd }
            }
            Spacer(minLength: 0)
            accountCard
        }
        .padding(.horizontal, collapsed ? 11 : 10).padding(.bottom, 10)
        .frame(maxHeight: .infinity)
        .modifier(AgentSheetsHost(workspace: workspace))
        .task(id: ui.railOpen) {
            guard ui.railOpen, focusSearchOnOpen else { return }
            focusSearchOnOpen = false
            try? await Task.sleep(for: .milliseconds(80))
            searchFocused = true
        }
        #if DEBUG
        .task { await runAgentDebugCommands(workspace: workspace, ui: ui, preferences: preferences) }
        #endif
    }

    // MARK: Top

    private var topBar: some View {
        HStack(spacing: 6) {
            if !collapsed {
                BrandMark(size: 26)
                Text("NexBot").font(.system(size: 15, weight: .bold)).tracking(-0.3).padding(.leading, 3)
                Spacer(minLength: 0)
                roundButton("plus", "添加 Agent") { AgentUI.shared.createAgent() }.disabled(workspace.state == nil)
            }
            roundButton(collapsed ? "sidebar.left" : "sidebar.leading", collapsed ? "展开左栏" : "收起左栏") { ui.railOpen.toggle() }
                .accessibilityIdentifier("rail-toggle")
        }
        .frame(maxWidth: .infinity, alignment: collapsed ? .center : .leading)
        .padding(.leading, collapsed ? 0 : 6).padding(.top, 44).padding(.bottom, 8)
        .frame(height: 92)
    }

    private func roundButton(_ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
        RailRoundButton(symbol: symbol, label: label, action: action)
    }

    @ViewBuilder private var searchField: some View {
        if collapsed {
            Button { focusSearchOnOpen = true; ui.railOpen = true } label: {
                Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(Theme.muted)
                    .frame(width: 40, height: 36).background(Theme.wash, in: RoundedRectangle(cornerRadius: 12, style: .continuous)).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("搜索会话记录").accessibilityLabel("搜索会话记录")
            .padding(.bottom, 6)
        } else {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(Theme.muted)
                TextField("搜索会话记录", text: Bindable(ui).contactSearch).textFieldStyle(.plain).font(.system(size: 12.5)).accessibilityLabel("搜索会话记录")
                    .focused($searchFocused)
                    .onChange(of: query) { if query.count > ConversationSearch.maxLength { ui.contactSearch = String(query.prefix(ConversationSearch.maxLength)) } }
                if !query.isEmpty {
                    Button { ui.contactSearch = "" } label: {
                        Image(systemName: "xmark.circle.fill").font(.system(size: 12)).foregroundStyle(Theme.muted).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).help("清空搜索").accessibilityLabel("清空搜索")
                }
            }
            .padding(.horizontal, 12).frame(height: 36)
            .background(Theme.wash, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.identityAccent.opacity(searchFocused ? 0.45 : 0), lineWidth: 2))
            .padding(.horizontal, 2).padding(.bottom, 6)
        }
    }

    // MARK: Contacts

    @ViewBuilder private func section(_ title: String, _ bots: [Bot]) -> some View {
        if !bots.isEmpty {
            if !collapsed {
                Text(title).font(.system(size: 11)).foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 2)
            }
            ForEach(bots) { bot in
                Button { workspace.showLatest(botID: bot.id); workspace.select(bot.id) } label: {
                    if collapsed {
                        DockRow(bot: bot, appearance: workspace.appearance(bot), state: workspace.companionState(bot.id), selected: workspace.selectedBotID == bot.id)
                    } else {
                        ContactRow(bot: bot, appearance: workspace.appearance(bot), state: workspace.companionState(bot.id),
                                   phrase: ToolLabels.taskPhrase(workspace.state?.unfinishedTask(botID: bot.id)),
                                   selected: workspace.selectedBotID == bot.id)
                    }
                }
                .buttonStyle(.plain)
                .help(collapsed ? bot.name : "")
                .accessibilityLabel(bot.name)
                .accessibilityAddTraits(workspace.selectedBotID == bot.id ? .isSelected : [])
            }
        }
    }

    private var dockAdd: some View {
        Button { AgentUI.shared.createAgent() } label: {
            Image(systemName: "plus").font(.system(size: 15)).foregroundStyle(Theme.foreground)
                .frame(width: 40, height: 40)
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.muted.opacity(0.55), style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).help("添加 Agent").accessibilityLabel("添加 Agent")
        .disabled(workspace.state == nil)
        .padding(.top, 4).padding(.bottom, 6)
    }

    private var accountCard: some View {
        Button { ui.accountMenuOpen.toggle() } label: {
            HStack(spacing: 10) {
                PersonAvatar(initial: workspace.account?.initial ?? "N", size: 30)
                if !collapsed {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(accountName).font(.system(size: 12.5, weight: .semibold)).lineLimit(1)
                        if workspace.connection != .connected { Text("正在重新连接…").font(.system(size: 10)).foregroundStyle(Theme.muted) }
                    }
                    Spacer()
                    Image(systemName: ui.accountMenuOpen ? "chevron.down" : "chevron.up").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: collapsed ? .center : .leading)
            .padding(.horizontal, collapsed ? 0 : 8).frame(height: 46)
            .background(ui.accountMenuOpen ? Theme.wash : .clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, 4)
        .accessibilityLabel("账号菜单")
    }

    private var accountName: String { workspace.account?.displayName ?? "NexorAI 账号" }
}

/// Round rail buttons turn to a soft wash on hover.
private struct RailRoundButton: View {
    let symbol: String
    let label: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 14)).foregroundStyle(Theme.foreground)
                .frame(width: 30, height: 30)
                .background(hovering ? Theme.wash : .clear, in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(label).accessibilityLabel(label)
    }
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
    @Environment(\.colorScheme) private var scheme
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 10) {
            // Sidebar contacts move only while thinking or working; idle and approval stay still.
            AgentAvatar(appearance: appearance, state: state, size: 40, animated: preferences.motionEnabled && (state == .thinking || state == .working))
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(bot.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Spacer(minLength: 4)
                    if let at = bot.lastMessageAt {
                        Text(TimeFormat.formatShortTime(at)).font(.system(size: 10.5).monospacedDigit()).foregroundStyle(Theme.muted)
                    }
                }
                HStack(spacing: 6) {
                    if !phrase.isEmpty {
                        Text(phrase).font(.system(size: 11.5)).foregroundStyle(Theme.identityAccent).lineLimit(1)
                    } else {
                        Text(Self.preview(bot)).font(.system(size: 11.5)).foregroundStyle(Theme.muted).lineLimit(1)
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
        .padding(.horizontal, 8).padding(.vertical, 9)
        .background {
            let shape = RoundedRectangle(cornerRadius: 15, style: .continuous)
            if selected {
                shape.fill(Theme.glassStrong)
                    .overlay(shape.strokeBorder(Theme.glassEdge))
                    .shadow(color: Theme.shadowInk.opacity(scheme == .dark ? 0.3 : 0.06), radius: 7, y: 4)
            } else if hovering {
                shape.fill(Theme.wash)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }

    /// Port of the web contact preview: last message, else the instructions, else 开始一段对话.
    static func preview(_ bot: Bot) -> String {
        if let text = bot.lastMessage, !text.isEmpty {
            let preview = AttachmentLink.preview(text)
            if !preview.isEmpty { return preview }
        }
        if !bot.instructions.isEmpty { return bot.instructions.replacingOccurrences(of: "\n", with: " ") }
        return "开始一段对话"
    }
}

/// The collapsed rail: only the avatar, an accent bar on the selected Agent and a dot when there are unread messages.
struct DockRow: View {
    let bot: Bot
    let appearance: AgentAppearance
    let state: CompanionState
    let selected: Bool
    @Environment(ContactPreferences.self) private var preferences
    @State private var hovering = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 15, style: .continuous)
        ZStack(alignment: .leading) {
            AgentAvatar(appearance: appearance, state: state, size: 40, animated: preferences.motionEnabled && (state == .thinking || state == .working))
                .padding(5)
                .background { if selected { shape.fill(Theme.glassStrong).overlay(shape.strokeBorder(Theme.glassEdge)) } else if hovering { shape.fill(Theme.wash) } }
                .overlay(alignment: .topTrailing) {
                    if bot.unreadCount > 0 {
                        Circle().fill(Theme.identityAccent).frame(width: 9, height: 9)
                            .overlay(Circle().strokeBorder(Theme.card, lineWidth: 2)).padding(.top, 5).padding(.trailing, 7)
                            .accessibilityLabel("\(bot.unreadCount) 条未读")
                    }
                }
                .frame(maxWidth: .infinity)
            if selected {
                Capsule().fill(Theme.identityAccent).frame(width: 3, height: 22).padding(.leading, 0)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}

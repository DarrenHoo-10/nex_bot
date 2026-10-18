import SwiftUI
import NexClientKit

struct ContactsView: View {
    let model: AppModel
    let workspace: WorkspaceStore
    @Bindable var nav: Navigation
    @Environment(ContactPreferences.self) private var preferences
    @State private var query = ""
    @State private var showCreate = false
    @State private var errorText: String?

    private var groups: (pinned: [Bot], rest: [Bot]) { preferences.groups(of: workspace.bots, query: query) }
    private var searching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack(path: $nav.path) {
            VStack(spacing: 0) {
                header
                content
            }
            .background(Theme.background)
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Navigation.Route.self) { route in
                nav.destination(for: route, model: model, workspace: workspace)
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                if workspace.state != nil, let notice = workspace.notice { NoticeBanner(text: notice) }
            }
        }
        .sheet(isPresented: $showCreate) {
            AgentEditorSheet(workspace: workspace) { id in
                workspace.select(id)
                nav.openChat(id)
            }
        }
        .errorAlert($errorText)
        #if DEBUG
        .task { UIDebug.shared.start() }
        #endif
        .debugCommand { command, arg in
            switch command {
            case "createagent": showCreate = true
            case "search": query = arg
            case "pinfirst": if let id = workspace.bots.first?.id { preferences.togglePin(id) }
            case "pinlast": if let id = workspace.bots.last?.id { preferences.togglePin(id) }
            default: break
            }
        }
    }

    @ViewBuilder private var content: some View {
        if workspace.state == nil {
            VStack(spacing: 12) {
                ProgressView()
                Text(workspace.notice ?? "正在连接…").font(.footnote).foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if workspace.bots.isEmpty {
            welcome
        } else {
            list
        }
    }

    private var list: some View {
        let groups = groups
        return List {
            searchField.listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 12, trailing: 16)).plainRow()
            if workspace.pendingApprovalCount > 0 {
                approvalBanner.listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 12, trailing: 16)).plainRow()
            }
            HStack {
                Text("对话").font(.footnote).foregroundStyle(Theme.muted)
                Spacer()
                Text("\(workspace.bots.count)").font(.footnote).foregroundStyle(Theme.muted)
            }
            .listRowInsets(EdgeInsets(top: 0, leading: 22, bottom: 4, trailing: 22)).plainRow()
            if groups.pinned.isEmpty && groups.rest.isEmpty {
                Text(searching ? "没有找到联系人" : "你的 Agent 会出现在这里")
                    .font(.footnote).foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity).padding(.vertical, 28).plainRow()
            }
            if !groups.pinned.isEmpty { section("置顶", groups.pinned) }
            if !groups.rest.isEmpty { section("我的 Agent", groups.rest) }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await workspace.refresh() }
    }

    @ViewBuilder private func section(_ title: String, _ bots: [Bot]) -> some View {
        Text(title).font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
            .listRowInsets(EdgeInsets(top: 8, leading: 22, bottom: 2, trailing: 22)).plainRow()
        ForEach(bots) { bot in
            Button { nav.push(.chat(bot.id)) } label: {
                ContactRow(bot: bot, workspace: workspace)
            }
            .buttonStyle(.plain)
            .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12)).plainRow()
            .swipeActions(edge: .leading) {
                pinButton(bot).tint(Theme.brand)
            }
            .contextMenu {
                pinButton(bot)
                Button { nav.openAgentDetail(bot.id) } label: { Label("助手详情", systemImage: "info.circle") }
            }
        }
    }

    private func pinButton(_ bot: Bot) -> some View {
        let pinned = preferences.isPinned(bot.id)
        return Button { preferences.togglePin(bot.id) } label: {
            Label(pinned ? "取消置顶" : "置顶联系人", systemImage: pinned ? "pin.slash" : "pin")
        }
    }

    /// 创建你的第一个 Agent.
    private var welcome: some View {
        VStack(spacing: 14) {
            Spacer()
            BrandMark(size: 56)
            Text("创建你的第一个 Agent").font(.title3.weight(.bold))
            Text("给它一个名字，身份与职责可以之后补充。消息、记忆和工作会持续保留。")
                .font(.subheadline).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            Button("创建 Agent") { showCreate = true }
                .buttonStyle(PillButtonStyle(primary: true)).padding(.top, 6)
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 36)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var header: some View {
        HStack(spacing: 8) {
            BrandMark(size: 28)
            Text("NexBot").font(.headline.weight(.bold))
            Spacer()
            Button { showCreate = true } label: {
                Image(systemName: "plus").font(.system(size: 17, weight: .medium)).frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("添加 Agent")
            Button { nav.showMenu = true } label: { AccountAvatar(size: 32, initial: accountInitial(workspace)) }
                .buttonStyle(.plain)
                .accessibilityLabel("账号菜单")
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Theme.muted)
            TextField("搜索联系人", text: $query)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityLabel("搜索 Agent")
            if !query.isEmpty {
                Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted) }
                    .buttonStyle(.plain).accessibilityLabel("清空搜索")
            }
        }
        .font(.subheadline)
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var approvalBanner: some View {
        Button { nav.push(.approvals) } label: {
            HStack(spacing: 10) {
                Image(systemName: "checkmark.shield").foregroundStyle(Theme.approval)
                Text("\(workspace.pendingApprovalCount) 项待你批准").font(.subheadline.weight(.semibold))
                Spacer()
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(Theme.approvalSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.approval.opacity(0.5)))
        }
        .buttonStyle(.plain)
    }
}

private extension View {
    /// A list row without separator, background or default chrome.
    func plainRow() -> some View { listRowSeparator(.hidden).listRowBackground(Color.clear) }
}

struct ContactRow: View {
    let bot: Bot
    let workspace: WorkspaceStore

    private var phrase: String { workspace.state?.unfinishedTask(botID: bot.id)?.phrase ?? "" }

    var body: some View {
        HStack(spacing: 12) {
            workspace.avatar(of: bot, size: 40)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(bot.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Spacer()
                    if let date = bot.lastMessageAt {
                        Text(TimeFormat.formatShortTime(date)).font(.caption2).foregroundStyle(Theme.muted)
                    }
                }
                HStack(alignment: .center) {
                    Text(preview).font(.footnote).foregroundStyle(phrase.isEmpty ? Theme.muted : Theme.brand).lineLimit(1)
                    Spacer(minLength: 4)
                    if bot.unreadCount > 0 {
                        Text(bot.unreadCount > 99 ? "99+" : "\(bot.unreadCount)")
                            .font(.caption2.weight(.bold)).foregroundStyle(Theme.primaryForeground)
                            .frame(minWidth: 18, minHeight: 18).padding(.horizontal, 2)
                            .background(Theme.primary, in: Capsule())
                            .accessibilityLabel("\(bot.unreadCount) 条未读")
                    }
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    /// Task phrase, else the last message, else the instructions, else 开始一段对话.
    private var preview: String {
        if !phrase.isEmpty { return phrase }
        for text in [bot.lastMessage ?? "", bot.instructions] {
            let flat = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
            if !flat.isEmpty { return flat }
        }
        return "开始一段对话"
    }
}

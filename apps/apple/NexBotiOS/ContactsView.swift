import SwiftUI
import NexClientKit

struct ContactsView: View {
    let model: AppModel
    let workspace: WorkspaceStore
    @Bindable var nav: Navigation
    @State private var query = ""

    private var bots: [Bot] {
        let text = query.trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? workspace.bots : workspace.bots.filter { $0.name.localizedCaseInsensitiveContains(text) }
    }

    var body: some View {
        NavigationStack(path: $nav.path) {
            VStack(spacing: 0) {
                header
                ScrollView {
                    LazyVStack(spacing: 0) {
                        searchField.padding(.bottom, 12)
                        if workspace.pendingApprovalCount > 0 { approvalBanner.padding(.bottom, 12) }
                        HStack {
                            Text("对话").font(.footnote).foregroundStyle(Theme.muted)
                            Spacer()
                            Text("\(bots.count)").font(.footnote).foregroundStyle(Theme.muted)
                        }
                        .padding(.horizontal, 6).padding(.bottom, 6)
                        ForEach(bots) { bot in
                            NavigationLink(value: Navigation.Route.chat(bot.id)) {
                                ContactRow(bot: bot, workspace: workspace)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 12).padding(.top, 4)
                }
                .refreshable { await workspace.refresh() }
                .overlay {
                    if workspace.state == nil {
                        VStack(spacing: 12) {
                            ProgressView()
                            Text(workspace.notice ?? "正在连接…").font(.footnote).foregroundStyle(Theme.muted)
                        }
                    } else if workspace.bots.isEmpty {
                        ContentUnavailableView("还没有 Agent", systemImage: "person.2", description: Text("请先在电脑端创建 Agent。"))
                    }
                }
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
    }

    private var header: some View {
        HStack(spacing: 8) {
            BrandMark(size: 28)
            Text("NexBot").font(.headline.weight(.bold))
            Spacer()
            Button { nav.showMenu = true } label: { AccountAvatar(size: 32) }
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
            if !query.isEmpty {
                Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted) }.buttonStyle(.plain)
            }
        }
        .font(.subheadline)
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var approvalBanner: some View {
        NavigationLink(value: Navigation.Route.approvals) {
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
                        Text(Self.time(date)).font(.caption2).foregroundStyle(Theme.muted)
                    }
                }
                HStack(alignment: .center) {
                    Text(preview).font(.footnote).foregroundStyle(phrase.isEmpty ? Theme.muted : Theme.brand).lineLimit(1)
                    Spacer(minLength: 4)
                    if bot.unreadCount > 0 {
                        Text("\(bot.unreadCount)")
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

    private var preview: String {
        if !phrase.isEmpty { return phrase }
        let text = (bot.lastMessage ?? "").replacingOccurrences(of: "\n", with: " ")
        return text.isEmpty ? "还没有消息" : text
    }

    /// Today: HH:mm; otherwise month/day.
    static func time(_ date: Date) -> String {
        Calendar.current.isDateInToday(date) ? date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute()) : date.formatted(.dateTime.month().day())
    }
}

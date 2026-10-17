import SwiftUI
import NexClientKit

struct ContactsView: View {
    let workspace: WorkspaceStore
    @Bindable var nav: Navigation

    var body: some View {
        NavigationStack(path: $nav.path) {
            List(workspace.bots) { bot in
                NavigationLink(value: bot.id) { ContactRow(bot: bot, phrase: workspace.state?.unfinishedTask(botID: bot.id)?.phrase ?? "") }
            }
            .listStyle(.plain)
            .overlay {
                if workspace.state == nil {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text(workspace.notice ?? "正在连接…").font(.footnote).foregroundStyle(.secondary)
                    }
                } else if workspace.bots.isEmpty {
                    ContentUnavailableView("还没有 Agent", systemImage: "person.2", description: Text("请先在电脑端创建 Agent。"))
                }
            }
            .refreshable { await workspace.refresh() }
            .navigationTitle("会话")
            .navigationDestination(for: String.self) { id in
                ChatView(workspace: workspace, botID: id)
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                if workspace.state != nil, let notice = workspace.notice { NoticeBanner(text: notice) }
            }
        }
    }
}

struct ContactRow: View {
    let bot: Bot
    let phrase: String

    var body: some View {
        HStack(spacing: 12) {
            Text(bot.initials)
                .font(.headline).foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .background(Color.accentColor.gradient, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(bot.name).font(.headline).lineLimit(1)
                    Spacer()
                    if let date = bot.lastMessageAt {
                        Text(date, format: .dateTime.month().day().hour().minute()).font(.caption).foregroundStyle(.secondary)
                    }
                }
                HStack {
                    Text(preview).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                    Spacer(minLength: 4)
                    if bot.unreadCount > 0 {
                        Text("\(bot.unreadCount)")
                            .font(.caption.bold()).foregroundStyle(.white)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(Color.red, in: Capsule())
                            .accessibilityLabel("\(bot.unreadCount) 条未读")
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var preview: String {
        if !phrase.isEmpty { return phrase }
        let text = (bot.lastMessage ?? "").replacingOccurrences(of: "\n", with: " ")
        return text.isEmpty ? "还没有消息" : text
    }
}

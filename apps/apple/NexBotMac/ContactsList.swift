import SwiftUI
import NexClientKit

struct ContactsList: View {
    let workspace: WorkspaceStore

    var body: some View {
        let selection = Binding<String?>(get: { workspace.selectedBotID }, set: { workspace.select($0) })
        Group {
            if workspace.state == nil {
                VStack(spacing: 10) {
                    ProgressView()
                    Text(workspace.notice ?? "正在连接…").font(.callout).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(workspace.bots, selection: selection) { bot in
                    ContactRow(bot: bot, phrase: ToolLabels.taskPhrase(workspace.state?.unfinishedTask(botID: bot.id)))
                        .tag(bot.id)
                }
                .listStyle(.sidebar)
            }
        }
        .navigationTitle("会话")
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HStack(spacing: 6) {
                Circle().fill(workspace.connection == .connected ? Color.green : Color.orange).frame(width: 7, height: 7)
                Text(workspace.connection == .connected ? "已连接" : "正在重新同步…").font(.caption).foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(.bar)
        }
    }
}

struct ContactRow: View {
    let bot: Bot
    let phrase: String

    var body: some View {
        HStack(spacing: 10) {
            AvatarView(name: bot.name, size: 38)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(bot.name).font(.headline).lineLimit(1)
                    Spacer(minLength: 4)
                    if let at = bot.lastMessageAt {
                        Text(Self.format(at)).font(.caption).foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 6) {
                    if !phrase.isEmpty {
                        Text(phrase).font(.callout).foregroundStyle(Color.accentColor).lineLimit(1)
                    } else {
                        Text(Self.preview(bot.lastMessage)).font(.callout).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    if bot.unreadCount > 0 {
                        Text(bot.unreadCount > 99 ? "99+" : "\(bot.unreadCount)")
                            .font(.caption2.weight(.bold)).foregroundStyle(.white)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Color.red, in: Capsule())
                            .accessibilityLabel("\(bot.unreadCount) 条未读")
                    }
                }
            }
        }
        .padding(.vertical, 3)
    }

    static func preview(_ text: String?) -> String {
        guard let text, !text.isEmpty else { return "暂无消息" }
        return text.replacingOccurrences(of: "\n", with: " ")
    }

    static func format(_ date: Date) -> String {
        Calendar.current.isDateInToday(date) ? date.formatted(date: .omitted, time: .shortened) : date.formatted(.dateTime.month().day())
    }
}

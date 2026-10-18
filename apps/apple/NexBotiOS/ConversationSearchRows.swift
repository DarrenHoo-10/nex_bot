import SwiftUI
import NexClientKit

/// The contact list's rows while the search field has text: message hits across assistants, newest first. A tap opens the
/// chat around that message. The parent gives it a new identity per query and sync generation.
struct ConversationSearchRows: View {
    let workspace: WorkspaceStore
    let open: (ConversationMatch) -> Void
    @State private var search: ConversationSearch

    init(workspace: WorkspaceStore, query: String, open: @escaping (ConversationMatch) -> Void) {
        self.workspace = workspace; self.open = open
        _search = State(initialValue: ConversationSearch(query: query, workspace: workspace))
    }

    var body: some View {
        Group {
            ForEach(search.results) { match in
                Button { open(match) } label: { row(match) }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12)).plainRow()
                    .accessibilityLabel("\(match.botName)：\(match.snippet)")
            }
            if search.isLoading {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("正在搜索…").font(.footnote).foregroundStyle(Theme.muted) }
                    .frame(maxWidth: .infinity).padding(.vertical, 20).plainRow()
            } else if search.isEmpty {
                Text("没有找到会话记录").font(.footnote).foregroundStyle(Theme.muted).frame(maxWidth: .infinity).padding(.vertical, 28).plainRow()
            }
            if let error = search.error {
                VStack(spacing: 8) {
                    Text(error).font(.footnote).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                    Button("重试") { Task { await search.retry() } }.font(.footnote).foregroundStyle(Theme.brand)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 28).plainRow()
            } else if search.hasMore && !search.isLoading {
                Button { Task { await search.loadMore() } } label: {
                    Text("加载更多结果").font(.footnote).foregroundStyle(Theme.brand).frame(maxWidth: .infinity).padding(.vertical, 10)
                }
                .buttonStyle(.plain).plainRow()
            }
        }
        .task { await search.start() }
        .debugCommand { command, arg in
            // searchopen <n>: the n-th hit, like a tap on its row.
            if command == "searchopen", let n = Int(arg), search.results.indices.contains(n) { open(search.results[n]) }
        }
    }

    private func row(_ match: ConversationMatch) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(match.botName).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 4)
                if let at = match.createdAt { Text(TimeFormat.formatTime(at)).font(.caption2).foregroundStyle(Theme.muted) }
            }
            Text(match.snippet).font(.footnote).foregroundStyle(Theme.muted).lineLimit(3).multilineTextAlignment(.leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .contentShape(Rectangle())
    }
}

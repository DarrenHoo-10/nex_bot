import SwiftUI
import NexClientKit

/// The sidebar list while the search field has text: message hits across assistants, newest first. Choosing one opens the
/// conversation around that message. The parent gives it a new identity per query and sync generation.
struct ConversationSearchResults: View {
    let workspace: WorkspaceStore
    @State private var search: ConversationSearch

    init(workspace: WorkspaceStore, query: String) {
        self.workspace = workspace
        _search = State(initialValue: ConversationSearch(query: query, workspace: workspace))
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 2) {
                ForEach(search.results) { match in
                    Button { workspace.openSearchResult(match) } label: { row(match) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(match.botName)：\(match.snippet)")
                }
                if search.isLoading {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("正在搜索…").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    }
                    .frame(maxWidth: .infinity).padding(.top, 20)
                } else if search.isEmpty {
                    Text("没有找到会话记录").font(.system(size: 12)).foregroundStyle(Theme.muted).frame(maxWidth: .infinity).padding(.top, 28)
                }
                if let error = search.error {
                    VStack(spacing: 8) {
                        Text(error).font(.system(size: 12)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                        Button { Task { await search.retry() } } label: {
                            Text("重试").font(.system(size: 12)).foregroundStyle(Theme.brand).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    .frame(maxWidth: .infinity).padding(.top, 28)
                } else if search.hasMore && !search.isLoading {
                    Button { Task { await search.loadMore() } } label: {
                        Text("加载更多结果").font(.system(size: 12)).foregroundStyle(Theme.brand)
                            .frame(maxWidth: .infinity).frame(height: 32).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
        }
        .accessibilityLabel("会话搜索结果")
        .task { await search.start() }
    }

    private func row(_ match: ConversationMatch) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(match.botName).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Spacer(minLength: 4)
                if let at = match.createdAt {
                    Text(TimeFormat.formatTime(at)).font(.system(size: 10)).foregroundStyle(Theme.muted)
                }
            }
            Text(match.snippet).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(3).multilineTextAlignment(.leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .modifier(HoverHighlight())
    }
}

private struct HoverHighlight: ViewModifier {
    @State private var hovering = false
    func body(content: Content) -> some View {
        content
            .background(hovering ? Theme.secondary : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .onHover { hovering = $0 }
    }
}

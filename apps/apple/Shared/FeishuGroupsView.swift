import SwiftUI
import NexClientKit

/// The bot's avatar: the first character of its Feishu name.
struct FeishuAvatar: View {
    let app: FeishuAppView
    var size: CGFloat = 36
    var body: some View {
        Text(String(app.displayName.prefix(1)))
            .font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(.white)
            .frame(width: size, height: size).background(Color(hex: 0x3370FF), in: Circle())
            .accessibilityHidden(true)
    }
}

extension FeishuAppView {
    var statusTint: Color {
        switch status {
        case "connected": Theme.success
        case "error": Theme.danger
        case "busy": Theme.approval
        default: Theme.muted
        }
    }
}

/// One Feishu app: the groups its bot is in, each with its reply mode and the owner's context.
struct FeishuGroupsView: View {
    let workspace: WorkspaceStore
    let app: FeishuAppView
    @State private var groups: [FeishuGroup]?
    @State private var open: String?
    @State private var errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let errorText { Text(errorText).font(.footnote).foregroundStyle(Theme.danger).textSelection(.enabled) }
            Text(groups.map { "群 · \($0.count)" } ?? "群").font(.footnote).foregroundStyle(Theme.muted).padding(.leading, 4)
            VStack(spacing: 0) {
                if let groups {
                    if groups.isEmpty {
                        Text("把机器人拉进飞书群后，群会出现在这里").font(.footnote).foregroundStyle(Theme.muted)
                            .frame(maxWidth: .infinity).padding(.vertical, 24)
                    }
                    ForEach(Array(groups.enumerated()), id: \.element.chatID) { index, group in
                        if index > 0 { Divider().overlay(Theme.border) }
                        row(group)
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 24)
                }
            }
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border))
        }
        .task(id: "\(app.id):\(app.status)") { await load() }
    }

    @ViewBuilder private func row(_ group: FeishuGroup) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { open = open == group.chatID ? nil : group.chatID } label: {
                HStack(spacing: 12) {
                    Text(group.isTopicGroup ? "话" : "群").font(.system(size: 12)).foregroundStyle(Theme.muted)
                        .frame(width: 30, height: 30).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(group.name).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground)
                        Text(group.summary).font(.system(size: 12)).foregroundStyle(Theme.muted).multilineTextAlignment(.leading)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted)
                        .rotationEffect(.degrees(open == group.chatID ? 90 : 0))
                }
                .padding(.horizontal, 16).padding(.vertical, 13).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(open == group.chatID ? "收起设置" : "展开设置")
            if open == group.chatID {
                FeishuGroupEditor(workspace: workspace, app: app, group: group, cancel: { open = nil }) { saved in
                    groups = groups?.map { $0.chatID == saved.chatID ? saved : $0 }
                    open = nil
                }
                .id(group.version)
                .padding(.horizontal, 16).padding(.bottom, 16)
            }
        }
    }

    private func load() async {
        do {
            let list = try await workspace.feishuGroups(appID: app.id)
            groups = list.groups; errorText = list.error
        } catch {
            errorText = error.localizedDescription
            if groups == nil { groups = [] }
        }
    }
}

private struct FeishuGroupEditor: View {
    let workspace: WorkspaceStore
    let app: FeishuAppView
    let group: FeishuGroup
    let cancel: () -> Void
    let saved: (FeishuGroup) -> Void
    @State private var trigger: String
    @State private var session: String
    @State private var context: String
    @State private var busy = false
    @State private var errorText: String?

    init(workspace: WorkspaceStore, app: FeishuAppView, group: FeishuGroup, cancel: @escaping () -> Void, saved: @escaping (FeishuGroup) -> Void) {
        self.workspace = workspace; self.app = app; self.group = group; self.cancel = cancel; self.saved = saved
        _trigger = State(initialValue: group.trigger); _session = State(initialValue: group.session); _context = State(initialValue: group.context)
    }

    private var dirty: Bool { !group.claimed || trigger != group.trigger || session != group.session || context != group.context }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("触发方式").font(.system(size: 13, weight: .medium)).padding(.top, 4)
            options(FeishuGroup.triggers, selection: $trigger)
            Text("会话方式").font(.system(size: 13, weight: .medium)).padding(.top, 6)
            if group.isTopicGroup { Text("话题群：每个话题一个会话").font(.system(size: 12)).foregroundStyle(Theme.muted) }
            else { options(FeishuGroup.sessions, selection: $session) }
            HStack {
                Text("系统上下文").font(.system(size: 13, weight: .medium))
                Spacer()
                Text("\(context.count) / \(FeishuGroup.contextLimit)").font(.system(size: 12)).foregroundStyle(Theme.muted)
            }
            .padding(.top, 6)
            TextEditor(text: $context)
                .font(.system(size: 13)).scrollContentBackground(.hidden).padding(6)
                .frame(minHeight: 96)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border))
                .onChange(of: context) { _, value in if value.count > FeishuGroup.contextLimit { context = String(value.prefix(FeishuGroup.contextLimit)) } }
                .accessibilityLabel("系统上下文")
            if let errorText { Text(errorText).font(.system(size: 12)).foregroundStyle(Theme.danger).textSelection(.enabled) }
            HStack(spacing: 8) {
                Spacer()
                Button("取消", action: cancel).disabled(busy)
                Button(group.claimed ? "保存" : "接入并保存") { Task { await save() } }
                    .buttonStyle(.borderedProminent).disabled(busy || !dirty)
            }
        }
    }

    private func options(_ list: [(id: String, title: String, hint: String)], selection: Binding<String>) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: 8)], spacing: 8) {
            ForEach(list, id: \.id) { option in
                let selected = selection.wrappedValue == option.id
                Button { selection.wrappedValue = option.id } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(option.title).font(.system(size: 13, weight: .medium)).foregroundStyle(selected ? Theme.brand : Theme.foreground)
                        Text(option.hint).font(.system(size: 11)).foregroundStyle(Theme.muted).multilineTextAlignment(.leading)
                    }
                    .frame(maxWidth: .infinity, minHeight: 50, alignment: .topLeading)
                    .padding(10)
                    .background(selected ? Theme.brandSoft : Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(selected ? Theme.brand : Theme.border))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
    }

    private func save() async {
        busy = true; errorText = nil
        defer { busy = false }
        do { saved(try await workspace.saveFeishuGroup(appID: app.id, group: group, trigger: trigger, session: session, context: context.trimmingCharacters(in: .whitespacesAndNewlines))) }
        catch { errorText = error.localizedDescription }
    }
}

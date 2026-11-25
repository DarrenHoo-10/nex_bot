import SwiftUI
import NexClientKit

struct FeishuLogo: View {
    let size: CGFloat

    var body: some View {
        Group {
#if os(macOS)
            if let url = Bundle.main.url(forResource: "feishu-logo", withExtension: "png"),
               let image = NSImage(contentsOf: url) {
                Image(nsImage: image).resizable().scaledToFit()
            }
#else
            if let url = Bundle.main.url(forResource: "feishu-logo", withExtension: "png"),
               let image = UIImage(contentsOfFile: url.path) {
                Image(uiImage: image).resizable().scaledToFit()
            }
#endif
        }
        .padding(size * 0.13)
        .frame(width: size, height: size)
        .background(.white, in: RoundedRectangle(cornerRadius: size * 0.22))
        .accessibilityHidden(true)
    }
}
struct FeishuAvatar: View {
    let app: FeishuAppView
    var size: CGFloat = 36
    var body: some View {
        AsyncImage(url: app.avatarURL) { phase in
            if let image = phase.image {
                image.resizable().scaledToFill()
            } else {
                Text(String(app.displayName.prefix(1)))
                    .font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: size, height: size).background(Color(hex: 0x3370FF), in: Circle())
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }
}

extension FeishuAppView {
    var profileStatusLabel: String? {
        switch profileStatus {
        case "pending": "正在同步应用资料"
        case "publication": "应用资料待在飞书发布"
        case "unsupported": "此应用需在飞书修改资料"
        case "error": "应用资料同步失败"
        default: nil
        }
    }

    var statusTint: Color {
        switch status {
        case "connected": Theme.success
        case "error": Theme.danger
        case "busy": Theme.approval
        default: Theme.muted
        }
    }
}

struct FeishuAppOverview: View {
    let workspace: WorkspaceStore
    let app: FeishuAppView
    let busy: Bool
    let onSave: (String) -> Void
    @State private var selection: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 12) {
                FeishuAvatar(app: app, size: 40)
                VStack(alignment: .leading, spacing: 3) {
                    Text(app.displayName).font(.headline)
                    if app.displayName != app.appID {
                        Text(app.appID + (app.brand == "lark" ? " · Lark" : ""))
                            .font(.caption).foregroundStyle(Theme.muted).textSelection(.enabled)
                    }
                    if let status = app.profileStatusLabel {
                        Text(status).font(.caption).foregroundStyle(Theme.muted)
                    }
                }
                Spacer(minLength: 0)
                Text(app.statusLabel).font(.caption.weight(.medium)).foregroundStyle(app.statusTint)
                    .fixedSize(horizontal: true, vertical: false)
            }
            .padding(12)
            Divider().overlay(Theme.border)
            HStack(spacing: 10) {
                Text("接收助手").foregroundStyle(Theme.muted)
                Text(app.botName.isEmpty ? "未选择" : app.botName).fontWeight(.medium)
                Spacer(minLength: 0)
                Button(selection == nil ? "更换" : "收起") {
                    selection = selection == nil ? app.botID : nil
                }
                .accessibilityLabel(selection == nil ? "更换接收助手" : "收起接收助手设置")
                .disabled(busy)
            }
            .font(.subheadline)
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            if let selection {
                HStack(spacing: 10) {
                    Picker("选择接收助手", selection: Binding(get: { self.selection ?? app.botID }, set: { self.selection = $0 })) {
                        if !workspace.bots.contains(where: { $0.id == selection }) {
                            Text("请选择助手").tag(selection)
                        }
                        ForEach(workspace.bots) { bot in Text(bot.name).tag(bot.id) }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    Spacer(minLength: 0)
                    Button("取消") { self.selection = nil }
                    Button("保存") { onSave(selection) }
                        .disabled(selection.isEmpty || selection == app.botID)
                }
                .font(.subheadline)
                .padding(.horizontal, 12).padding(.bottom, 12)
                .disabled(busy)
            }
        }
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.border).allowsHitTesting(false))
        .onChange(of: app.botID) { _, _ in selection = nil }
    }
}

private struct FeishuGroupAvatar: View {
    let workspace: WorkspaceStore
    let group: FeishuGroup
    @State private var avatar: Image?

    var body: some View {
        Group {
            if let avatar { avatar.resizable().scaledToFill() }
            else {
                Image(systemName: group.isTopicGroup ? "bubble.left.and.bubble.right" : "person.2")
                    .font(.system(size: 13)).foregroundStyle(Theme.muted)
            }
        }
        .frame(width: 34, height: 34)
        .background(Theme.secondary)
        .clipShape(Circle())
        .accessibilityHidden(true)
        .task(id: group.avatarPath) {
            avatar = nil
            guard let path = group.avatarPath, let data = try? await workspace.feishuGroupAvatar(path: path),
                  !Task.isCancelled else { return }
#if os(macOS)
            if let image = NSImage(data: data) { avatar = Image(nsImage: image) }
#else
            if let image = UIImage(data: data) { avatar = Image(uiImage: image) }
#endif
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
            HStack(alignment: .firstTextBaseline) {
                Text("群聊").font(.subheadline.weight(.semibold)).accessibilityAddTraits(.isHeader)
                Spacer()
                if let groups { Text("\(groups.count) 个群").font(.caption).foregroundStyle(Theme.muted) }
            }
            .padding(.horizontal, 10)
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
            .overlay(alignment: .top) { Divider().overlay(Theme.border) }
        }
        .task(id: "\(app.id):\(app.status)") { await load() }
    }

    @ViewBuilder private func row(_ group: FeishuGroup) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { open = open == group.chatID ? nil : group.chatID } label: {
                HStack(spacing: 12) {
                    FeishuGroupAvatar(workspace: workspace, group: group)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(group.name).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground)
                        Text(group.summary(showConnection: false)).font(.system(size: 12)).foregroundStyle(Theme.muted).multilineTextAlignment(.leading)
                    }
                    Spacer(minLength: 0)
                    if !group.claimed { Text("未开放").font(.caption).foregroundStyle(Theme.muted) }
                    Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted)
                        .rotationEffect(.degrees(open == group.chatID ? 90 : 0))
                }
                .padding(.horizontal, 12).padding(.vertical, 10).contentShape(Rectangle())
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

    private var canOpen: Bool { group.claimed || (app.ownerBound && app.enabled) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            setting("回复时机", options: FeishuGroup.triggers, selection: $trigger)
            Divider().overlay(Theme.border)
            if group.isTopicGroup {
                HStack {
                    Text("会话方式").font(.subheadline.weight(.medium))
                    Spacer()
                    Text("每个话题一个会话").font(.caption).foregroundStyle(Theme.muted)
                }.padding(.vertical, 8)
            } else {
                setting("会话方式", options: FeishuGroup.sessions, selection: $session)
            }
            Divider().overlay(Theme.border)
            HStack {
                Text("群聊提示词").font(.subheadline.weight(.medium))
                Spacer()
                if !context.isEmpty {
                    Text("\(context.count) / \(FeishuGroup.contextLimit)").font(.caption).foregroundStyle(Theme.muted)
                }
            }.padding(.vertical, 7)
            TextField("可选，例如：回答先给结论", text: $context, axis: .vertical)
                .font(.subheadline).textFieldStyle(.roundedBorder).lineLimit(2...5)
                .onChange(of: context) { _, value in
                    if value.count > FeishuGroup.contextLimit { context = String(value.prefix(FeishuGroup.contextLimit)) }
                }
                .accessibilityLabel("群聊提示词").disabled(busy)
            if let errorText {
                Text(errorText).font(.caption).foregroundStyle(Theme.danger).textSelection(.enabled).padding(.top, 6)
            }
            if !group.claimed {
                Text(!app.ownerBound ? "先绑定应用主人，再向群成员开放。" : !app.enabled ? "启用飞书应用后，可向群成员开放。" : "保存设置后，群成员可按所选规则触发助手。")
                    .font(.caption).foregroundStyle(Theme.muted).padding(.top, 8)
            }
            HStack(spacing: 8) {
                Spacer()
                Button("取消", action: cancel).disabled(busy)
                Button(busy ? "保存中…" : group.claimed ? "保存" : "允许群成员使用") { Task { await save() } }
                    .buttonStyle(.borderedProminent).tint(Theme.brand).disabled(busy || !dirty || !canOpen)
            }.padding(.top, 8)
        }
        .padding(10)
        .background(Theme.secondary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }

    private func setting(_ title: String, options: [(id: String, title: String, hint: String)], selection: Binding<String>) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.medium))
                if let hint = options.first(where: { $0.id == selection.wrappedValue })?.hint {
                    Text(hint).font(.caption).foregroundStyle(Theme.muted)
                }
            }
            Spacer(minLength: 4)
            Picker(title, selection: selection) {
                ForEach(options, id: \.id) { option in Text(option.title).tag(option.id) }
            }
            .labelsHidden().pickerStyle(.menu).disabled(busy)
        }
        .padding(.vertical, 7)
    }

    private func save() async {
        busy = true; errorText = nil
        defer { busy = false }
        do { saved(try await workspace.saveFeishuGroup(appID: app.id, group: group, trigger: trigger, session: session, context: context.trimmingCharacters(in: .whitespacesAndNewlines))) }
        catch { errorText = error.localizedDescription }
    }
}

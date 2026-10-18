import SwiftUI
import NexClientKit

/// 更换头像: 20 companion combinations or 20 classic portraits, with state previews.
struct AvatarPickerSheet: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(\.dismiss) private var dismiss
    @State private var portraitMode = false
    @State private var shape = "soft"
    @State private var color = "teal"
    @State private var portrait = "fox"
    @State private var previewState = CompanionState.idle
    @State private var saving = false
    @State private var error: String?

    private var bot: Bot? { workspace.bot(botID) }
    private var choice: AgentAppearance { portraitMode ? .portrait(portrait) : .companion(shape: shape, color: color) }
    private var encoded: AppearanceChoice { portraitMode ? .portrait(portrait) : .companion(shape: shape, color: color) }
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 10), count: 4)

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("NEXBOT COMPANIONS").font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
                        Text("属于 \(bot?.name ?? "") 的形象").font(.title3.weight(.bold))
                    }
                    previewPanel
                    Picker("头像类型", selection: $portraitMode) {
                        Text("角色").tag(false)
                        Text("经典图库").tag(true)
                    }
                    .pickerStyle(.segmented)
                    if portraitMode { portraits } else { companions }
                    SheetError(text: error)
                    Text("应用后同步到此账号的其他设备").font(.footnote).foregroundStyle(Theme.muted)
                }
                .padding(16)
            }
            .background(Theme.background)
            .navigationTitle("更换头像")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "保存中…" : "应用形象") { Task { await apply() } }.disabled(saving)
                }
            }
            .onAppear(perform: load)
            .debugCommand { command, arg in
                guard command == "avatar" else { return }
                if arg == "portrait" { portraitMode = true }
                else if arg == "companion" { portraitMode = false }
                else if arg.hasPrefix("state:"), let s = CompanionState(rawValue: String(arg.dropFirst(6))) { previewState = s }
                else if arg.hasPrefix("pick:"), let n = Int(arg.dropFirst(5)) {
                    if portraitMode { portrait = AvatarCatalog.portraits[n % 20].id }
                    else { shape = AvatarCatalog.shapes[(n / 5) % 4].id; color = AvatarCatalog.colors[n % 5].id }
                }
                else if arg == "apply" { Task { await apply() } }
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(saving)
    }

    private func load() {
        guard let bot else { return }
        switch workspace.appearance(of: bot) {
        case .companion(let s, let c): shape = s; color = c; portraitMode = false
        case .portrait(let id): portrait = id; portraitMode = true
        }
    }

    private func apply() async {
        saving = true; error = nil
        defer { saving = false }
        do { try await workspace.updateAppearance(botID: botID, encoded); dismiss() }
        catch { self.error = message(of: error) }
    }

    // MARK: Preview

    private var previewPanel: some View {
        VStack(spacing: 10) {
            AgentAvatar(appearance: choice, state: previewState, size: 104)
            Text(bot?.name ?? "").font(.subheadline.weight(.semibold))
            Text(previewState.label).font(.caption).foregroundStyle(Theme.muted)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(AvatarCatalog.previewStates) { item in
                        Chip(title: item.name, selected: previewState.rawValue == item.id) {
                            previewState = CompanionState(rawValue: item.id) ?? .idle
                        }
                    }
                }
            }
            .accessibilityLabel("预览状态")
            Text("预览动效，不会启动任务").font(.caption2).foregroundStyle(Theme.muted)
        }
        .padding(14).frame(maxWidth: .infinity).cardStyle()
    }

    // MARK: Companions

    private var companions: some View {
        VStack(alignment: .leading, spacing: 16) {
            group("轮廓") {
                LazyVGrid(columns: columns, spacing: 10) {
                    ForEach(AvatarCatalog.shapes) { item in
                        option(selected: shape == item.id, label: item.name) { shape = item.id } content: {
                            AgentAvatar(appearance: .companion(shape: item.id, color: color), size: 44)
                        }
                    }
                }
            }
            group("专属颜色") {
                LazyVGrid(columns: columns, spacing: 10) {
                    ForEach(AvatarCatalog.colors) { item in
                        option(selected: color == item.id, label: item.name) { color = item.id } content: {
                            Circle().fill(Color(hex: item.hex)).frame(width: 30, height: 30)
                        }
                    }
                }
            }
            group("20 个搭配") {
                LazyVGrid(columns: columns, spacing: 10) {
                    ForEach(AvatarCatalog.shapes) { s in
                        ForEach(AvatarCatalog.colors) { c in
                            Button { shape = s.id; color = c.id } label: {
                                AgentAvatar(appearance: .companion(shape: s.id, color: c.id), size: 44)
                                    .frame(maxWidth: .infinity).padding(.vertical, 8)
                                    .background(shape == s.id && color == c.id ? Theme.brandSoft : Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(shape == s.id && color == c.id ? Theme.brand : Theme.border, lineWidth: shape == s.id && color == c.id ? 2 : 1))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(AvatarCatalog.companionName(shape: s.id, color: c.id))
                            .accessibilityAddTraits(shape == s.id && color == c.id ? .isSelected : [])
                        }
                    }
                }
            }
        }
    }

    // MARK: Portraits

    private var portraits: some View {
        LazyVGrid(columns: columns, spacing: 12) {
            ForEach(AvatarCatalog.portraits) { item in
                option(selected: portrait == item.id, label: item.name) { portrait = item.id } content: {
                    AgentAvatar(appearance: .portrait(item.id), size: 52)
                }
                .accessibilityLabel("选择\(item.name)头像")
            }
        }
        .accessibilityLabel("经典头像")
    }

    private func group<C: View>(_ title: String, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.footnote.weight(.bold))
            content()
        }
    }

    private func option<C: View>(selected: Bool, label: String, action: @escaping () -> Void, @ViewBuilder content: () -> C) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                content()
                Text(label).font(.caption2).foregroundStyle(selected ? Theme.foreground : Theme.muted).lineLimit(1)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 8)
            .background(selected ? Theme.brandSoft : Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(selected ? Theme.brand : Theme.border, lineWidth: selected ? 2 : 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

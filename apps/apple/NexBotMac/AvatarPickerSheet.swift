import SwiftUI
import NexClientKit

/// 属于 {name} 的形象: companion shapes and colors, or a classic portrait, with an animated state preview.
struct AvatarPickerSheet: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(\.dismiss) private var dismiss

    private enum Mode: String, CaseIterable { case companion = "角色", portrait = "经典图库" }

    @State private var mode = Mode.companion
    @State private var shape = "soft"
    @State private var color = "teal"
    @State private var portrait = "fox"
    @State private var previewState = CompanionState.thinking
    @State private var error: String?
    @State private var saving = false
    @State private var loaded = false

    private var bot: Bot? { workspace.bot(botID) }
    private var choice: AgentAppearance { mode == .companion ? .companion(shape: shape, color: color) : .portrait(portrait) }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            DialogHeader(title: "属于 \(bot?.name ?? "Agent") 的形象", eyebrow: "NEXBOT COMPANIONS") { if !saving { dismiss() } }
            HStack(alignment: .top, spacing: 26) {
                previewPanel.frame(width: 230)
                VStack(alignment: .leading, spacing: 16) {
                    modeToggle
                    if mode == .companion { companionPicker } else { portraitPicker }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .frame(height: 470)
            Hairline()
            HStack {
                Text("应用后同步到此账号的其他设备").font(.system(size: 11)).foregroundStyle(Theme.muted)
                Spacer()
                if let error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled).lineLimit(2) }
                DialogButton(title: "取消") { dismiss() }.keyboardShortcut(.cancelAction).disabled(saving)
                DialogButton(title: saving ? "保存中…" : "应用形象", kind: .primary, disabled: saving, action: save).keyboardShortcut(.defaultAction)
            }
        }
        .padding(26).frame(width: 800)
        .background(Theme.card)
        .onAppear(perform: load)
    }

    // MARK: Preview

    private var previewPanel: some View {
        VStack(spacing: 14) {
            Spacer(minLength: 0)
            AgentAvatar(appearance: choice, state: previewState, size: 104)
                .accessibilityHidden(false).accessibilityLabel("头像预览")
            VStack(spacing: 6) {
                Text(bot?.name ?? "Agent").font(.system(size: 16, weight: .bold)).lineLimit(1)
                Text(previewState.label).font(.system(size: 12)).foregroundStyle(Theme.muted)
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 3), spacing: 4) {
                ForEach(AvatarCatalog.previewStates) { item in
                    let state = CompanionState(rawValue: item.id) ?? .idle
                    Button { previewState = state } label: {
                        Text(item.name).font(.system(size: 11)).frame(maxWidth: .infinity).frame(height: 30)
                            .foregroundStyle(Theme.foreground)
                            .background(previewState == state ? Theme.card : .clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                            .shadow(color: .black.opacity(previewState == state ? 0.08 : 0), radius: 2, y: 1)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).accessibilityLabel("预览状态 \(item.name)")
                }
            }
            .padding(.horizontal, 8)
            Text("预览动效，不会启动任务").font(.system(size: 10)).foregroundStyle(Theme.muted)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var modeToggle: some View {
        HStack(spacing: 4) {
            ForEach(Mode.allCases, id: \.self) { item in
                Button { mode = item } label: {
                    Text(item.rawValue).font(.system(size: 12)).frame(maxWidth: .infinity).frame(height: 32)
                        .foregroundStyle(Theme.foreground)
                        .background(mode == item ? Theme.card : .clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                        .shadow(color: .black.opacity(mode == item ? 0.08 : 0), radius: 2, y: 1)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel(item.rawValue)
            }
        }
        .padding(4).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // MARK: Companion

    private var companionPicker: some View {
        VStack(alignment: .leading, spacing: 18) {
            group("轮廓") {
                HStack(spacing: 8) {
                    ForEach(AvatarCatalog.shapes) { item in
                        Button { shape = item.id } label: {
                            VStack(spacing: 5) {
                                AgentAvatar(appearance: .companion(shape: item.id, color: color), size: 34)
                                Text(item.name).font(.system(size: 10)).foregroundStyle(Theme.foreground)
                            }
                            .frame(maxWidth: .infinity).frame(height: 74)
                            .background(shape == item.id ? Theme.brandSoft : Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(shape == item.id ? Theme.brand : Theme.border))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).accessibilityLabel("轮廓 \(item.name)")
                    }
                }
            }
            group("专属颜色") {
                HStack(spacing: 14) {
                    ForEach(AvatarCatalog.colors) { item in
                        Button { color = item.id } label: {
                            Circle().fill(Color(hex: item.hex)).frame(width: 24, height: 24)
                                .overlay { if color == item.id { Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(.white) } }
                                .padding(3)
                                .overlay(Circle().strokeBorder(color == item.id ? Color(hex: item.hex) : .clear, lineWidth: 1.5))
                                .contentShape(Circle())
                        }
                        .buttonStyle(.plain).help(item.name).accessibilityLabel("颜色 \(item.name)")
                    }
                }
            }
            group("20 个搭配") {
                Grid(horizontalSpacing: 6, verticalSpacing: 6) {
                    ForEach(AvatarCatalog.shapes) { s in
                        GridRow {
                            ForEach(AvatarCatalog.colors) { c in
                                let on = shape == s.id && color == c.id
                                Button { shape = s.id; color = c.id } label: {
                                    AgentAvatar(appearance: .companion(shape: s.id, color: c.id), size: 32)
                                        .frame(maxWidth: .infinity).frame(height: 44)
                                        .background(on ? Theme.brandSoft : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(on ? Theme.brand : .clear))
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(AvatarCatalog.companionName(shape: s.id, color: c.id))
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: Portraits

    private var portraitPicker: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 5), spacing: 8) {
            ForEach(AvatarCatalog.portraits) { item in
                Button { portrait = item.id } label: {
                    VStack(spacing: 5) {
                        AgentAvatar(appearance: .portrait(item.id), size: 48)
                        Text(item.name).font(.system(size: 10)).foregroundStyle(Theme.foreground)
                    }
                    .frame(maxWidth: .infinity).frame(height: 80)
                    .background(portrait == item.id ? Theme.brandSoft : Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(portrait == item.id ? Theme.brand : Theme.border))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel("选择\(item.name)头像")
            }
        }
        .accessibilityLabel("经典头像")
    }

    private func group<C: View>(_ title: String, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 11)).foregroundStyle(Theme.muted)
            content()
        }
    }

    // MARK: Actions

    private func load() {
        guard !loaded, let bot else { return }
        loaded = true
        switch workspace.appearance(bot) {
        case .companion(let s, let c): mode = .companion; shape = s; color = c
        case .portrait(let id): mode = .portrait; portrait = id
        }
    }

    private func save() {
        saving = true; error = nil
        let value: AppearanceChoice = mode == .companion ? .companion(shape: shape, color: color) : .portrait(portrait)
        Task {
            do { try await workspace.updateAppearance(botID: botID, value); dismiss() }
            catch { self.error = message(of: error) }
            saving = false
        }
    }
}

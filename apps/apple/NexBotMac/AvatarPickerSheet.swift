import SwiftUI
import NexClientKit

struct AvatarPickerSheet: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(\.dismiss) private var dismiss
    @Environment(ContactPreferences.self) private var preferences
    @State private var choice = AgentAppearance.companion(shape: "soft", color: "teal")
    @State private var previewState = CompanionState.idle
    @State private var error: String?
    @State private var saving = false
    @State private var loaded = false
    private var bot: Bot? { workspace.bot(botID) }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            DialogHeader(title: "属于 \(bot?.name ?? "Agent") 的形象", eyebrow: "NEXBOT COMPANIONS") { if !saving { dismiss() } }
            HStack(alignment: .top, spacing: 24) {
                previewPanel.frame(width: 210)
                ScrollView {
                    RoleAvatarOptions(choice: $choice, columns: 6).padding(2)
                }
                .frame(maxWidth: .infinity)
            }
            .frame(height: 470).disabled(saving)
            Hairline()
            HStack {
                Text("应用后同步到此账号的其他设备").font(.system(size: 11)).foregroundStyle(Theme.muted)
                Spacer()
                if let error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled).lineLimit(2) }
                DialogButton(title: "取消") { dismiss() }.keyboardShortcut(.cancelAction).disabled(saving)
                DialogButton(title: saving ? "保存中…" : "应用形象", kind: .primary, disabled: saving, action: save).keyboardShortcut(.defaultAction)
            }
        }
        .padding(26).frame(width: 820)
        .background(Theme.card)
        .onAppear {
            guard !loaded, let bot else { return }
            loaded = true; choice = workspace.appearance(bot)
        }
        #if DEBUG
        .onReceive(NotificationCenter.default.publisher(for: .mbDebug)) { note in
            guard !saving, let line = note.userInfo?["line"] as? String, line.hasPrefix("av ") else { return }
            let argument = String(line.dropFirst(3))
            if argument.hasPrefix("graphic:"), let item = AvatarCatalog.graphic(String(argument.dropFirst(8))) { choice = .graphic(item.id) }
            else if argument.hasPrefix("state:"), let state = CompanionState(rawValue: String(argument.dropFirst(6))) { previewState = state }
            else if argument == "apply" { save() }
            else if argument == "cancel" { dismiss() }
        }
        #endif
    }

    private var previewPanel: some View {
        VStack(spacing: 14) {
            Spacer(minLength: 0)
            AgentAvatar(appearance: choice, state: previewState, size: 104, animated: preferences.motionEnabled)
                .accessibilityHidden(false).accessibilityLabel("头像预览")
            Text(bot?.name ?? "Agent").font(.system(size: 16, weight: .bold)).lineLimit(1)
            Text(previewState.label).font(.system(size: 12)).foregroundStyle(Theme.muted)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 3), spacing: 4) {
                ForEach(AvatarCatalog.previewStates) { item in
                    Button { previewState = CompanionState(rawValue: item.id) ?? .idle } label: {
                        Text(item.name).font(.system(size: 11)).frame(maxWidth: .infinity).frame(height: 30)
                            .foregroundStyle(Theme.foreground)
                            .background(previewState.rawValue == item.id ? Theme.card : .clear, in: RoundedRectangle(cornerRadius: 7))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).accessibilityLabel("预览状态 \(item.name)")
                }
            }.padding(.horizontal, 8)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background { WorkspaceSurface(kind: .sidebar) }
        .clipShape(RoundedRectangle(cornerRadius: 18))
    }

    private func save() {
        guard !saving else { return }
        saving = true; error = nil
        let value = choice.request
        Task {
            do { try await workspace.updateAppearance(botID: botID, value); dismiss() }
            catch { self.error = message(of: error) }
            saving = false
        }
    }
}

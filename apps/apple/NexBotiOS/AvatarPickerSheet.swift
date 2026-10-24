import SwiftUI
import NexClientKit

struct AvatarPickerSheet: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(\.dismiss) private var dismiss
    @Environment(ContactPreferences.self) private var preferences
    @State private var choice = AgentAppearance.companion(shape: "soft", color: "teal")
    @State private var previewState = CompanionState.idle
    @State private var saving = false
    @State private var loaded = false
    @State private var error: String?
    private var bot: Bot? { workspace.bot(botID) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("属于 \(bot?.name ?? "") 的形象").font(.title3.weight(.bold))
                    previewPanel
                    RoleAvatarOptions(choice: $choice, columns: 4)
                    SheetError(text: error)
                }
                .padding(16).frame(maxWidth: 620).frame(maxWidth: .infinity).disabled(saving)
            }
            .background { WorkspaceSurface(kind: .reading) }
            .navigationTitle("更换头像")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "保存中…" : "应用形象") { Task { await apply() } }.disabled(saving)
                }
            }
            .onAppear {
                guard !loaded, let bot else { return }
                loaded = true; choice = workspace.appearance(of: bot)
            }
            .debugCommand { command, arg in
                guard command == "avatar", !saving else { return }
                if arg.hasPrefix("state:"), let state = CompanionState(rawValue: String(arg.dropFirst(6))) { previewState = state }
                else if arg.hasPrefix("graphic:"), let item = AvatarCatalog.graphic(String(arg.dropFirst(8))) { choice = .graphic(item.id) }
                else if arg.hasPrefix("pick:"), let n = Int(arg.dropFirst(5)), AvatarCatalog.graphics.indices.contains(n) { choice = .graphic(AvatarCatalog.graphics[n].id) }
                else if arg == "companion" { choice = .companion(shape: "soft", color: "teal") }
                else if arg == "apply" { Task { await apply() } }
                else if arg == "cancel" { dismiss() }
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(saving)
    }

    private func apply() async {
        guard !saving else { return }
        saving = true; error = nil
        let value = choice.request
        defer { saving = false }
        do { try await workspace.updateAppearance(botID: botID, value); dismiss() }
        catch { self.error = message(of: error) }
    }

    private var previewPanel: some View {
        VStack(spacing: 12) {
            AgentAvatar(appearance: choice, state: previewState, size: 104, animated: preferences.motionEnabled)
                .accessibilityHidden(false).accessibilityLabel("头像预览")
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
            }.accessibilityLabel("预览状态")
        }
        .padding(18).frame(maxWidth: .infinity)
        .background { WorkspaceSurface(kind: .sidebar) }
        .clipShape(RoundedRectangle(cornerRadius: 20))
    }
}

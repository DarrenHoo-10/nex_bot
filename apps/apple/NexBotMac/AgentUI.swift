import SwiftUI
import AppKit
import NexClientKit

struct BotRef: Identifiable, Hashable { let id: String }

enum AgentEditorRequest: Identifiable, Hashable {
    case create
    case edit(String)
    var id: String { switch self { case .create: "create"; case .edit(let id): "edit-\(id)" } }
}

struct MemoryRequest: Identifiable { let id = UUID(); let botID: String; let existing: Memory? }

/// Dialog and preview state that several of the agent views (sidebar, chat, inspector) open and observe.
/// The sheets are presented by `AgentSheetsHost`, which the sidebar applies once.
@MainActor @Observable
final class AgentUI {
    static let shared = AgentUI()

    var editor: AgentEditorRequest?
    var avatar: BotRef?
    var policy: BotRef?
    var memory: MemoryRequest?
    /// The 工作 tab preview card (file or tool call) and the agent it was opened for.
    var preview: PreviewItem?
    var previewBotID: String?
    /// The message each agent's composer is quoting.
    var quotes: [String: QuoteDraft] = [:]
    /// Keeps the hover actions (引用 / 复制) of every message visible; set by a DEBUG command for screenshots.
    var alwaysShowActions = false

    func createAgent() { editor = .create }
    func editIdentity(_ botID: String) { editor = .edit(botID) }
    func pickAvatar(_ botID: String) { avatar = BotRef(id: botID) }
    func editPolicy(_ botID: String) { policy = BotRef(id: botID) }
    func editMemory(botID: String, existing: Memory? = nil) { memory = MemoryRequest(botID: botID, existing: existing) }

    /// Opens a file preview in the inspector 工作 tab.
    func previewFile(_ path: String, botID: String, workspace: WorkspaceStore, ui: UIState) {
        Task {
            let item: PreviewItem
            do { item = try await workspace.previewFile(path: path) }
            catch {
                item = PreviewItem(row: ["kind": "file", "path": .string(path), "title": .string((path as NSString).lastPathComponent),
                                         "exists": false, "content": .string(message(of: error))])
            }
            show(item, botID: botID, ui: ui)
        }
    }

    /// Opens a tool step: device.read with a summary previews that path; otherwise the call record, falling back to the step's own preview.
    func previewStep(_ step: ToolStep, botID: String, workspace: WorkspaceStore, ui: UIState) {
        if step.toolName == "device.read", !step.summary.isEmpty {
            previewFile(step.summary, botID: botID, workspace: workspace, ui: ui)
            return
        }
        Task {
            let item: PreviewItem
            do { item = try await workspace.previewTool(callID: step.id) } catch { item = .fallback(step: step) }
            show(item, botID: botID, ui: ui)
        }
    }

    private func show(_ item: PreviewItem, botID: String, ui: UIState) {
        preview = item; previewBotID = botID
        ui.openInspector(.work)
    }

    func copyToPasteboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

// MARK: - Shared controls

/// Dialog button in the web style: black primary, bordered secondary or red danger.
struct DialogButton: View {
    enum Kind { case primary, secondary, danger }
    let title: String
    var kind: Kind = .secondary
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 12, weight: kind == .secondary ? .regular : .semibold))
                .foregroundStyle(kind == .secondary ? Theme.foreground : kind == .primary ? Theme.primaryForeground : .white)
                .padding(.horizontal, 16).frame(height: 32)
                .background(background, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay { if kind == .secondary { RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border) } }
                .opacity(disabled ? 0.45 : 1)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(disabled)
    }

    private var background: Color {
        switch kind {
        case .primary: Theme.primary
        case .danger: Theme.danger
        case .secondary: Theme.card
        }
    }
}

/// Title row with a close button, used by every sheet.
struct DialogHeader: View {
    let title: String
    var eyebrow: String?
    let close: () -> Void

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 6) {
                if let eyebrow {
                    Text(eyebrow).font(.system(size: 10, weight: .regular)).tracking(1.5).foregroundStyle(Theme.muted)
                }
                Text(title).font(.system(size: 17, weight: .bold))
            }
            Spacer()
            Button(action: close) {
                Image(systemName: "xmark").font(.system(size: 13)).frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("关闭").accessibilityLabel("关闭")
        }
    }
}

struct FieldLabel: View {
    let text: String
    var body: some View { Text(text).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground) }
}

/// Bordered single-line field.
struct DialogTextField: View {
    let placeholder: String
    @Binding var text: String

    var body: some View {
        TextField(placeholder, text: $text)
            .textFieldStyle(.plain).font(.system(size: 13))
            .padding(.horizontal, 12).frame(height: 36)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
    }
}

/// Bordered multi-line field with a placeholder.
struct DialogTextEditor: View {
    let placeholder: String
    @Binding var text: String
    var height: CGFloat = 110

    var body: some View {
        TextEditor(text: $text)
            .font(.system(size: 13)).scrollContentBackground(.hidden)
            .padding(.horizontal, 8).padding(.vertical, 6)
            .frame(height: height)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(alignment: .topLeading) {
                if text.isEmpty {
                    Text(placeholder).font(.system(size: 13)).foregroundStyle(Theme.muted).padding(.horizontal, 13).padding(.vertical, 14).allowsHitTesting(false)
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
    }
}

/// A small round toolbar button (share, palette, pin).
struct RoundIconButton: View {
    let symbol: String
    let help: String
    var selected = false
    var size: CGFloat = 30
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 13))
                .foregroundStyle(selected ? Theme.brand : Theme.foreground)
                .frame(width: size, height: size)
                .background(selected ? Theme.brandSoft : .clear, in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain).help(help).accessibilityLabel(help)
    }
}

/// A text-only link-style button in the brand color.
struct LinkButton: View {
    let title: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 11)).foregroundStyle(Theme.muted).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

extension View {
    /// Card-style surface used by the inspector groups.
    func fieldCard(padding: CGFloat = 12) -> some View {
        self.padding(padding).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.wash, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

// MARK: - Sheets host

/// Presents every agent dialog. Applied once, to the sidebar, so the dialogs open from anywhere.
struct AgentSheetsHost: ViewModifier {
    let workspace: WorkspaceStore
    @Bindable private var agentUI = AgentUI.shared

    init(workspace: WorkspaceStore) { self.workspace = workspace }

    func body(content: Content) -> some View {
        content
            .sheet(item: $agentUI.editor) { AgentEditorSheet(workspace: workspace, request: $0) }
            .sheet(item: $agentUI.avatar) { AvatarPickerSheet(workspace: workspace, botID: $0.id) }
            .sheet(item: $agentUI.policy) { PolicyEditorSheet(workspace: workspace, botID: $0.id) }
            .sheet(item: $agentUI.memory) { MemoryEditorSheet(workspace: workspace, request: $0) }
    }
}

import SwiftUI
import NexClientKit

/// Which composer popover is open.
enum ComposerMenuKind: Equatable { case add, permissions, models }

/// One row of a composer menu.
struct ComposerMenuRow: Identifiable {
    let id: String
    var icon: String
    var title: String
    /// Small English key after the title (`file`, `permission`...), as in the web menu.
    var key = ""
    /// Right aligned value (`标准权限`, `Markdown`).
    var value = ""
    var checked = false
    var radio = false
    var enabled = true
    let action: () -> Void
}

enum ComposerMenuEntry: Identifiable {
    case heading(String)
    case row(ComposerMenuRow)
    var id: String { switch self { case .heading(let t): "h-\(t)"; case .row(let r): r.id } }
}

/// A keyboard-navigable menu: Up/Down/Home/End move the highlight, Return activates, Escape closes.
struct ComposerMenu: View {
    let label: String
    let entries: [ComposerMenuEntry]
    let initialID: String?
    let width: CGFloat
    let close: () -> Void
    @State private var highlighted: String?
    @FocusState private var focused: Bool

    private var rows: [ComposerMenuRow] { entries.compactMap { if case .row(let r) = $0 { r } else { nil } }.filter(\.enabled) }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(entries) { entry in
                switch entry {
                case .heading(let title):
                    Text(title).font(.system(size: 11)).foregroundStyle(Theme.muted)
                        .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 4)
                        .accessibilityAddTraits(.isHeader)
                case .row(let row): rowView(row)
                }
            }
        }
        .padding(8).frame(width: width)
        .focusable().focusEffectDisabled().focused($focused)
        .onAppear { highlighted = initialID ?? rows.first?.id; focused = true }
        .onKeyPress(.downArrow) { move(1); return .handled }
        .onKeyPress(.upArrow) { move(-1); return .handled }
        .onKeyPress(.home) { highlighted = rows.first?.id; return .handled }
        .onKeyPress(.end) { highlighted = rows.last?.id; return .handled }
        .onKeyPress(.escape) { close(); return .handled }
        .onKeyPress(.return) { activate(); return .handled }
        .onKeyPress(.space) { activate(); return .handled }
        .accessibilityElement(children: .contain).accessibilityLabel(label)
    }

    private func rowView(_ row: ComposerMenuRow) -> some View {
        Button { if row.enabled { row.action() } } label: {
            HStack(spacing: 12) {
                Image(systemName: row.icon).font(.system(size: 14)).foregroundStyle(Theme.foreground).frame(width: 20)
                Text(row.title).font(.system(size: 13)).foregroundStyle(Theme.foreground)
                if !row.key.isEmpty { Text(row.key).font(.system(size: 11)).foregroundStyle(Theme.muted) }
                Spacer(minLength: 8)
                if !row.value.isEmpty { Text(row.value).font(.system(size: 11)).foregroundStyle(Theme.muted) }
                if row.checked { Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.foreground) }
            }
            .padding(.horizontal, 12).frame(height: 38).frame(maxWidth: .infinity, alignment: .leading)
            .background(highlighted == row.id ? Theme.secondary : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .opacity(row.enabled ? 1 : 0.4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!row.enabled)
        .onHover { if $0, row.enabled { highlighted = row.id } }
        .accessibilityLabel(row.title + (row.value.isEmpty ? "" : "，\(row.value)"))
        .accessibilityAddTraits(row.checked ? .isSelected : [])
    }

    private func move(_ delta: Int) {
        let list = rows
        guard !list.isEmpty else { return }
        let current = list.firstIndex { $0.id == highlighted } ?? (delta > 0 ? -1 : 0)
        highlighted = list[(current + delta + list.count) % list.count].id
    }

    private func activate() {
        if let row = rows.first(where: { $0.id == highlighted }) { row.action() }
    }
}

import SwiftUI
import Observation
import NexClientKit

/// Previews (a file or a tool call) opened from the chat for the agent detail 资料 tab, per agent.
/// A shared holder because the chat and the detail screen are separate navigation destinations.
@MainActor @Observable
final class PreviewCenter {
    static let shared = PreviewCenter()
    var items: [String: PreviewItem] = [:]
}

/// Core error text of a thrown error.
func message(of error: Error) -> String { (error as? CoreError)?.message ?? error.localizedDescription }

/// Wraps chips onto several lines.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? .infinity, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(width: bounds.width, subviews: subviews)
        for (index, origin) in result.origins.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y), proposal: .unspecified)
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, origins: [CGPoint]) {
        var origins: [CGPoint] = [], x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxX: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            origins.append(CGPoint(x: x, y: y))
            x += size.width + spacing; rowHeight = max(rowHeight, size.height); maxX = max(maxX, x - spacing)
        }
        return (CGSize(width: maxX, height: y + rowHeight), origins)
    }
}

/// Small rounded chip (welcome actions, peer links, scope pills).
struct Chip: View {
    let title: String
    var icon: String?
    var selected = false
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let icon { Image(systemName: icon).font(.system(size: 11, weight: .medium)) }
                Text(title).lineLimit(1)
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(selected ? Theme.primaryForeground : Theme.foreground)
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(selected ? Theme.primary : Theme.secondary, in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// Section title of the detail screen.
struct SectionHeader: View {
    let title: String
    var trailing: (icon: String, label: String, action: () -> Void)?
    var body: some View {
        HStack {
            Text(title).font(.footnote.weight(.bold))
            Spacer()
            if let trailing {
                Button(action: trailing.action) { Image(systemName: trailing.icon).font(.system(size: 15, weight: .medium)).frame(width: 32, height: 28) }
                    .buttonStyle(.plain).foregroundStyle(Theme.muted).accessibilityLabel(trailing.label)
            }
        }
    }
}

/// Footer of a form sheet with an error line.
struct SheetError: View {
    let text: String?
    var body: some View {
        if let text { Text(text).font(.footnote).foregroundStyle(Theme.danger).frame(maxWidth: .infinity, alignment: .leading) }
    }
}

extension View {
    /// Form sheets use the app background instead of the grouped gray.
    func sheetFormStyle() -> some View {
        scrollContentBackground(.hidden).background(Theme.background).textCase(nil)
    }
}

#if DEBUG
/// DEBUG-only UI automation of the agent screens (simulators cannot be tapped from scripts). The file named by
/// NEXBOT_DEBUG_UI_FILE is polled and consumed line by line as `<name> [argument]`; views react with `.debugCommand`.
/// Names: createagent, identity, avatar [companion|portrait|state:<id>|pick:<n>], policy, routine, routineedit, memoryedit,
/// archive, pin, type <text>, quote, mention, search <text>, find <q>, reflect <q>, expand, forgetpreview <q>, filechip <path>,
/// toolstep, scroll top|bottom, workstop, resume, runroutine, togglegroup.
@MainActor @Observable
final class UIDebug {
    static let shared = UIDebug()
    private(set) var seq = 0
    private(set) var name = ""
    private(set) var arg = ""
    @ObservationIgnored private var started = false

    func start() {
        guard !started, let path = ProcessInfo.processInfo.environment["NEXBOT_DEBUG_UI_FILE"] else { return }
        started = true
        Task { @MainActor in
            while true {
                try? await Task.sleep(for: .milliseconds(350))
                guard let text = try? String(contentsOfFile: path, encoding: .utf8), !text.isEmpty else { continue }
                try? "".write(toFile: path, atomically: true, encoding: .utf8)
                for line in text.split(separator: "\n") {
                    let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
                    name = parts.first ?? ""; arg = parts.count > 1 ? parts[1] : ""; seq += 1
                    try? await Task.sleep(for: .milliseconds(250))
                }
            }
        }
    }
}
#endif

extension View {
    /// Runs `handler(name, argument)` for each DEBUG UI command (no-op in release builds).
    @ViewBuilder func debugCommand(_ handler: @escaping @MainActor (String, String) -> Void) -> some View {
        #if DEBUG
        onChange(of: UIDebug.shared.seq) { handler(UIDebug.shared.name, UIDebug.shared.arg) }
        #else
        self
        #endif
    }
}

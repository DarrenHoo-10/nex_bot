import SwiftUI
import NexClientKit

// The floating glass workspace of `src/personal/glass.css`, shared by the Mac and iOS apps:
// translucent panels, card bubbles, the document card, the tool capsule and the journal rows.

// MARK: - Surfaces

enum GlassLift { case float, card, none }

/// A translucent panel: material, tint, a light edge and a soft shadow. Reduce Transparency swaps it for an opaque fill.
struct GlassSurface<S: InsettableShape>: ViewModifier {
    let shape: S
    var strong = false
    var lift: GlassLift = .float
    @Environment(\.accessibilityReduceTransparency) private var reduce
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        let dark = scheme == .dark
        content
            .background {
                if reduce {
                    shape.fill(strong ? Theme.card : Theme.sidebar)
                } else {
                    shape.fill(.ultraThinMaterial)
                    shape.fill(strong ? Theme.glassStrong : Theme.glass)
                }
            }
            .overlay { shape.strokeBorder(Theme.glassEdge, lineWidth: 1) }
            .shadow(color: Theme.shadowInk.opacity(lift == .none ? 0 : dark ? 0.4 : 0.13), radius: lift == .float ? 22 : 12, y: lift == .float ? 14 : 8)
            .shadow(color: Theme.shadowInk.opacity(lift == .none ? 0 : dark ? 0.25 : 0.06), radius: 3, y: 2)
    }
}

/// An opaque card with the soft card shadow (message bubbles, document cards, journal tiles).
struct CardSurface<S: InsettableShape>: ViewModifier {
    let shape: S
    var fill: Color = Theme.card
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        content
            .background(shape.fill(fill))
            .shadow(color: Theme.shadowInk.opacity(scheme == .dark ? 0.25 : 0.07), radius: 14, y: 8)
            .shadow(color: Theme.shadowInk.opacity(scheme == .dark ? 0.25 : 0.05), radius: 1, y: 1)
    }
}

extension View {
    func glass<S: InsettableShape>(_ shape: S, strong: Bool = false, lift: GlassLift = .float) -> some View {
        modifier(GlassSurface(shape: shape, strong: strong, lift: lift))
    }
    func cardSurface<S: InsettableShape>(_ shape: S, fill: Color = Theme.card) -> some View {
        modifier(CardSurface(shape: shape, fill: fill))
    }
}

/// Bubble outlines: 20pt corners, with the 6pt tail corner on the last message of a group.
enum Bubble {
    static func assistant(tail: Bool) -> UnevenRoundedRectangle {
        UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: tail ? 6 : 20, bottomTrailingRadius: 20, topTrailingRadius: 20, style: .continuous)
    }
    static let user = UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 6, topTrailingRadius: 20, style: .continuous)
}

/// A round glass icon button (header actions, toolbars).
struct RoundGlassButton: View {
    let symbol: String
    let label: String
    var selected = false
    var size: CGFloat = 34
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: size * 0.42, weight: .medium))
                .foregroundStyle(selected ? Theme.background : Theme.foreground)
                .frame(width: size, height: size)
                .background { Circle().fill(selected ? Theme.foreground : .clear) }
                .glass(Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help(label).accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - Identity colour

extension AgentAppearance {
    /// The Agent's identity colour: its companion colour, else the default teal (web `--bot-color`).
    var accentHex: UInt32 {
        guard case .companion(_, let color) = self else { return Theme.defaultAccent }
        switch color {
        case "ink": return 0x414853
        case "blue": return 0x426DAC
        case "clay": return 0xB26351
        case "plum": return 0x7C608F
        default: return Theme.defaultAccent
        }
    }
    var accent: Color { Color(hex: accentHex) }
}

/// The user bubble: the Agent's identity colour as a soft gradient (`--me-a` to `--me-b`).
func userBubbleGradient(accentHex: UInt32, dark: Bool) -> LinearGradient {
    let a = dark ? mixHex(accentHex, 0xFFFFFF, 0.86) : mixHex(accentHex, 0xFFFFFF, 0.94)
    let b = dark ? mixHex(accentHex, 0x000000, 0.90) : accentHex
    return LinearGradient(colors: [Color(hex: a), Color(hex: b)], startPoint: UnitPoint(x: 0.33, y: 0), endPoint: UnitPoint(x: 0.67, y: 1))
}

/// `color-mix(in srgb, a weight, b)`.
func mixHex(_ a: UInt32, _ b: UInt32, _ weight: Double) -> UInt32 {
    func channel(_ shift: UInt32) -> UInt32 {
        let x = Double(a >> shift & 0xFF), y = Double(b >> shift & 0xFF)
        return UInt32((x * weight + y * (1 - weight)).rounded())
    }
    return channel(16) << 16 | channel(8) << 8 | channel(0)
}

/// Text colour of chat Markdown; white inside the user bubble.
private struct ChatInkKey: EnvironmentKey { static let defaultValue: Color = Theme.foreground }
private struct ChatOnAccentKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    /// True inside the user bubble, where code spans and links sit on the identity colour.
    var chatOnAccent: Bool {
        get { self[ChatOnAccentKey.self] }
        set { self[ChatOnAccentKey.self] = newValue }
    }
    var chatInk: Color {
        get { self[ChatInkKey.self] }
        set { self[ChatInkKey.self] = newValue }
    }
}

// MARK: - Document card

private struct DocumentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// A long reply: outline chips from its own headings, a body clamped to about 230pt that fades out, and 展开全文 / 收起.
struct DocumentCard<Content: View>: View {
    let outline: [String]
    var tail = true
    @ViewBuilder let content: () -> Content
    @State private var open = false
    @State private var natural: CGFloat = 0
    private let clamp: CGFloat = 230
    private var tall: Bool { natural > clamp + 8 }
    private var clamped: Bool { tall && !open }

    var body: some View {
        let shape = Bubble.assistant(tail: tail)
        VStack(alignment: .leading, spacing: 0) {
            if !outline.isEmpty {
                OutlineFlow(spacing: 6) {
                    ForEach(Array(outline.enumerated()), id: \.offset) { _, title in
                        Button { withAnimation(.easeOut(duration: 0.2)) { open = true } } label: {
                            Text(title).font(.system(size: 11.5)).lineLimit(1).foregroundStyle(Theme.muted)
                                .padding(.horizontal, 10).padding(.vertical, 3)
                                .background(Theme.wash, in: Capsule()).contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16).padding(.top, 12)
                .accessibilityLabel("大纲")
            }
            content()
                .fixedSize(horizontal: false, vertical: true)
                .background(GeometryReader { Color.clear.preference(key: DocumentHeightKey.self, value: $0.size.height) })
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .frame(maxHeight: clamped ? clamp : nil, alignment: .top)
                .clipped()
                .mask {
                    if clamped {
                        LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.62), .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom)
                    } else {
                        Color.black
                    }
                }
                .padding(.horizontal, 18).padding(.top, 10).padding(.bottom, tall ? 4 : 14)
            if tall {
                Button { withAnimation(.easeOut(duration: 0.2)) { open.toggle() } } label: {
                    HStack(spacing: 4) {
                        Text(open ? "收起" : "展开全文")
                        Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).rotationEffect(.degrees(open ? 180 : 0))
                    }
                    .font(.system(size: 12)).foregroundStyle(Theme.muted)
                    .padding(.horizontal, 6).padding(.vertical, 4).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.leading, 12).padding(.bottom, 10)
                .accessibilityLabel(open ? "收起" : "展开全文")
            }
        }
        .onPreferenceChange(DocumentHeightKey.self) { natural = $0 }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface(shape)
        .clipShape(shape)
    }
}

/// Chips that wrap onto further rows.
struct OutlineFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: width, height: nil))
            if x > 0, x + size.width > width { x = 0; y += row + spacing; row = 0 }
            x += size.width + spacing; row = max(row, size.height); widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + row)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            if x > 0, x + size.width > bounds.width { x = 0; y += row + spacing; row = 0 }
            subview.place(at: CGPoint(x: bounds.minX + x, y: bounds.minY + y), proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
            x += size.width + spacing; row = max(row, size.height)
        }
    }
}

// MARK: - Tool capsule

/// The collapsed tool activity: up to three kind icons, `N 项操作` and, in red, ` · M 项失败`.
struct ToolCapsuleLabel: View {
    let summary: ToolActivity.Summary
    let expanded: Bool

    var body: some View {
        HStack(spacing: 8) {
            if !summary.symbols.isEmpty {
                HStack(spacing: -5) {
                    ForEach(summary.symbols, id: \.self) { symbol in
                        Image(systemName: symbol).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(Theme.identityAccent)
                            .frame(width: 22, height: 22)
                            .background(Theme.card, in: Circle())
                            .overlay(Circle().strokeBorder(Theme.glassStrong, lineWidth: 2))
                    }
                }
                .accessibilityHidden(true)
            }
            (Text("\(summary.count) 项操作") + (summary.failed > 0 ? Text(" · \(summary.failed) 项失败").foregroundStyle(Theme.danger) : Text("")))
                .font(.system(size: 12)).foregroundStyle(Theme.muted)
            Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.muted)
                .rotationEffect(.degrees(expanded ? 180 : 0)).accessibilityHidden(true)
        }
        .padding(.leading, 6).padding(.trailing, 12).padding(.vertical, 5)
        .glass(Capsule(), lift: .none)
        .contentShape(Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("执行记录 \(summary.count) 项操作" + (summary.failed > 0 ? "，\(summary.failed) 项失败" : ""))
    }
}

// MARK: - Inspector parts

/// Segmented pill tabs of the agent panel.
struct PillTabs<T: Hashable>: View {
    let items: [T]
    let title: (T) -> String
    @Binding var selection: T

    var body: some View {
        HStack(spacing: 0) {
            ForEach(items, id: \.self) { item in
                let on = selection == item
                Button { withAnimation(.easeOut(duration: 0.15)) { selection = item } } label: {
                    Text(title(item)).font(.system(size: 12, weight: .medium))
                        .foregroundStyle(on ? Theme.foreground : Theme.muted)
                        .frame(maxWidth: .infinity).padding(.vertical, 6)
                        .background { if on { Capsule().fill(Theme.card).shadow(color: Theme.shadowInk.opacity(0.10), radius: 2, y: 1) } }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Theme.wash, in: Capsule())
    }
}

/// A large avatar with a soft halo in the Agent's colour.
struct HeroHalo<Content: View>: View {
    let accent: Color
    @ViewBuilder let content: () -> Content
    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Circle()
                .fill(RadialGradient(colors: [accent.opacity(0.26), .clear], center: .center, startRadius: 0, endRadius: 56))
                .frame(width: 120, height: 120).blur(radius: 6)
                .scaleEffect(pulse ? 1.05 : 0.96).opacity(pulse ? 1 : 0.75)
            content()
        }
        .frame(width: 132, height: 132)
        .onAppear {
            guard !reduceMotion else { pulse = true; return }
            withAnimation(.easeInOut(duration: 2.5).repeatForever(autoreverses: true)) { pulse = true }
        }
    }
}

/// One journal row: an icon tile, a title, the status and the time.
enum RunTone { case success, warn, live, pending }

struct RunEntryRow<Footer: View>: View {
    let symbol: String
    let tone: RunTone
    let title: String
    let status: String
    var time: String?
    @ViewBuilder var footer: () -> Footer

    private var tint: Color {
        switch tone {
        case .success: Theme.success
        case .warn: Theme.approval
        case .live, .pending: Theme.identityAccent
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).font(.system(size: 13, weight: .semibold)).foregroundStyle(tint)
                .frame(width: 30, height: 30)
                .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                Text(title).font(.system(size: 12.5, weight: .semibold)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                Text(status).font(.system(size: 11.5)).foregroundStyle(Theme.muted).lineLimit(1)
                if let time { Text(time).font(.system(size: 10.5).monospacedDigit()).foregroundStyle(Theme.muted).padding(.top, 2) }
                footer()
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
    }
}

extension RunEntryRow where Footer == EmptyView {
    init(symbol: String, tone: RunTone, title: String, status: String, time: String? = nil) {
        self.init(symbol: symbol, tone: tone, title: title, status: status, time: time) { EmptyView() }
    }
}

/// The small day heading above a group of journal rows.
struct DayLabel: View {
    let text: String
    var body: some View {
        Text(text).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8).padding(.bottom, 2)
    }
}

/// Run-status presentation shared by both inspectors.
enum RunPresentation {
    static func symbol(_ status: String) -> String {
        switch status {
        case "succeeded": "checkmark"
        case "running": "arrow.triangle.2.circlepath"
        case "pending", "queued": "clock"
        default: "exclamationmark.circle"
        }
    }
    static func tone(_ status: String) -> RunTone {
        switch status {
        case "succeeded": .success
        case "running": .live
        case "pending", "queued": .pending
        default: .warn
        }
    }
}

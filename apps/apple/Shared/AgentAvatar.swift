import SwiftUI
import NexClientKit

/// An Agent's look, parsed from the bot row's `appearance_json` (`shared/personal-appearance.ts`).
enum AgentAppearance: Equatable {
    case companion(shape: String, color: String)
    case portrait(String)

    static let shapes = ["soft", "bean", "pebble", "bud"]
    static let colors = ["teal", "ink", "blue", "clay", "plum"]
    static let portraits = ["fox", "owl", "cat", "bear", "rabbit", "dog", "panda", "koala", "tiger", "deer", "penguin", "seal", "otter", "octopus", "frog", "robot", "astronaut", "star", "cloud", "sprout"]

    /// Port of `appearanceOf`: a saved look, else teal/soft for the first Agent, else a stable look seeded by the id.
    static func of(_ bot: Bot, firstID: String?) -> AgentAppearance {
        if let raw = bot.row.string("appearance_json"), let data = raw.data(using: .utf8),
           let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if value["kind"] as? String == "companion", let shape = value["shape"] as? String, let color = value["color"] as? String,
               shapes.contains(shape), colors.contains(color) { return .companion(shape: shape, color: color) }
            if value["kind"] as? String == "portrait", let id = value["id"] as? String, portraits.contains(id) { return .portrait(id) }
        }
        if bot.id.isEmpty || bot.id == firstID { return .companion(shape: "soft", color: "teal") }
        var seed: UInt32 = 0
        for unit in bot.id.utf16 { seed = seed &* 31 &+ UInt32(unit) }
        return .companion(shape: shapes[Int(seed % 4)], color: colors[Int(seed / 4 % 5)])
    }
}

/// Port of `companionState`: what the avatar's face and badge show.
enum CompanionState: String {
    case idle, thinking, working, approval, done, failed, offline, paused

    var label: String {
        switch self {
        case .idle: "准备好了"
        case .thinking: "正在思考"
        case .working: "正在执行"
        case .approval: "等你确认"
        case .done: "已完成"
        case .failed: "执行未完成"
        case .offline: "正在重新连接"
        case .paused: "已暂停"
        }
    }

    init(task: AgentTask?, approval: Bool = false, connected: Bool = true) {
        if !connected { self = .offline; return }
        if approval || task?.status == "awaiting_approval" { self = .approval; return }
        switch task?.status {
        case "failed", "needs_reconciliation": self = .failed
        case "paused", "cancelled", "rejected": self = .paused
        case "succeeded": self = .done
        case "queued": self = .thinking
        case "running": self = task?.activeTool == nil ? .thinking : .working
        case nil: self = .idle
        default: self = .working
        }
    }
}

/// The Agent avatar of the web UI: a colored companion with eyes, or one of the classic portraits.
struct AgentAvatar: View {
    let appearance: AgentAppearance
    var state: CompanionState = .idle
    var size: CGFloat = 36

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            switch appearance {
            case .portrait(let id):
                Image("portrait-\(id)").resizable().scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: size * 0.29, style: .continuous))
            case .companion(let shape, let color):
                CompanionBody(shape: shape, color: Self.color(color), state: state, size: size)
            }
            if state != .idle {
                Circle().fill(badgeColor)
                    .frame(width: max(7, size * 0.2), height: max(7, size * 0.2))
                    .overlay(Circle().stroke(Theme.background, lineWidth: 2))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var badgeColor: Color {
        switch state {
        case .approval: Theme.approval
        case .failed: Theme.danger
        case .offline, .paused: Theme.offline
        default: Theme.success
        }
    }

    static func color(_ name: String) -> Color {
        switch name {
        case "ink": Color(hex: 0x414853)
        case "blue": Color(hex: 0x426DAC)
        case "clay": Color(hex: 0xB26351)
        case "plum": Color(hex: 0x7C608F)
        default: Color(hex: 0x23756D)
        }
    }
}

private struct CompanionBody: View {
    let shape: String, color: Color, state: CompanionState, size: CGFloat

    /// CSS `inset` (vertical, horizontal) and `border-radius` (TL, TR, BR, BL) per shape, as fractions.
    private var geometry: (v: CGFloat, h: CGFloat, radii: [CGFloat]) {
        switch shape {
        case "bean": (0.14, 0.05, [0.50, 0.50, 0.35, 0.50])
        case "pebble": (0.04, 0.12, [0.52, 0.40, 0.48, 0.28])
        case "bud": (0.06, 0.06, [0.52, 0.12, 0.52, 0.12])
        default: (0.06, 0.06, [0.27, 0.35, 0.27, 0.35])
        }
    }

    var body: some View {
        let g = geometry
        let w = size * (1 - 2 * g.h), h = size * (1 - 2 * g.v), r = min(w, h)
        let outline = UnevenRoundedRectangle(topLeadingRadius: r * g.radii[0], bottomLeadingRadius: r * g.radii[3], bottomTrailingRadius: r * g.radii[2], topTrailingRadius: r * g.radii[1], style: .continuous)
        ZStack(alignment: .topLeading) {
            outline.fill(color)
            // Highlight: inset 7% 16%, height 34%.
            Ellipse().fill(LinearGradient(colors: [.white.opacity(0.08), .clear], startPoint: .top, endPoint: .bottom))
                .frame(width: w * 0.68, height: h * 0.34).offset(x: w * 0.16, y: h * 0.07)
            eyes(width: w * 0.44, height: h * 0.22).offset(x: w * 0.28, y: h * 0.40)
            // Cheek: right 20%, top 64%.
            Ellipse().fill(.white.opacity(0.21)).frame(width: w * 0.09, height: h * 0.04).offset(x: w * 0.71, y: h * 0.64)
        }
        .frame(width: w, height: h)
        .rotationEffect(.degrees(state == .approval ? -7 : 0), anchor: UnitPoint(x: 0.5, y: 0.8))
        .saturation(state == .offline ? 0.3 : 1).opacity(state == .offline ? 0.65 : 1)
        .frame(width: size, height: size)
    }

    private func eyes(width: CGFloat, height: CGFloat) -> some View {
        HStack(spacing: 0) {
            eye(width: width * 0.21, height: height)
            Spacer(minLength: 0)
            eye(width: width * 0.21, height: height)
        }
        .frame(width: width, height: height)
    }

    @ViewBuilder private func eye(width: CGFloat, height: CGFloat) -> some View {
        let white = Color(hex: 0xFFFDF6)
        switch state {
        case .approval: Capsule().fill(white).frame(width: width, height: height * 1.25)
        case .failed: Capsule().fill(white).frame(width: width, height: height * 0.35).rotationEffect(.degrees(-15))
        case .offline, .paused: RoundedRectangle(cornerRadius: 1.5).fill(white).frame(width: width, height: max(1.5, height * 0.16))
        case .done: Arc().stroke(white, style: StrokeStyle(lineWidth: max(1.5, width * 0.35), lineCap: .round)).frame(width: width * 1.4, height: height * 0.48)
        default: Capsule().fill(white).frame(width: width, height: height)
        }
    }
}

/// The happy "done" eye: an upward arc.
private struct Arc: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: rect.minX, y: rect.maxY))
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.maxY), control: CGPoint(x: rect.midX, y: rect.minY - rect.height))
        return p
    }
}

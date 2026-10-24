import SwiftUI
import NexClientKit

/// Whole-artwork keyframes matching identity.css. Facial features remain part of the original art.
struct GraphicAvatarMotion: Equatable {
    var y = 0.0, rotation = 0.0, scaleX = 1.0, scaleY = 1.0

    static func sample(_ graphic: GraphicAvatarDescriptor, state: CompanionState, elapsed: Double) -> Self {
        let tilt = graphic.tilt, lift = graphic.lift
        let frames: [(Double, Self)]
        let duration: Double
        switch state {
        case .idle:
            duration = graphic.tempo
            frames = [(0, .init()), (0.24, .init(y: lift * 0.35, rotation: tilt * 0.2, scaleX: 1.018, scaleY: 1.012)), (0.48, .init()), (0.72, .init()), (0.86, .init(rotation: tilt * -0.25)), (1, .init())]
        case .thinking:
            duration = graphic.tempo * 0.65
            frames = [(0, .init()), (0.25, .init(y: lift, rotation: tilt)), (0.44, .init(y: lift, rotation: tilt)), (0.72, .init(y: lift * 0.5, rotation: tilt * -0.6)), (0.82, .init(y: lift * 0.5, rotation: tilt * -0.6)), (1, .init())]
        case .working:
            duration = graphic.tempo * 0.3
            frames = [(0, .init()), (0.22, .init(y: 1.5, rotation: tilt * -0.4, scaleX: 1.015, scaleY: 0.985)), (0.52, .init(y: lift, rotation: tilt * 0.55, scaleX: 0.99, scaleY: 1.015)), (0.78, .init()), (1, .init())]
        case .done:
            duration = 0.72
            guard elapsed < duration else { return .init() }
            frames = [(0, .init()), (0.18, .init(y: 3, scaleX: 1.04, scaleY: 0.96)), (0.44, .init(y: lift * 2, rotation: tilt, scaleX: 0.98, scaleY: 1.03)), (0.72, .init(y: 1, rotation: tilt * -0.35, scaleX: 1.015, scaleY: 0.99)), (1, .init())]
        case .approval: return .init(rotation: tilt)
        case .failed: return .init(rotation: tilt * -0.5)
        default: return .init()
        }
        let progress = max(0, elapsed).truncatingRemainder(dividingBy: duration) / duration
        for index in 1..<frames.count where progress <= frames[index].0 {
            let (start, a) = frames[index - 1], (end, b) = frames[index]
            let t = (progress - start) / (end - start), eased = t * t * (3 - 2 * t)
            func blend(_ x: Double, _ y: Double) -> Double { x + (y - x) * eased }
            return .init(y: blend(a.y, b.y), rotation: blend(a.rotation, b.rotation), scaleX: blend(a.scaleX, b.scaleX), scaleY: blend(a.scaleY, b.scaleY))
        }
        return .init()
    }
}

struct GraphicAvatarBody: View {
    let graphic: GraphicAvatarDescriptor, state: CompanionState, size: CGFloat, animated: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var started = Date()
    @State private var completed = false
    @State private var visible = false
    private var playing: Bool {
        animated && visible && !reduceMotion && scenePhase == .active && !completed && [.idle, .thinking, .working, .done].contains(state)
    }

    var body: some View {
        Group {
            if playing {
                TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                    artwork(.sample(graphic, state: state, elapsed: context.date.timeIntervalSince(started)))
                }
            } else {
                artwork(.sample(graphic, state: state, elapsed: 0))
            }
        }
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .task(id: state) {
            started = Date(); completed = false
            if state == .done {
                do { try await Task.sleep(for: .milliseconds(720)); completed = true }
                catch { /* View or state changed. */ }
            }
        }
    }

    private func artwork(_ motion: GraphicAvatarMotion) -> some View {
        let scaleX = size / graphic.width, scaleY = size / graphic.height
        return Color.clear.frame(width: size, height: size)
            .overlay(alignment: .topLeading) {
                Image(graphic.assetName).resizable()
                    .frame(width: graphic.sheetWidth * scaleX, height: graphic.sheetHeight * scaleY)
                    .offset(x: -graphic.x * scaleX,
                            y: -graphic.y * scaleY)
            }
            .clipShape(Circle())
            .scaleEffect(x: motion.scaleX, y: motion.scaleY, anchor: UnitPoint(x: 0.5, y: 0.75))
            .rotationEffect(.degrees(motion.rotation), anchor: UnitPoint(x: 0.5, y: 0.75))
            .offset(y: size * motion.y / 100)
            .saturation(state == .offline ? 0.35 : 1)
            .opacity(state == .offline ? 0.6 : state == .paused ? 0.8 : 1)
    }
}

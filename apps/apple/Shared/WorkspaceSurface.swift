import SwiftUI

/// The cool-sapphire sky behind NexBot (`stage`), opaque Emerald-Teal Studio (`nexAgent`),
/// and the flat surfaces of sheets and settings.
struct WorkspaceSurface: View {
    enum Kind { case stage, sidebar, reading, nexAgent, login }
    var kind: Kind
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        Group {
            switch kind {
            case .stage: sky
            case .nexAgent: Theme.nexAgentCanvas
            case .login: loginBackdrop
            case .sidebar, .reading: flat
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    private var loginBackdrop: some View {
        GeometryReader { proxy in
            let w = proxy.size.width, h = proxy.size.height, reach = max(w, h)
            ZStack {
                Theme.atmosphereBase
                if !reduceTransparency {
                    RadialGradient(colors: [Theme.atmosphereBlue.opacity(0.65), .clear], center: UnitPoint(x: 0.18, y: 0.12), startRadius: 0, endRadius: reach * 0.62)
                    RadialGradient(colors: [Theme.atmosphereBlush.opacity(0.55), .clear], center: UnitPoint(x: 0.85, y: 0.88), startRadius: 0, endRadius: reach * 0.58)
                }
            }
            .frame(width: w, height: h)
            .clipped()
        }
    }

    private var flat: some View {
        ZStack {
            kind == .sidebar ? Theme.sidebar : Theme.background
            if !reduceTransparency {
                LinearGradient(colors: [Theme.atmosphereBlue.opacity(0.16), .clear, Theme.atmosphereBlush.opacity(0.09)], startPoint: .topLeading, endPoint: .bottomTrailing)
                LinearGradient(colors: [Theme.atmosphereLight.opacity(kind == .sidebar ? 0.48 : 0.2), .clear], startPoint: .topTrailing, endPoint: .bottomLeading)
            }
        }
    }

    private var sky: some View {
        GeometryReader { proxy in
            let w = proxy.size.width, h = proxy.size.height, reach = max(w, h)
            ZStack {
                Theme.skyBase
                RadialGradient(colors: [Theme.skyPearl, .clear], center: UnitPoint(x: 0.06, y: 0), startRadius: 0, endRadius: reach * 0.55)
                RadialGradient(colors: [Theme.skyBlue, .clear], center: UnitPoint(x: 0, y: 0.88), startRadius: 0, endRadius: reach * 0.6)
                RadialGradient(colors: [Theme.skyBlush, .clear], center: UnitPoint(x: 1, y: 0), startRadius: 0, endRadius: reach * 0.5)
                RadialGradient(colors: [Theme.skyMist, .clear], center: UnitPoint(x: 0.78, y: 1.06), startRadius: 0, endRadius: reach * 0.62)
                if !reduceTransparency {
                    ZStack {
                        Ellipse().fill(Theme.swirl).frame(width: w * 0.5, height: h * 0.2).position(x: w * 0.56, y: h * 0.44)
                        Ellipse().fill(Theme.swirl).frame(width: w * 0.3, height: h * 0.36).position(x: w * 0.3, y: h * 0.62)
                        Ellipse().fill(Theme.swirl).frame(width: w * 0.26, height: h * 0.18).position(x: w * 0.74, y: h * 0.72)
                    }
                    .rotationEffect(.degrees(-14))
                    .blur(radius: 34)
                }
            }
            .frame(width: w, height: h)
            .clipped()
        }
    }
}

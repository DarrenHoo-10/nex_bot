import SwiftUI

/// The approved silver-blue surfaces, adapted to native panes and narrow screens.
struct WorkspaceSurface: View {
    enum Kind { case stage, sidebar, reading }
    var kind: Kind
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        ZStack {
            switch kind {
            case .stage: Theme.atmosphereBase
            case .sidebar: Theme.sidebar
            case .reading: Theme.background
            }
            if !reduceTransparency {
                LinearGradient(colors: [Theme.atmosphereBlue.opacity(kind == .stage ? 0.7 : 0.16), .clear, Theme.atmosphereBlush.opacity(kind == .stage ? 0.45 : 0.09)], startPoint: .topLeading, endPoint: .bottomTrailing)
                LinearGradient(colors: [Theme.atmosphereLight.opacity(kind == .sidebar ? 0.48 : 0.2), .clear], startPoint: .topTrailing, endPoint: .bottomLeading)
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

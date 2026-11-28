import SwiftUI

/// Design tokens aligned with the NexBot Bright-Blue Design System (`src/personal/theme.css`)
/// and the NexAgent Opaque Emerald-Teal Studio, shared by the Mac and iOS apps.
/// Every color follows the system light/dark appearance.
enum Theme {
    // MARK: - NexBot Bright-Blue Design System
    static let background = dynamic(light: 0xF7FAFF, dark: 0x0F1726)
    static let foreground = dynamic(light: 0x151E2E, dark: 0xEBF1FA)
    static let card = dynamic(light: 0xFFFFFF, dark: 0x172234)
    /// Fills: search field, secondary buttons, subtle pills.
    static let secondary = dynamic(light: 0xEDF2F9, dark: 0x1E2C42)
    static let muted = dynamic(light: 0x627189, dark: 0x8A9BB5)
    static let border = dynamic(light: 0x18346C, dark: 0xB0CEFF, lightAlpha: 0.08, darkAlpha: 0.10)
    static let borderStrong = dynamic(light: 0x18346C, dark: 0xB0CEFF, lightAlpha: 0.14, darkAlpha: 0.16)
    static let sidebar = dynamic(light: 0xFFFFFF, dark: 0x111927, lightAlpha: 0.74, darkAlpha: 0.80)
    /// Selected contact row and hovered menu items.
    static let sidebarAccent = dynamic(light: 0x3569E8, dark: 0x5586FF, lightAlpha: 0.08, darkAlpha: 0.14)
    /// Primary actions (发送, 批准, unread badge, CTAs): unified NexBot Bright Blue.
    static let primary = dynamic(light: 0x3569E8, dark: 0x5586FF)
    static let primaryForeground = Color.white
    /// Brand blue of the NexBot mark: links, active icons, selected tabs and focus rings.
    static let identityAccent = dynamic(light: 0x3569E8, dark: 0x5586FF)
    static let brand = dynamic(light: 0x3569E8, dark: 0x5586FF)
    static let brandInk = dynamic(light: 0x2352CA, dark: 0x8FB6FF)
    static let brandSoft = dynamic(light: 0x3569E8, dark: 0x5586FF, lightAlpha: 0.10, darkAlpha: 0.16)
    static let brandRing = dynamic(light: 0x3569E8, dark: 0x6E9CFF, lightAlpha: 0.42, darkAlpha: 0.50)
    static let chatUser = dynamic(light: 0xE8F0FE, dark: 0x1E3357)
    static let userBubbleTop = dynamic(light: 0x4B81F8, dark: 0x4678F2)
    static let userBubbleBottom = dynamic(light: 0x2D60E5, dark: 0x2B59D4)
    static let atmosphereBase = dynamic(light: 0xEDF3FC, dark: 0x0B1220)
    static let atmosphereBlue = dynamic(light: 0xC8DEFC, dark: 0x162B4F)
    static let atmosphereBlush = dynamic(light: 0xE2E9FB, dark: 0x1A2442)
    static let atmosphereLight = dynamic(light: 0xFFFFFF, dark: 0x15233A)

    // MARK: - NexAgent Opaque Emerald-Teal Studio
    static let nexAgentNav = dynamic(light: 0xF1F5F3, dark: 0x0C1311)
    static let nexAgentCanvas = dynamic(light: 0xF7FAF8, dark: 0x0F1715)
    static let nexAgentSurface = dynamic(light: 0xFFFFFF, dark: 0x121C19)
    static let nexAgentInset = dynamic(light: 0xECF3EF, dark: 0x16221F)
    static let nexAgentInk = dynamic(light: 0x11201B, dark: 0xE6F0EC)
    static let nexAgentMuted = dynamic(light: 0x5A7067, dark: 0x8FA39B)
    static let nexAgentBorder = dynamic(light: 0x0F2A21, dark: 0xD4F0E5, lightAlpha: 0.09, darkAlpha: 0.10)
    static let nexAgentBorderStrong = dynamic(light: 0x0F2A21, dark: 0xD4F0E5, lightAlpha: 0.16, darkAlpha: 0.18)
    static let nexAgentAccent = dynamic(light: 0x0E7A5F, dark: 0x2AB58A)
    static let nexAgentSolid = dynamic(light: 0x0E7A5F, dark: 0x158765)
    static let nexAgentSoft = dynamic(light: 0x0E7A5F, dark: 0x2AB58A, lightAlpha: 0.10, darkAlpha: 0.16)
    static let nexAgentRing = dynamic(light: 0x0E7A5F, dark: 0x2AB58A, lightAlpha: 0.34, darkAlpha: 0.42)
    static let nexAgentBubbleTop = dynamic(light: 0x158C6D, dark: 0x188567)
    static let nexAgentBubbleBottom = dynamic(light: 0x0D6F55, dark: 0x11664F)

    // MARK: - Semantic Status Colors (dual light/dark)
    static let approval = dynamic(light: 0xD97706, dark: 0xFBBF24)
    static let approvalSoft = dynamic(light: 0xD97706, dark: 0xFBBF24, lightAlpha: 0.12, darkAlpha: 0.16)
    static let success = dynamic(light: 0x16A34A, dark: 0x4ADE80)
    static let successSoft = dynamic(light: 0x16A34A, dark: 0x4ADE80, lightAlpha: 0.12, darkAlpha: 0.16)
    static let danger = dynamic(light: 0xDC2626, dark: 0xF87171)
    static let offline = dynamic(light: 0x93979C, dark: 0x7A8699)

    // MARK: - Cool Sapphire Atmosphere & Glass Surfaces
    static let skyBase = dynamic(light: 0xDCE6F5, dark: 0x060B14)
    static let skyPearl = dynamic(light: 0xFFFFFF, dark: 0x15233A)
    static let skyBlue = dynamic(light: 0xC8DEFC, dark: 0x162B4F)
    static let skyBlush = dynamic(light: 0xE2E9FB, dark: 0x1A2442)
    static let skyMist = dynamic(light: 0xF4F8FE, dark: 0x0F1726)
    static let swirl = dynamic(light: 0xFFFFFF, dark: 0x76A8FF, lightAlpha: 0.72, darkAlpha: 0.07)
    static let glass = dynamic(light: 0xFFFFFF, dark: 0x111A28, lightAlpha: 0.72, darkAlpha: 0.78)
    static let glassStrong = dynamic(light: 0xFFFFFF, dark: 0x182436, lightAlpha: 0.90, darkAlpha: 0.92)
    static let glassEdge = dynamic(light: 0xFFFFFF, dark: 0xB0CEFF, lightAlpha: 0.88, darkAlpha: 0.12)
    static let wash = dynamic(light: 0x355694, dark: 0x94B8F0, lightAlpha: 0.065, darkAlpha: 0.09)
    static let shadowInk = dynamic(light: 0x142A56, dark: 0x000000)
    /// Brand accent default (`#3569e8`).
    static let defaultAccent: UInt32 = 0x3569E8

    /// Reading column width of the chat, as in the web UI.
    static let readingWidth: CGFloat = 700

    static func dynamic(light: UInt32, dark: UInt32, lightAlpha: Double = 1, darkAlpha: Double = 1) -> Color {
        #if os(macOS)
        Color(nsColor: NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(hex: dark, alpha: darkAlpha) : NSColor(hex: light, alpha: lightAlpha) })
        #else
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark, alpha: darkAlpha) : UIColor(hex: light, alpha: lightAlpha) })
        #endif
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double(hex >> 16 & 0xFF) / 255, green: Double(hex >> 8 & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

#if os(macOS)
extension NSColor {
    convenience init(hex: UInt32, alpha: Double = 1) {
        self.init(srgbRed: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: CGFloat(alpha))
    }
}
#else
extension UIColor {
    convenience init(hex: UInt32, alpha: Double = 1) {
        self.init(red: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: CGFloat(alpha))
    }
}
#endif

/// The blue NexBot companion mark (`nexbot-mark.svg`) or matching green NexAgent companion mark (`nexagent-mark.svg`).
struct BrandMark: View {
    var size: CGFloat = 28
    var agent: Bool = false
    var body: some View {
        Image(agent ? "NexAgentMark" : "NexBotMark")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

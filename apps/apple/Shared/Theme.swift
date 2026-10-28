import SwiftUI

/// Design tokens of the NexBot web UI (`src/personal/atmosphere.css`), shared by the Mac and iOS apps.
/// Every color follows the system light/dark appearance.
enum Theme {
    static let background = dynamic(light: 0xFBFDFF, dark: 0x151E2A)
    static let foreground = dynamic(light: 0x202B3C, dark: 0xE5EDF7)
    static let card = dynamic(light: 0xFFFFFF, dark: 0x202D3E)
    /// Fills: search field, user bubble, secondary buttons.
    static let secondary = dynamic(light: 0xEAF0F6, dark: 0x253347)
    static let muted = dynamic(light: 0x647287, dark: 0xA0B0C5)
    static let border = dynamic(light: 0xDFE6EE, dark: 0x34465A)
    static let sidebar = dynamic(light: 0xEEF6FC, dark: 0x1D2C40)
    /// Selected contact row and hovered menu items.
    static let sidebarAccent = dynamic(light: 0xFFFFFF, dark: 0x2B3D53)
    /// Primary actions (批准, unread badge): near-black in light mode, near-white in dark mode.
    static let primary = dynamic(light: 0x26384B, dark: 0xE5EDF7)
    static let primaryForeground = dynamic(light: 0xFFFFFF, dark: 0x151E2A)
    /// Brand blue of the NexBot mark: the login button, links and the selected settings category.
    static let identityAccent = dynamic(light: 0x227B79, dark: 0x8BC9BF)
    static let chatUser = dynamic(light: 0xEAF2FF, dark: 0x293E59)
    static let atmosphereBase = dynamic(light: 0xE4EDF5, dark: 0x0E1827)
    static let atmosphereBlue = dynamic(light: 0xB8D9F2, dark: 0x274867)
    static let atmosphereBlush = dynamic(light: 0xEEDEDC, dark: 0x3E354B)
    static let atmosphereLight = dynamic(light: 0xFFFFFF, dark: 0x263A50)
    static let brand = Color(hex: 0x4B6BFB)
    static let brandSoft = dynamic(light: 0xE9EEFF, dark: 0x1B2340)
    static let approval = Color(hex: 0xD79A37)
    static let approvalSoft = dynamic(light: 0xFDF6EA, dark: 0x241D12)
    static let success = Color(hex: 0x398B76)
    static let successSoft = dynamic(light: 0xE6F4EE, dark: 0x13241F)
    static let danger = Color(hex: 0xC15F55)
    static let offline = Color(hex: 0x93979C)

    // The floating glass workspace (`src/personal/glass.css`): the sky behind the panels, the translucent
    // panel fills and the quiet wash used for chips and fields.
    static let skyBase = dynamic(light: 0xDAE3ED, dark: 0x0B1420)
    static let skyPearl = dynamic(light: 0xFFFFFF, dark: 0x1E3044)
    static let skyBlue = dynamic(light: 0xB7D3E9, dark: 0x1C3A58)
    static let skyBlush = dynamic(light: 0xF0E1D5, dark: 0x3A3026)
    static let skyMist = dynamic(light: 0xF2F6FA, dark: 0x0F1A28)
    static let swirl = dynamic(light: 0xFFFFFF, dark: 0x96BEE7, lightAlpha: 0.6, darkAlpha: 0.08)
    static let glass = dynamic(light: 0xFFFFFF, dark: 0x162130, lightAlpha: 0.5, darkAlpha: 0.5)
    static let glassStrong = dynamic(light: 0xFFFFFF, dark: 0x202E40, lightAlpha: 0.74, darkAlpha: 0.74)
    static let glassEdge = dynamic(light: 0xFFFFFF, dark: 0xBED7F5, lightAlpha: 0.8, darkAlpha: 0.12)
    static let wash = dynamic(light: 0x6E8098, dark: 0xAAC3E1, lightAlpha: 0.1, darkAlpha: 0.08)
    static let shadowInk = dynamic(light: 0x1E3250, dark: 0x000000)
    /// The accent of an Agent without a companion colour (`--bot-color` default of the web UI).
    static let defaultAccent: UInt32 = 0x23756D

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

/// The blue NexBot companion mark (`src/personal/assets/nexbot-mark.svg`).
struct BrandMark: View {
    var size: CGFloat = 28
    var body: some View {
        Image("NexBotMark").resizable().scaledToFit().frame(width: size, height: size).accessibilityHidden(true)
    }
}

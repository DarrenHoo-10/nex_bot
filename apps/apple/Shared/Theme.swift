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

    /// Reading column width of the chat, as in the web UI.
    static let readingWidth: CGFloat = 800

    static func dynamic(light: UInt32, dark: UInt32) -> Color {
        #if os(macOS)
        Color(nsColor: NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(hex: dark) : NSColor(hex: light) })
        #else
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
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
    convenience init(hex: UInt32) {
        self.init(srgbRed: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}
#else
extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
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

import SwiftUI

/// Design tokens of the NexBot web UI (`src/personal/vendor/rakazo/tokens.css`), shared by the Mac and iOS apps.
/// Every color follows the system light/dark appearance.
enum Theme {
    static let background = dynamic(light: 0xFAFAF8, dark: 0x0B0C0E)
    static let foreground = dynamic(light: 0x1A1A1A, dark: 0xECECEE)
    static let card = dynamic(light: 0xFFFFFF, dark: 0x141518)
    /// Fills: search field, user bubble, secondary buttons.
    static let secondary = dynamic(light: 0xF0F0ED, dark: 0x18191E)
    static let muted = dynamic(light: 0x6C6C70, dark: 0x85858A)
    static let border = dynamic(light: 0xE8E8E4, dark: 0x1E2026)
    static let sidebar = dynamic(light: 0xFAFAF8, dark: 0x0B0C0E)
    /// Selected contact row and hovered menu items.
    static let sidebarAccent = dynamic(light: 0xFFFFFF, dark: 0x1A1B20)
    /// Primary actions (批准, unread badge): near-black in light mode, near-white in dark mode.
    static let primary = dynamic(light: 0x1A1A1A, dark: 0xF1F1EF)
    static let primaryForeground = dynamic(light: 0xFFFFFF, dark: 0x111215)
    /// Brand blue of the NexBot mark: the login button, links and the selected settings category.
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

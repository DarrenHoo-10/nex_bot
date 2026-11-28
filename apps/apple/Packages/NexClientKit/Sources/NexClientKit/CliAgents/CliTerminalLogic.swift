import Foundation

// Pure terminal helpers shared by macOS and iOS (ports of `terminal-logic.ts`):
// color themes, cursor styles, tri-state key-bar modifiers, VT key encoding,
// file path escaping, paste helpers and saved quick commands.

// MARK: Themes

public enum CliTermThemeID: String, CaseIterable, Sendable, Identifiable {
    case ink, midnight, page, solarized

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .ink: "墨黑"
        case .midnight: "午夜"
        case .page: "跟随外观"
        case .solarized: "Solarized"
        }
    }

    public var alwaysDark: Bool {
        self == .ink || self == .midnight
    }

    public static func named(_ raw: String) -> CliTermThemeID {
        CliTermThemeID(rawValue: raw) ?? .ink
    }
}

public struct CliTermPalette: Sendable, Equatable {
    public var background: UInt32
    public var foreground: UInt32
    public var cursor: UInt32
    public var cursorAccent: UInt32
    public var selection: UInt32
    public var ansi: [UInt32] // 16 standard + bright ANSI colors
    public var isDark: Bool

    public static let ink = CliTermPalette(
        background: 0x0C0C0E, foreground: 0xDCDFE4, cursor: 0x7AA2F7, cursorAccent: 0x0C0C0E, selection: 0x2F4668,
        ansi: [
            0x2A2C33, 0xF7768E, 0x73DACA, 0xE0AF68, 0x7AA2F7, 0xBB9AF7, 0x7DCFFF, 0xC0C4CE,
            0x5A5F6E, 0xFF8FA3, 0x9AF0DC, 0xF2C88A, 0x9DBBFF, 0xD0B6FF, 0xA4E0FF, 0xF4F5F7,
        ],
        isDark: true
    )

    public static let midnight = CliTermPalette(
        background: 0x12161A, foreground: 0xD7DDE3, cursor: 0x4EA87E, cursorAccent: 0x12161A, selection: 0x335347,
        ansi: [
            0x2B323A, 0xF0646E, 0x67C593, 0xE5C07B, 0x61AFEF, 0xC678DD, 0x56B6C2, 0xC8D0D8,
            0x5C6773, 0xFF7B85, 0x8AE0B2, 0xF2D28E, 0x82C4FF, 0xDA9AEE, 0x7FD3DD, 0xF2F5F7,
        ],
        isDark: true
    )

    public static let pageLight = CliTermPalette(
        background: 0xFBFCF9, foreground: 0x1E3228, cursor: 0x176643, cursorAccent: 0xFBFCF9, selection: 0xCDE8D8,
        ansi: [
            0x20362B, 0xCF222E, 0x176643, 0x9A6700, 0x0550AE, 0x8250DF, 0x1B7C83, 0x5E7266,
            0x52685A, 0xA40E26, 0x1E7E53, 0x7D4E00, 0x0969DA, 0xA475F9, 0x2B8D94, 0x83968A,
        ],
        isDark: false
    )

    public static let pageDark = CliTermPalette(
        background: 0x171C19, foreground: 0xE8EEEA, cursor: 0x38A36C, cursorAccent: 0x171C19, selection: 0x264334,
        ansi: [
            0x353D38, 0xF0646E, 0x73CF9C, 0xE5C07B, 0x6BB4F2, 0xC678DD, 0x56B6C2, 0xC4CEC8,
            0x637069, 0xFF7B85, 0x95E3B8, 0xF2D28E, 0x8CC8FF, 0xDA9AEE, 0x7FD3DD, 0xF3F7F5,
        ],
        isDark: true
    )

    public static let solarizedLight = CliTermPalette(
        background: 0xFDF6E3, foreground: 0x586E75, cursor: 0x268BD2, cursorAccent: 0xFDF6E3, selection: 0xEEE8D5,
        ansi: [
            0x073642, 0xDC322F, 0x859900, 0xB58900, 0x268BD2, 0xD33682, 0x2AA198, 0xEEE8D5,
            0x002B36, 0xCB4B16, 0x586E75, 0x657B83, 0x839496, 0x6C71C4, 0x93A1A1, 0xFDF6E3,
        ],
        isDark: false
    )

    public static let solarizedDark = CliTermPalette(
        background: 0x002B36, foreground: 0x93A1A1, cursor: 0x268BD2, cursorAccent: 0x002B36, selection: 0x073642,
        ansi: [
            0x073642, 0xDC322F, 0x859900, 0xB58900, 0x268BD2, 0xD33682, 0x2AA198, 0xEEE8D5,
            0x586E75, 0xCB4B16, 0x657B83, 0x839496, 0x268BD2, 0x6C71C4, 0x93A1A1, 0xFDF6E3,
        ],
        isDark: true
    )

    public static func resolve(_ id: CliTermThemeID, dark: Bool) -> CliTermPalette {
        switch id {
        case .ink: .ink
        case .midnight: .midnight
        case .page: dark ? .pageDark : .pageLight
        case .solarized: dark ? .solarizedDark : .solarizedLight
        }
    }
}

// MARK: Cursor Style

public enum CliTermCursorStyle: String, CaseIterable, Sendable, Identifiable {
    case block, bar, underline

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .block: "方块"
        case .bar: "竖线"
        case .underline: "下划线"
        }
    }

    public static func named(_ raw: String) -> CliTermCursorStyle {
        CliTermCursorStyle(rawValue: raw) ?? .block
    }
}

// MARK: Modifiers

public enum CliTermModifierState: String, Sendable, Equatable {
    case off, once, held, locked
}

public enum CliTermModifierKey: String, CaseIterable, Sendable {
    case ctrl, alt, shift
}

public struct CliTermModifiers: Sendable, Equatable {
    public var ctrl: CliTermModifierState = .off
    public var alt: CliTermModifierState = .off
    public var shift: CliTermModifierState = .off
    private var usedWhileHeld = false

    public init(ctrl: CliTermModifierState = .off, alt: CliTermModifierState = .off, shift: CliTermModifierState = .off) {
        self.ctrl = ctrl; self.alt = alt; self.shift = shift
    }

    public subscript(_ key: CliTermModifierKey) -> CliTermModifierState {
        get {
            switch key {
            case .ctrl: ctrl
            case .alt: alt
            case .shift: shift
            }
        }
        set {
            switch key {
            case .ctrl: ctrl = newValue
            case .alt: alt = newValue
            case .shift: shift = newValue
            }
        }
    }

    public var active: Bool {
        ctrl != .off || alt != .off || shift != .off
    }

    public func apply(_ key: String) -> String {
        guard key != "esc" else { return key }
        let names: [(CliTermModifierKey, String)] = [(.ctrl, "ctrl"), (.alt, "alt"), (.shift, "shift")]
        return (names.filter { self[$0.0] != .off }.map(\.1) + [key]).joined(separator: "+")
    }

    public mutating func pressed() {
        for key in CliTermModifierKey.allCases {
            if self[key] == .once { self[key] = .off }
            if self[key] == .held { usedWhileHeld = true }
        }
    }

    public mutating func tap(_ key: CliTermModifierKey, quick: Bool) {
        switch self[key] {
        case .off: self[key] = .once
        case .once: self[key] = quick ? .locked : .off
        case .held, .locked: self[key] = .off
        }
    }

    public mutating func hold(_ key: CliTermModifierKey) {
        self[key] = .held
        usedWhileHeld = false
    }

    public mutating func release(_ key: CliTermModifierKey) {
        guard self[key] == .held else { return }
        self[key] = usedWhileHeld ? .off : .once
    }

    public func typed(_ ch: Character) -> (key: String?, text: String?) {
        let ctrlOrAlt = ctrl != .off || alt != .off
        if !ctrlOrAlt { return (nil, shift != .off ? ch.uppercased() : String(ch)) }
        guard ch.isASCII, !ch.isNewline else { return (nil, String(ch)) }
        let name = ch == " " ? "space" : ch == "\t" ? "tab" : ch.lowercased()
        return (apply(name), nil)
    }
}

// MARK: VT Key Encoding

public enum CliTermKeyEncoder {
    public static func encode(_ name: String, appCursor: Bool = false) -> Data? {
        var parts = name.lowercased().split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        if parts.count > 2, parts[parts.count - 1].isEmpty, parts[parts.count - 2].isEmpty {
            parts.removeLast(2)
            parts.append("+")
        }
        guard let base = parts.popLast(), !base.isEmpty else { return nil }
        let ctrl = parts.contains("ctrl") || parts.contains("control")
        let alt = parts.contains("alt") || parts.contains("meta") || parts.contains("option")
        let shift = parts.contains("shift")
        let esc = "\u{1B}"
        let mod = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0)

        let csiFinal: [String: String] = ["up": "A", "down": "B", "right": "C", "left": "D", "home": "H", "end": "F"]
        if let final = csiFinal[base] {
            let seq = mod == 1 ? "\(esc)\(appCursor ? "O" : "[")\(final)" : "\(esc)[1;\(mod)\(final)"
            return Data(seq.utf8)
        }
        let tilde: [String: Int] = [
            "insert": 2, "delete": 3, "pageup": 5, "pagedown": 6,
            "f5": 15, "f6": 17, "f7": 18, "f8": 19, "f9": 20, "f10": 21, "f11": 23, "f12": 24,
        ]
        if let code = tilde[base] {
            let seq = mod == 1 ? "\(esc)[\(code)~" : "\(esc)[\(code);\(mod)~"
            return Data(seq.utf8)
        }
        let ss3: [String: String] = ["f1": "P", "f2": "Q", "f3": "R", "f4": "S"]
        if let final = ss3[base] {
            let seq = mod == 1 ? "\(esc)O\(final)" : "\(esc)[1;\(mod)\(final)"
            return Data(seq.utf8)
        }

        let prefix = alt ? esc : ""
        switch base {
        case "enter", "return":
            return Data((shift || alt ? "\(esc)\r" : "\r").utf8)
        case "tab":
            return Data((shift ? "\(esc)[Z" : "\(prefix)\t").utf8)
        case "esc", "escape":
            return Data(esc.utf8)
        case "backspace":
            return Data((prefix + (ctrl ? "\u{08}" : "\u{7F}")).utf8)
        case "space":
            return Data((prefix + (ctrl ? "\u{00}" : " ")).utf8)
        default:
            break
        }

        guard base.count == 1, let scalar = base.unicodeScalars.first else { return nil }
        if ctrl {
            if scalar >= "a" && scalar <= "z" {
                let value = UInt8(scalar.value - 0x60)
                return Data(prefix.utf8) + Data([value])
            }
            switch base {
            case "@", "2": return Data(prefix.utf8) + Data([0x00])
            case "[", "3": return Data([0x1B])
            case "\\", "4": return Data(prefix.utf8) + Data([0x1C])
            case "]", "5": return Data(prefix.utf8) + Data([0x1D])
            case "^", "6": return Data(prefix.utf8) + Data([0x1E])
            case "_", "-", "7", "/": return Data(prefix.utf8) + Data([0x1F])
            case "?", "8": return Data(prefix.utf8) + Data([0x7F])
            default: return Data((prefix + base).utf8)
            }
        }
        return Data((prefix + (shift ? base.uppercased() : base)).utf8)
    }

    public static func keyName(for data: Data) -> String? {
        guard let str = String(data: data, encoding: .utf8) else { return nil }
        switch str {
        case "\r": return "enter"
        case "\u{7F}", "\u{08}": return "backspace"
        case "\t": return "tab"
        case "\u{1B}": return "esc"
        case "\u{1B}[A", "\u{1B}OA": return "up"
        case "\u{1B}[B", "\u{1B}OB": return "down"
        case "\u{1B}[C", "\u{1B}OC": return "right"
        case "\u{1B}[D", "\u{1B}OD": return "left"
        case "\u{1B}[H", "\u{1B}OH": return "home"
        case "\u{1B}[F", "\u{1B}OF": return "end"
        default: return nil
        }
    }
}

// MARK: Paste & Path Escaping

public enum CliTermPaste {
    public static func isWindowsPath(_ path: String) -> Bool {
        if path.hasPrefix("\\\\") { return true }
        let scalars = Array(path.unicodeScalars)
        return scalars.count >= 3 && scalars[0].isASCII && scalars[0].properties.isAlphabetic && scalars[1] == ":" && scalars[2] == "\\"
    }

    public static func escapePath(_ path: String) -> String {
        if isWindowsPath(path) {
            let special = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\"'`$&|;<>()^%!"))
            guard path.unicodeScalars.contains(where: { special.contains($0) }) else { return path }
            return "\"" + path.replacingOccurrences(of: "\"", with: "\\\"") + "\""
        }
        var out = ""
        for scalar in path.unicodeScalars {
            let safe = scalar.value >= 0x80 ||
                (scalar >= "a" && scalar <= "z") || (scalar >= "A" && scalar <= "Z") ||
                (scalar >= "0" && scalar <= "9") || "_@%+=:,./-".unicodeScalars.contains(scalar)
            if !safe { out.append("\\") }
            out.unicodeScalars.append(scalar)
        }
        return out
    }

    public static func pastedPaths(_ paths: [String]) -> String {
        paths.map(escapePath).joined(separator: " ") + " "
    }

    public static func lineCount(_ text: String) -> Int {
        var normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
        if normalized.hasSuffix("\n") { normalized.removeLast() }
        return normalized.split(separator: "\n", omittingEmptySubsequences: false).count
    }

    public static func pasteData(_ text: String, bracketed: Bool = true) -> Data {
        let hasNewline = text.contains("\n") || text.contains("\r")
        if !bracketed || !hasNewline {
            return Data(text.replacingOccurrences(of: "\r\n", with: "\r").replacingOccurrences(of: "\n", with: "\r").utf8)
        }
        let body = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\n", with: "\r")
        return Data(("\u{1B}[200~" + body + "\u{1B}[201~").utf8)
    }

    public static func webLink(_ uri: String) -> URL? {
        guard let url = URL(string: uri),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty else { return nil }
        return url
    }
}

// MARK: Saved Quick Commands

public enum CliTermShortcuts {
    public static let defaults = ["git status", "git diff --stat", "ls -la", "/compact", "/status"]

    public static func decode(_ json: String) -> [String] {
        guard !json.isEmpty, let list = try? JSONDecoder().decode([String].self, from: Data(json.utf8)) else {
            return defaults
        }
        return list
    }

    public static func encode(_ list: [String]) -> String {
        (try? String(decoding: JSONEncoder().encode(list), as: UTF8.self)) ?? "[]"
    }

    public static func move(_ list: [String], from index: Int, by delta: Int) -> [String] {
        let to = index + delta
        guard index >= 0, index < list.count, to >= 0, to < list.count else { return list }
        var copy = list
        copy.swapAt(index, to)
        return copy
    }
}

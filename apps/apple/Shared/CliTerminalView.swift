import SwiftUI
import NexClientKit
import SwiftTerm

#if os(macOS)
import AppKit
typealias CliPlatformFont = NSFont
typealias CliPlatformColor = NSColor
#else
import UIKit
typealias CliPlatformFont = UIFont
typealias CliPlatformColor = UIColor
#endif

/// One plain-text search match recorded from the terminal output buffer.
struct CliTermSearchMatch: Equatable, Identifiable {
    let id: Int
    let lineIndex: Int
    let lineText: String
}

/// Action bridge allowing the toolbar and key bar to interact with the underlying SwiftTerm view.
@MainActor
final class CliTerminalActions {
    weak var view: TerminalView?
    /// Plain-text scrollback lines captured from terminal output for reliable cross-platform FindBar search.
    fileprivate var lines: [String] = [""]
    /// True when the previous chunk/scalar ended with CR (`\r`), so CRLF (even split across chunks) advances
    /// a line cleanly while standalone CR followed by printable text overwrites the current line.
    fileprivate var pendingCR = false

    var isAppCursor: Bool {
        view?.getTerminal().applicationCursor ?? false
    }

    var hasSelection: Bool {
        guard let text = view?.getSelection() else { return false }
        return !text.isEmpty
    }

    var selectionText: String? {
        guard let text = view?.getSelection(), !text.isEmpty else { return nil }
        return text
    }

    fileprivate func resetOutputBuffer() {
        lines = [""]
        pendingCR = false
    }

    fileprivate func recordOutput(_ data: Data) {
        guard let chunk = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1), !chunk.isEmpty else { return }
        let stripped = Self.stripAnsi(chunk)
        for scalar in stripped.unicodeScalars {
            if scalar == "\n" {
                pendingCR = false
                lines.append("")
                if lines.count > 2000 { lines.removeFirst(lines.count - 2000) }
            } else if scalar == "\r" {
                pendingCR = true
            } else if scalar == "\u{08}" || scalar == "\u{7f}" {
                if pendingCR {
                    pendingCR = false
                    if !lines.isEmpty { lines[lines.count - 1] = "" }
                }
                if !lines.isEmpty, !lines[lines.count - 1].isEmpty { lines[lines.count - 1].removeLast() }
            } else if scalar.value >= 0x20 || scalar == "\t" {
                if pendingCR {
                    pendingCR = false
                    if !lines.isEmpty { lines[lines.count - 1] = "" }
                }
                if lines.isEmpty { lines.append("") }
                lines[lines.count - 1].unicodeScalars.append(scalar)
            }
        }
    }

    func findMatches(query: String, caseSensitive: Bool) -> [CliTermSearchMatch] {
        guard !query.isEmpty else { return [] }
        let options: String.CompareOptions = caseSensitive ? [] : [.caseInsensitive]
        var matches: [CliTermSearchMatch] = []
        for (idx, line) in lines.enumerated() {
            guard !line.isEmpty, line.range(of: query, options: options) != nil else { continue }
            matches.append(CliTermSearchMatch(id: matches.count, lineIndex: idx, lineText: line.trimmingCharacters(in: .whitespaces)))
            if matches.count >= 999 { break }
        }
        return matches
    }

    private static func stripAnsi(_ text: String) -> String {
        text
            .replacingOccurrences(of: #"\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\x1B\[[0-9;?]*[ -/]*[@-~]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\x1B[@-Z\\-_]"#, with: "", options: .regularExpression)
    }

    @discardableResult
    func copySelection() -> Bool {
        guard let view, let text = view.getSelection(), !text.isEmpty else { return false }
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
        view.selectNone()
        return true
    }

    func selectAll() {
        view?.selectAll()
    }

    func clearSelection() {
        view?.selectNone()
    }

    func focus() {
        guard let view else { return }
        #if os(macOS)
        view.window?.makeFirstResponder(view)
        #else
        _ = view.becomeFirstResponder()
        #endif
    }

    func toggleKeyboard() {
        #if os(iOS)
        guard let view else { return }
        if view.isFirstResponder {
            _ = view.resignFirstResponder()
        } else {
            _ = view.becomeFirstResponder()
        }
        #else
        focus()
        #endif
    }
}

/// Moves bytes, sizes, themes and key-bar modifiers between SwiftTerm and `CliTerminalController`.
@MainActor
final class CliTerminalBridge: NSObject, TerminalViewDelegate {
    private let controller: CliTerminalController
    private let actions: CliTerminalActions
    private weak var view: TerminalView?
    private var device: (cols: Int, rows: Int)?
    private var width: CGFloat = 0
    private var appliedFontSize: CGFloat = 0
    private var control = false
    private var appliedStyle: CliTerminalStyle?
    var transformInput: (@MainActor (Data, Bool) -> Data)?
    var onPinchFontSize: (@MainActor (CGFloat) -> Void)?
    var onClipboardCopy: (@MainActor () -> Void)?
    var onOpenFind: (@MainActor () -> Void)?
    var onPasteCommand: (@MainActor () -> Void)?
    #if os(iOS)
    private var pinchBaseSize: CGFloat = CGFloat(CliTerminalPrefKeys.defaultFontSize)
    #endif

    init(controller: CliTerminalController, actions: CliTerminalActions) {
        self.controller = controller
        self.actions = actions
        super.init()
    }

    func attach(_ view: TerminalView, style: CliTerminalStyle) {
        self.view = view
        actions.view = view
        view.terminalDelegate = self
        view.changeScrollback(2000)
        #if os(iOS)
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handlePinch(_:)))
        view.addGestureRecognizer(pinch)
        #endif
        applyStyle(style, force: true)
        controller.onOpened = { [weak self] cols, rows in self?.opened(cols: cols, rows: rows) }
        controller.onResize = { [weak self] cols, rows in self?.device = (cols, rows); self?.fit() }
        controller.onOutput = { [weak self] data in
            self?.actions.recordOutput(data)
            self?.view?.feed(byteArray: ArraySlice([UInt8](data)))
        }
        controller.begin()
    }

    func detach() {
        controller.onOpened = nil
        controller.onResize = nil
        controller.onOutput = nil
        view?.terminalDelegate = nil
        if actions.view === view { actions.view = nil }
    }

    /// Called whenever SwiftUI lays the view out, mode flips or visual settings change.
    func update(width: CGFloat, control: Bool, style: CliTerminalStyle) {
        let modeChanged = self.control != control
        self.width = width
        self.control = control
        applyStyle(style, force: modeChanged)
        fit()
        if control, modeChanged { actions.focus() }
    }

    private static func mono(_ size: CGFloat) -> CliPlatformFont {
        CliPlatformFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }

    private static func swiftTermCursorStyle(_ style: CliTermCursorStyle, blink: Bool) -> SwiftTerm.CursorStyle {
        switch (style, blink) {
        case (.block, true): .blinkBlock
        case (.block, false): .steadyBlock
        case (.bar, true): .blinkBar
        case (.bar, false): .steadyBar
        case (.underline, true): .blinkUnderline
        case (.underline, false): .steadyUnderline
        }
    }

    private static func swiftTermColor(_ hex: UInt32) -> SwiftTerm.Color {
        SwiftTerm.Color(
            red8: UInt16((hex >> 16) & 0xFF),
            green8: UInt16((hex >> 8) & 0xFF),
            blue8: UInt16(hex & 0xFF)
        )
    }

    private func applyStyle(_ style: CliTerminalStyle, force: Bool) {
        guard let view else { return }
        let prev = appliedStyle
        guard force || prev != style else { return }
        appliedStyle = style

        let palette = style.palette
        if force || prev?.theme != style.theme || prev?.dark != style.dark {
            view.nativeBackgroundColor = CliPlatformColor(hex: palette.background)
            view.nativeForegroundColor = CliPlatformColor(hex: palette.foreground)
            view.caretColor = CliPlatformColor(hex: palette.cursor)
            view.caretTextColor = CliPlatformColor(hex: palette.cursorAccent)
            view.selectedTextBackgroundColor = CliPlatformColor(hex: palette.selection, alpha: 0.72)
            view.installColors(palette.ansi.map(Self.swiftTermColor))
            #if os(iOS)
            let appearance: UIKeyboardAppearance = palette.isDark ? .dark : .light
            if view.keyboardAppearance != appearance {
                view.keyboardAppearance = appearance
                if view.isFirstResponder { view.reloadInputViews() }
            }
            #endif
        }

        if force || prev?.cursorStyle != style.cursorStyle || prev?.cursorBlink != style.cursorBlink {
            view.getTerminal().setCursorStyle(Self.swiftTermCursorStyle(style.cursorStyle, blink: style.cursorBlink))
        }

        if force || prev?.optionAsMeta != style.optionAsMeta {
            view.optionAsMetaKey = style.optionAsMeta
        }

        if control, force || abs(appliedFontSize - style.fontSize) > 0.1 {
            appliedFontSize = style.fontSize
            view.font = Self.mono(style.fontSize)
        }
    }

    private func opened(cols: Int, rows: Int) {
        device = (cols, rows)
        actions.resetOutputBuffer()
        view?.getTerminal().resetToInitialState()
        if let style = appliedStyle {
            view?.getTerminal().setCursorStyle(Self.swiftTermCursorStyle(style.cursorStyle, blink: style.cursorBlink))
        }
        fit()
    }

    /// Watching shows the device's grid at a font that fits the width; operating lets the view size itself.
    private func fit() {
        guard let view, !control, let device, device.cols > 0, device.rows > 0, width > 0 else { return }
        let targetMax = appliedStyle?.fontSize ?? CGFloat(CliTerminalPrefKeys.defaultFontSize)
        let size = max(5, min(targetMax, ((width - 8) / (CGFloat(device.cols) * 0.61)).rounded(.down)))
        if abs(size - appliedFontSize) > 0.1 {
            appliedFontSize = size
            view.font = Self.mono(size)
        }
        let terminal = view.getTerminal()
        if terminal.cols != device.cols || terminal.rows != device.rows {
            view.resize(cols: device.cols, rows: device.rows)
        }
    }

    #if os(iOS)
    @objc private func handlePinch(_ recognizer: UIPinchGestureRecognizer) {
        switch recognizer.state {
        case .began:
            pinchBaseSize = appliedStyle?.fontSize ?? CGFloat(CliTerminalPrefKeys.defaultFontSize)
        case .changed:
            let next = (pinchBaseSize * recognizer.scale).rounded()
            let clamped = max(CGFloat(CliTerminalPrefKeys.minFontSize), min(CGFloat(CliTerminalPrefKeys.maxFontSize), next))
            if abs(clamped - (appliedStyle?.fontSize ?? pinchBaseSize)) >= 1 {
                onPinchFontSize?(clamped)
            }
        default:
            break
        }
    }
    #endif

    // MARK: TerminalViewDelegate

    nonisolated func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        MainActor.assumeIsolated {
            if control { controller.viewResized(cols: newCols, rows: newRows) }
            else { DispatchQueue.main.async { MainActor.assumeIsolated { self.fit() } } }
        }
    }

    nonisolated func send(source: TerminalView, data: ArraySlice<UInt8>) {
        let raw = Data(data)
        MainActor.assumeIsolated {
            let appCursor = source.getTerminal().applicationCursor
            let outgoing = transformInput?(raw, appCursor) ?? raw
            controller.sendInput(outgoing)
        }
    }

    nonisolated func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = CliTermPaste.webLink(link) else { return }
        MainActor.assumeIsolated {
            #if os(macOS)
            NSWorkspace.shared.open(url)
            #else
            UIApplication.shared.open(url)
            #endif
        }
    }

    nonisolated func clipboardCopy(source: TerminalView, content: Data) {
        guard content.count > 0, content.count <= (1 << 20), let text = String(data: content, encoding: .utf8), !text.isEmpty else { return }
        MainActor.assumeIsolated {
            #if os(macOS)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            #else
            UIPasteboard.general.string = text
            #endif
            onClipboardCopy?()
        }
    }

    nonisolated func setTerminalTitle(source: TerminalView, title: String) {}
    nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    nonisolated func scrolled(source: TerminalView, position: Double) {}
    nonisolated func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

#if os(macOS)
/// macOS TerminalView subclass adding Windows/Web parity shortcuts (Shift+Enter, ⌘⌫/⌘←/⌘→, ⌘F, ⌘V image/multiline paste) and right-click context menu.
final class NexMacTerminalView: TerminalView {
    var onSendBytes: (@MainActor (Data) -> Void)?
    var onOpenFind: (@MainActor () -> Void)?
    var onPasteCommand: (@MainActor () -> Void)?
    var onCopyCommand: (@MainActor () -> Void)?
    var isDriving: () -> Bool = { false }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags == .command, let ch = event.charactersIgnoringModifiers?.lowercased() {
            if ch == "f" {
                onOpenFind?()
                return true
            }
            if ch == "v", isDriving() {
                onPasteCommand?()
                return true
            }
            if ch == "c", let sel = getSelection(), !sel.isEmpty {
                onCopyCommand?()
                return true
            }
        }
        return super.performKeyEquivalent(with: event)
    }

    override func keyDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if isDriving() {
            // Shift+Enter -> ESC + CR (multiline input in Claude/Codex)
            if flags == .shift, event.keyCode == 36 || event.keyCode == 76 {
                onSendBytes?(Data("\u{1b}\r".utf8))
                return
            }
            // Mac line-editing chords: ⌘⌫ -> ^U, ⌘← -> ^A, ⌘→ -> ^E
            if flags == .command {
                switch event.keyCode {
                case 51: onSendBytes?(Data([0x15])); return
                case 123: onSendBytes?(Data([0x01])); return
                case 124: onSendBytes?(Data([0x05])); return
                default: break
                }
            }
        }
        super.keyDown(with: event)
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu()
        let hasSel = (getSelection()?.isEmpty == false)
        let copyItem = NSMenuItem(title: "复制", action: #selector(ctxCopy), keyEquivalent: "")
        copyItem.target = self
        copyItem.isEnabled = hasSel
        menu.addItem(copyItem)

        let pasteItem = NSMenuItem(title: "粘贴", action: #selector(ctxPaste), keyEquivalent: "")
        pasteItem.target = self
        pasteItem.isEnabled = isDriving()
        menu.addItem(pasteItem)

        menu.addItem(.separator())

        let selectAllItem = NSMenuItem(title: "全选", action: #selector(ctxSelectAll), keyEquivalent: "")
        selectAllItem.target = self
        menu.addItem(selectAllItem)

        let findItem = NSMenuItem(title: "查找…", action: #selector(ctxFind), keyEquivalent: "")
        findItem.target = self
        menu.addItem(findItem)

        let clearSelItem = NSMenuItem(title: "清除选区", action: #selector(ctxClearSel), keyEquivalent: "")
        clearSelItem.target = self
        clearSelItem.isEnabled = hasSel
        menu.addItem(clearSelItem)
        return menu
    }

    @objc private func ctxCopy() { onCopyCommand?() }
    @objc private func ctxPaste() { onPasteCommand?() }
    @objc private func ctxSelectAll() { selectAll() }
    @objc private func ctxFind() { onOpenFind?() }
    @objc private func ctxClearSel() { selectNone() }
}

struct CliTerminalView: NSViewRepresentable {
    let controller: CliTerminalController
    let actions: CliTerminalActions
    let width: CGFloat
    let control: Bool
    let style: CliTerminalStyle
    var transformInput: (@MainActor (Data, Bool) -> Data)? = nil
    var onClipboardCopy: (@MainActor () -> Void)? = nil
    var onOpenFind: (@MainActor () -> Void)? = nil
    var onPasteCommand: (@MainActor () -> Void)? = nil
    var onCopyCommand: (@MainActor () -> Void)? = nil

    func makeCoordinator() -> CliTerminalBridge { CliTerminalBridge(controller: controller, actions: actions) }

    func makeNSView(context: Context) -> NexMacTerminalView {
        let view = NexMacTerminalView(frame: .zero)
        bind(view, coordinator: context.coordinator)
        context.coordinator.attach(view, style: style)
        return view
    }

    func updateNSView(_ view: NexMacTerminalView, context: Context) {
        bind(view, coordinator: context.coordinator)
        context.coordinator.update(width: width, control: control, style: style)
    }

    private func bind(_ view: NexMacTerminalView, coordinator: CliTerminalBridge) {
        coordinator.transformInput = transformInput
        coordinator.onClipboardCopy = onClipboardCopy
        coordinator.onOpenFind = onOpenFind
        coordinator.onPasteCommand = onPasteCommand
        let ctrl = controller
        let driving = control
        view.isDriving = { driving }
        view.onSendBytes = { ctrl.sendInput($0) }
        view.onOpenFind = onOpenFind
        view.onPasteCommand = onPasteCommand
        view.onCopyCommand = onCopyCommand
    }

    static func dismantleNSView(_ view: NexMacTerminalView, coordinator: CliTerminalBridge) {
        coordinator.detach()
    }
}
#else
struct CliTerminalView: UIViewRepresentable {
    let controller: CliTerminalController
    let actions: CliTerminalActions
    let width: CGFloat
    let control: Bool
    let style: CliTerminalStyle
    var transformInput: (@MainActor (Data, Bool) -> Data)? = nil
    var onPinchFontSize: (@MainActor (CGFloat) -> Void)? = nil
    var onClipboardCopy: (@MainActor () -> Void)? = nil

    func makeCoordinator() -> CliTerminalBridge { CliTerminalBridge(controller: controller, actions: actions) }

    func makeUIView(context: Context) -> TerminalView {
        let view = TerminalView(frame: .zero)
        context.coordinator.transformInput = transformInput
        context.coordinator.onPinchFontSize = onPinchFontSize
        context.coordinator.onClipboardCopy = onClipboardCopy
        context.coordinator.attach(view, style: style)
        return view
    }

    func updateUIView(_ view: TerminalView, context: Context) {
        context.coordinator.transformInput = transformInput
        context.coordinator.onPinchFontSize = onPinchFontSize
        context.coordinator.onClipboardCopy = onClipboardCopy
        context.coordinator.update(width: width, control: control, style: style)
    }

    static func dismantleUIView(_ view: TerminalView, coordinator: CliTerminalBridge) {
        coordinator.detach()
    }
}
#endif

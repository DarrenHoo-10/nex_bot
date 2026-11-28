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

/// Action bridge allowing the toolbar and key bar to interact with the underlying SwiftTerm view.
@MainActor
final class CliTerminalActions {
    weak var view: TerminalView?

    var isAppCursor: Bool {
        view?.getTerminal().applicationCursor ?? false
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
        controller.onOutput = { [weak self] data in self?.view?.feed(byteArray: ArraySlice([UInt8](data))) }
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

    nonisolated func setTerminalTitle(source: TerminalView, title: String) {}
    nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    nonisolated func scrolled(source: TerminalView, position: Double) {}
    nonisolated func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

#if os(macOS)
struct CliTerminalView: NSViewRepresentable {
    let controller: CliTerminalController
    let actions: CliTerminalActions
    let width: CGFloat
    let control: Bool
    let style: CliTerminalStyle
    var transformInput: (@MainActor (Data, Bool) -> Data)? = nil

    func makeCoordinator() -> CliTerminalBridge { CliTerminalBridge(controller: controller, actions: actions) }

    func makeNSView(context: Context) -> TerminalView {
        let view = TerminalView(frame: .zero)
        context.coordinator.transformInput = transformInput
        context.coordinator.attach(view, style: style)
        return view
    }

    func updateNSView(_ view: TerminalView, context: Context) {
        context.coordinator.transformInput = transformInput
        context.coordinator.update(width: width, control: control, style: style)
    }

    static func dismantleNSView(_ view: TerminalView, coordinator: CliTerminalBridge) {
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

    func makeCoordinator() -> CliTerminalBridge { CliTerminalBridge(controller: controller, actions: actions) }

    func makeUIView(context: Context) -> TerminalView {
        let view = TerminalView(frame: .zero)
        context.coordinator.transformInput = transformInput
        context.coordinator.onPinchFontSize = onPinchFontSize
        context.coordinator.attach(view, style: style)
        return view
    }

    func updateUIView(_ view: TerminalView, context: Context) {
        context.coordinator.transformInput = transformInput
        context.coordinator.onPinchFontSize = onPinchFontSize
        context.coordinator.update(width: width, control: control, style: style)
    }

    static func dismantleUIView(_ view: TerminalView, coordinator: CliTerminalBridge) {
        coordinator.detach()
    }
}
#endif

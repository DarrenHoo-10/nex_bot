import SwiftUI
import NexClientKit
import SwiftTerm

#if os(macOS)
import AppKit
typealias CliPlatformFont = NSFont
#else
import UIKit
typealias CliPlatformFont = UIFont
#endif

/// Moves bytes and sizes between a SwiftTerm view and the session's `CliTerminalController`.
/// Watching: the emulator takes the device's grid and the font shrinks to fit the width.
/// Operating: the emulator fills the view and its size is what the device follows.
@MainActor
final class CliTerminalBridge: NSObject, TerminalViewDelegate {
    private let controller: CliTerminalController
    private weak var view: TerminalView?
    private var device: (cols: Int, rows: Int)?
    private var width: CGFloat = 0
    private var fontSize: CGFloat = 0
    private var control = false

    #if os(macOS)
    private static let operateFont: CGFloat = 13
    #else
    private static let operateFont: CGFloat = 12
    #endif

    init(controller: CliTerminalController) {
        self.controller = controller
        super.init()
    }

    func attach(_ view: TerminalView) {
        self.view = view
        view.terminalDelegate = self
        view.font = Self.mono(Self.operateFont)
        fontSize = Self.operateFont
        controller.onOpened = { [weak self] cols, rows in self?.opened(cols: cols, rows: rows) }
        controller.onResize = { [weak self] cols, rows in self?.device = (cols, rows); self?.fit() }
        controller.onOutput = { [weak self] data in self?.view?.feed(byteArray: ArraySlice([UInt8](data))) }
        // The callbacks are in place, so the open reply cannot be missed.
        controller.begin()
    }

    func detach() {
        controller.onOpened = nil
        controller.onResize = nil
        controller.onOutput = nil
        view?.terminalDelegate = nil
    }

    /// Called whenever SwiftUI lays the view out or the mode flips.
    func update(width: CGFloat, control: Bool) {
        let modeChanged = self.control != control
        self.width = width
        self.control = control
        if modeChanged { restoreFont() }
        fit()
        if control, modeChanged { focus() }
    }

    private static func mono(_ size: CGFloat) -> CliPlatformFont {
        CliPlatformFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }

    private func opened(cols: Int, rows: Int) {
        device = (cols, rows)
        view?.getTerminal().resetToInitialState()
        fit()
    }

    private func restoreFont() {
        guard fontSize != Self.operateFont else { return }
        fontSize = Self.operateFont
        view?.font = Self.mono(Self.operateFont)
    }

    /// Watching shows the device's grid at a font that fits the width; operating leaves the view to size itself.
    private func fit() {
        guard let view, !control, let device, device.cols > 0, device.rows > 0, width > 0 else { return }
        let size = max(5, min(Self.operateFont, ((width - 8) / (CGFloat(device.cols) * 0.61)).rounded(.down)))
        if abs(size - fontSize) > 0.1 {
            fontSize = size
            view.font = Self.mono(size)
        }
        let terminal = view.getTerminal()
        if terminal.cols != device.cols || terminal.rows != device.rows { view.resize(cols: device.cols, rows: device.rows) }
    }

    private func focus() {
        guard let view else { return }
        #if os(macOS)
        view.window?.makeFirstResponder(view)
        #else
        _ = view.becomeFirstResponder()
        #endif
    }

    // MARK: TerminalViewDelegate

    nonisolated func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        MainActor.assumeIsolated {
            if control { controller.viewResized(cols: newCols, rows: newRows) }
            else { DispatchQueue.main.async { MainActor.assumeIsolated { self.fit() } } }
        }
    }

    nonisolated func send(source: TerminalView, data: ArraySlice<UInt8>) {
        let bytes = Data(data)
        MainActor.assumeIsolated { controller.sendInput(bytes) }
    }

    /// Links printed by a program on the device are not opened from here.
    nonisolated func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}
    nonisolated func setTerminalTitle(source: TerminalView, title: String) {}
    nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    nonisolated func scrolled(source: TerminalView, position: Double) {}
    nonisolated func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

#if os(macOS)
/// The live terminal of a session: the emulator of SwiftTerm on the controller's stream.
struct CliTerminalView: NSViewRepresentable {
    let controller: CliTerminalController
    let width: CGFloat
    let control: Bool

    func makeCoordinator() -> CliTerminalBridge { CliTerminalBridge(controller: controller) }

    func makeNSView(context: Context) -> TerminalView {
        let view = TerminalView(frame: .zero)
        context.coordinator.attach(view)
        return view
    }

    func updateNSView(_ view: TerminalView, context: Context) {
        context.coordinator.update(width: width, control: control)
    }

    static func dismantleNSView(_ view: TerminalView, coordinator: CliTerminalBridge) {
        coordinator.detach()
    }
}
#else
struct CliTerminalView: UIViewRepresentable {
    let controller: CliTerminalController
    let width: CGFloat
    let control: Bool

    func makeCoordinator() -> CliTerminalBridge { CliTerminalBridge(controller: controller) }

    func makeUIView(context: Context) -> TerminalView {
        let view = TerminalView(frame: .zero)
        context.coordinator.attach(view)
        return view
    }

    func updateUIView(_ view: TerminalView, context: Context) {
        context.coordinator.update(width: width, control: control)
    }

    static func dismantleUIView(_ view: TerminalView, coordinator: CliTerminalBridge) {
        coordinator.detach()
    }
}
#endif

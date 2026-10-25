import AppKit
import SwiftUI

/// Routes shortcuts only after AppKit has finished the input method's marked text.
struct ComposerTextEditor: NSViewRepresentable {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    /// Called with a picture pasted from the clipboard (PNG bytes and a file name).
    var onPasteImage: (Data, String) -> Void = { _, _ in }
    var onKey: (UInt16) -> Bool

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        let editor = ComposerNSTextView()
        editor.isRichText = false
        editor.drawsBackground = false
        editor.font = .systemFont(ofSize: 14)
        editor.textColor = .labelColor
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = true
        editor.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        editor.setAccessibilityLabel("发送给 Agent 的消息")
        editor.delegate = context.coordinator
        scroll.documentView = editor
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let editor = scroll.documentView as? ComposerNSTextView else { return }
        editor.onKey = onKey
        editor.onPasteImage = onPasteImage
        editor.onFocus = { focused.wrappedValue = $0 }
        // Replacing marked text during an update cancels the candidate session.
        if editor.string != text && !editor.hasMarkedText() { editor.string = text }
        if focused.wrappedValue && editor.window?.firstResponder !== editor {
            DispatchQueue.main.async { [weak editor] in
                guard let editor else { return }
                editor.window?.makeFirstResponder(editor)
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextEditor
        init(parent: ComposerTextEditor) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            guard let editor = notification.object as? NSTextView else { return }
            parent.text = editor.string
        }
    }
}

final class ComposerNSTextView: NSTextView {
    var onKey: (UInt16) -> Bool = { _ in false }
    var onFocus: (Bool) -> Void = { _ in }
    var onPasteImage: (Data, String) -> Void = { _, _ in }

    /// ⌘V with a picture on the clipboard attaches it (as the web composer does); text pastes as usual.
    /// The clipboard ⌘V reads (a private pasteboard in checks).
    var pasteboard: NSPasteboard = .general
    override func paste(_ sender: Any?) {
        let board = pasteboard
        let files = (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
        let pictures = files.filter { ["png", "jpg", "jpeg", "gif", "webp", "heic", "tiff"].contains($0.pathExtension.lowercased()) }
        if !pictures.isEmpty {
            for url in pictures { if let data = try? Data(contentsOf: url) { onPasteImage(data, url.lastPathComponent) } }
            return
        }
        if files.isEmpty, board.availableType(from: [.png, .tiff]) != nil, let image = NSImage(pasteboard: board),
           let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            let stamp = Date().formatted(.dateTime.year().month(.twoDigits).day(.twoDigits).hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).second(.twoDigits))
            onPasteImage(png, "粘贴的图片 \(stamp.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")).png")
            return
        }
        super.paste(sender)
    }
    private var imeEndedAt: TimeInterval = -.infinity

    override func insertText(_ insertString: Any, replacementRange: NSRange) {
        let wasComposing = hasMarkedText()
        super.insertText(insertString, replacementRange: replacementRange)
        if wasComposing { imeEndedAt = ProcessInfo.processInfo.systemUptime }
    }

    override func unmarkText() {
        let wasComposing = hasMarkedText()
        super.unmarkText()
        if wasComposing { imeEndedAt = ProcessInfo.processInfo.systemUptime }
    }

    override func keyDown(with event: NSEvent) {
        let isReturn = event.keyCode == 36 || event.keyCode == 76
        if hasMarkedText() {
            super.keyDown(with: event)
            return
        }
        if isReturn && event.modifierFlags.contains(.shift) {
            insertNewlineIgnoringFieldEditor(nil)
            return
        }
        if ProcessInfo.processInfo.systemUptime - imeEndedAt < 0.15 {
            if !isReturn { super.keyDown(with: event) }
            return
        }
        if onKey(event.keyCode) { return }
        super.keyDown(with: event)
    }

    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { onFocus(true) }
        return accepted
    }

    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder()
        if accepted { onFocus(false) }
        return accepted
    }
}

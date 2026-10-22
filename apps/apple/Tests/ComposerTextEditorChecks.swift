import AppKit
import Foundation

/// Standalone AppKit regression: compile alongside NexBotMac/ComposerTextEditor.swift.
/// No account, server, window or user data is used.
@main
struct ComposerTextEditorChecks {
    @MainActor static func main() {
        let editor = ComposerNSTextView()
        var sends = 0
        editor.onKey = { key in
            guard key == 36 || key == 76 else { return false }
            sends += 1
            return true
        }
        func press(_ modifiers: NSEvent.ModifierFlags = [], key: UInt16 = 36) {
            let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers,
                                        timestamp: 0, windowNumber: 0, context: nil,
                                        characters: "\r", charactersIgnoringModifiers: "\r",
                                        isARepeat: false, keyCode: key)!
            editor.keyDown(with: event)
        }
        press()
        precondition(sends == 1, "Plain Enter sends")
        press(.shift)
        precondition(sends == 1 && editor.string.contains("\n"), "Shift+Enter inserts a newline")
        editor.string = ""
        editor.setMarkedText("中文", selectedRange: NSRange(location: 2, length: 0),
                             replacementRange: NSRange(location: NSNotFound, length: 0))
        precondition(editor.hasMarkedText(), "Fixture starts marked text")
        editor.insertText("中文", replacementRange: NSRange(location: NSNotFound, length: 0))
        press()
        precondition(sends == 1, "The confirmation Enter must not send")
        Thread.sleep(forTimeInterval: 0.16)
        press(key: 76)
        precondition(sends == 2, "A later keypad Enter sends")
        // ⌘V with a picture attaches it; a private pasteboard leaves the user's clipboard alone.
        var pasted: [(Data, String)] = []
        editor.onPasteImage = { pasted.append(($0, $1)) }
        editor.pasteboard = NSPasteboard(name: NSPasteboard.Name("nexbot-checks-\(UUID().uuidString)"))
        defer { editor.pasteboard.releaseGlobally() }
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 4, pixelsHigh: 3, bitsPerSample: 8, samplesPerPixel: 4,
                                      hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        editor.pasteboard.clearContents()
        editor.pasteboard.setData(bitmap.representation(using: .png, properties: [:])!, forType: .png)
        editor.string = ""
        editor.paste(nil)
        precondition(pasted.count == 1 && pasted[0].1.hasSuffix(".png") && NSImage(data: pasted[0].0)?.size == NSSize(width: 4, height: 3),
                     "A clipboard picture is attached as PNG")
        precondition(editor.string.isEmpty, "A pasted picture inserts no text")
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("nexbot-check-\(UUID().uuidString).jpg")
        try! Data([0xFF, 0xD8, 0xFF, 0xD9]).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        editor.pasteboard.clearContents()
        editor.pasteboard.writeObjects([file as NSURL])
        editor.paste(nil)
        precondition(pasted.count == 2 && pasted[1].1 == file.lastPathComponent && pasted[1].0 == Data([0xFF, 0xD8, 0xFF, 0xD9]),
                     "A copied picture file is attached with its name and bytes")
        print("ComposerTextEditor: 7 checks passed")
    }
}

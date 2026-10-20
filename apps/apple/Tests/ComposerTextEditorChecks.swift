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
        print("ComposerTextEditor: 4 checks passed")
    }
}

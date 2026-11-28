import XCTest
@testable import NexClientKit

final class CliTerminalLogicTests: XCTestCase {
    func testThemesResolveDarkAndLight() {
        XCTAssertEqual(CliTermThemeID.named("midnight"), .midnight)
        XCTAssertEqual(CliTermThemeID.named("unknown"), .ink)

        XCTAssertTrue(CliTermPalette.resolve(.ink, dark: false).isDark)
        XCTAssertTrue(CliTermPalette.resolve(.midnight, dark: false).isDark)
        XCTAssertFalse(CliTermPalette.resolve(.page, dark: false).isDark)
        XCTAssertTrue(CliTermPalette.resolve(.page, dark: true).isDark)
        XCTAssertEqual(CliTermPalette.resolve(.solarized, dark: false).background, 0xFDF6E3)
        XCTAssertEqual(CliTermPalette.resolve(.solarized, dark: true).background, 0x002B36)
        XCTAssertEqual(CliTermPalette.ink.ansi.count, 16)
    }

    func testTriStateModifiers() {
        var mods = CliTermModifiers()
        XCTAssertFalse(mods.active)

        mods.tap(.ctrl, quick: false)
        XCTAssertEqual(mods.ctrl, .once)
        XCTAssertEqual(mods.apply("c"), "ctrl+c")
        XCTAssertEqual(mods.apply("esc"), "esc")

        // Double tap locks; pressing keeps lock
        mods.tap(.ctrl, quick: true)
        XCTAssertEqual(mods.ctrl, .locked)
        mods.pressed()
        XCTAssertEqual(mods.ctrl, .locked)

        // Tap locked clears
        mods.tap(.ctrl, quick: false)
        XCTAssertEqual(mods.ctrl, .off)

        // Once clears on press
        mods.tap(.alt, quick: false)
        mods.pressed()
        XCTAssertEqual(mods.alt, .off)

        // Hold without use releases to once; hold with use releases to off
        mods.hold(.ctrl)
        mods.release(.ctrl)
        XCTAssertEqual(mods.ctrl, .once)

        mods.hold(.ctrl)
        mods.pressed()
        mods.release(.ctrl)
        XCTAssertEqual(mods.ctrl, .off)
    }

    func testKeyEncoderAndKeyName() {
        XCTAssertEqual(CliTermKeyEncoder.encode("enter"), Data("\r".utf8))
        XCTAssertEqual(CliTermKeyEncoder.encode("shift+enter"), Data("\u{1B}\r".utf8))
        XCTAssertEqual(CliTermKeyEncoder.encode("shift+tab"), Data("\u{1B}[Z".utf8))
        XCTAssertEqual(CliTermKeyEncoder.encode("ctrl+c"), Data([0x03]))
        XCTAssertEqual(CliTermKeyEncoder.encode("ctrl+space"), Data([0x00]))
        XCTAssertEqual(CliTermKeyEncoder.encode("alt+b"), Data("\u{1B}b".utf8))
        XCTAssertEqual(CliTermKeyEncoder.encode("up", appCursor: false), Data("\u{1B}[A".utf8))
        XCTAssertEqual(CliTermKeyEncoder.encode("up", appCursor: true), Data("\u{1B}OA".utf8))
        XCTAssertEqual(CliTermKeyEncoder.encode("ctrl+right", appCursor: true), Data("\u{1B}[1;5C".utf8))
        XCTAssertEqual(CliTermKeyEncoder.encode("f1"), Data("\u{1B}OP".utf8))
        XCTAssertEqual(CliTermKeyEncoder.encode("pageup"), Data("\u{1B}[5~".utf8))
        XCTAssertNil(CliTermKeyEncoder.encode("unknownkey"))

        XCTAssertEqual(CliTermKeyEncoder.keyName(for: Data("\r".utf8)), "enter")
        XCTAssertEqual(CliTermKeyEncoder.keyName(for: Data("\u{1B}[A".utf8)), "up")
        XCTAssertEqual(CliTermKeyEncoder.keyName(for: Data("\u{1B}OA".utf8)), "up")
        XCTAssertNil(CliTermKeyEncoder.keyName(for: Data("x".utf8)))
    }

    func testPastePathEscapingAndWebLinks() {
        XCTAssertTrue(CliTermPaste.isWindowsPath(#"C:\Users\demo\a.png"#))
        XCTAssertTrue(CliTermPaste.isWindowsPath(#"\\server\share\a.png"#))
        XCTAssertFalse(CliTermPaste.isWindowsPath("/tmp/a.png"))

        XCTAssertEqual(CliTermPaste.escapePath("/tmp/hello world (1).png"), #"/tmp/hello\ world\ \(1\).png"#)
        XCTAssertEqual(CliTermPaste.escapePath("/tmp/截图.png"), "/tmp/截图.png")
        XCTAssertEqual(CliTermPaste.escapePath(#"C:\Users\demo\file.png"#), #"C:\Users\demo\file.png"#)
        XCTAssertEqual(CliTermPaste.escapePath(#"C:\Users\my docs\a.png"#), #""C:\Users\my docs\a.png""#)
        XCTAssertEqual(CliTermPaste.pastedPaths(["/tmp/a b.png", "/tmp/c.txt"]), #"/tmp/a\ b.png /tmp/c.txt "#)

        XCTAssertEqual(CliTermPaste.lineCount("single\n"), 1)
        XCTAssertEqual(CliTermPaste.lineCount("a\nb"), 2)
        XCTAssertEqual(CliTermPaste.lineCount("a\r\nb\r\nc\r\n"), 3)

        XCTAssertEqual(CliTermPaste.pasteData("echo hi"), Data("echo hi".utf8))
        XCTAssertEqual(CliTermPaste.pasteData("a\nb"), Data("\u{1B}[200~a\rb\u{1B}[201~".utf8))

        XCTAssertEqual(CliTermPaste.webLink("https://example.com/test")?.absoluteString, "https://example.com/test")
        XCTAssertNil(CliTermPaste.webLink("javascript:alert(1)"))
        XCTAssertNil(CliTermPaste.webLink("file:///etc/passwd"))
    }

    func testShortcutsDecodeEncodeAndMove() {
        XCTAssertEqual(CliTermShortcuts.decode(""), CliTermShortcuts.defaults)
        XCTAssertEqual(CliTermShortcuts.decode("bad-json"), CliTermShortcuts.defaults)
        let encoded = CliTermShortcuts.encode(["git status", "ls"])
        XCTAssertEqual(CliTermShortcuts.decode(encoded), ["git status", "ls"])
        XCTAssertEqual(CliTermShortcuts.move(["a", "b", "c"], from: 1, by: -1), ["b", "a", "c"])
        XCTAssertEqual(CliTermShortcuts.move(["a", "b", "c"], from: 0, by: -1), ["a", "b", "c"])
    }
}

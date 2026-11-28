import SwiftUI
import NexClientKit

/// Persistent preferences for the native macOS / iOS terminal view.
enum CliTerminalPrefKeys {
    static let theme = "nexbot.terminal.theme"
    static let fontSize = "nexbot.terminal.fontSize"
    static let cursorStyle = "nexbot.terminal.cursorStyle"
    static let cursorBlink = "nexbot.terminal.cursorBlink"
    static let keyBar = "nexbot.terminal.keyBar"
    static let optionAsMeta = "nexbot.terminal.optionAsMeta"
    static let shortcuts = "nexbot.terminal.shortcuts"

    #if os(macOS)
    static let defaultFontSize: Double = 13
    static let defaultKeyBar = false
    #else
    static let defaultFontSize: Double = 14
    static let defaultKeyBar = true
    #endif

    static let minFontSize: Double = 9
    static let maxFontSize: Double = 22
}

/// Visual and input configuration passed from SwiftUI down to `CliTerminalView`.
struct CliTerminalStyle: Equatable {
    var theme: CliTermThemeID
    var fontSize: CGFloat
    var cursorStyle: CliTermCursorStyle
    var cursorBlink: Bool
    var optionAsMeta: Bool
    var dark: Bool

    var palette: CliTermPalette {
        CliTermPalette.resolve(theme, dark: dark)
    }
}

/// Terminal settings sheet (Persona-inspired: theme swatches, font size, cursor, key bar, quick commands).
struct CliTerminalSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage(CliTerminalPrefKeys.theme) private var themeRaw = CliTermThemeID.ink.rawValue
    @AppStorage(CliTerminalPrefKeys.fontSize) private var fontSize = CliTerminalPrefKeys.defaultFontSize
    @AppStorage(CliTerminalPrefKeys.cursorStyle) private var cursorStyleRaw = CliTermCursorStyle.block.rawValue
    @AppStorage(CliTerminalPrefKeys.cursorBlink) private var cursorBlink = true
    @AppStorage(CliTerminalPrefKeys.keyBar) private var keyBar = CliTerminalPrefKeys.defaultKeyBar
    @AppStorage(CliTerminalPrefKeys.optionAsMeta) private var optionAsMeta = true
    @AppStorage(CliTerminalPrefKeys.shortcuts) private var shortcutsJSON = ""
    @State private var draftShortcut = ""

    private var shortcuts: [String] { CliTermShortcuts.decode(shortcutsJSON) }

    private func saveShortcuts(_ next: [String]) {
        shortcutsJSON = CliTermShortcuts.encode(next)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("配色主题") {
                    ForEach(CliTermThemeID.allCases) { item in
                        let palette = CliTermPalette.resolve(item, dark: colorScheme == .dark)
                        let selected = item.rawValue == themeRaw
                        Button { themeRaw = item.rawValue } label: {
                            HStack(spacing: 10) {
                                Text(item.label).foregroundStyle(Theme.foreground)
                                Spacer(minLength: 8)
                                HStack(spacing: 4) {
                                    ForEach(Array([palette.background, palette.foreground, palette.ansi[2], palette.ansi[4]].enumerated()), id: \.offset) { _, hex in
                                        Circle()
                                            .fill(SwiftUI.Color(hex: hex))
                                            .frame(width: 11, height: 11)
                                            .overlay(Circle().strokeBorder(SwiftUI.Color.primary.opacity(0.18), lineWidth: 0.5))
                                    }
                                }
                                Image(systemName: "checkmark")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(Theme.nexAgentAccent)
                                    .opacity(selected ? 1 : 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }

                Section("字体与光标") {
                    HStack {
                        Stepper(value: $fontSize, in: CliTerminalPrefKeys.minFontSize...CliTerminalPrefKeys.maxFontSize, step: 1) {
                            Text("字号 \(Int(fontSize.rounded())) pt").monospacedDigit()
                        }
                        if Int(fontSize.rounded()) != Int(CliTerminalPrefKeys.defaultFontSize) {
                            Button("恢复") { fontSize = CliTerminalPrefKeys.defaultFontSize }
                                .buttonStyle(.borderless)
                                .font(.caption)
                                .foregroundStyle(Theme.nexAgentAccent)
                        }
                    }

                    Picker("光标形状", selection: $cursorStyleRaw) {
                        ForEach(CliTermCursorStyle.allCases) { style in
                            Text(style.label).tag(style.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)

                    Toggle("光标闪烁", isOn: $cursorBlink)
                }

                Section("输入与按键栏") {
                    Toggle("显示底部快捷键栏", isOn: $keyBar)
                    Toggle("Option 键作为 Meta (ESC)", isOn: $optionAsMeta)
                }

                Section("快捷命令") {
                    if shortcuts.isEmpty {
                        Text("暂无快捷命令").font(.caption).foregroundStyle(Theme.muted)
                    } else {
                        ForEach(Array(shortcuts.enumerated()), id: \.offset) { index, cmd in
                            HStack(spacing: 6) {
                                Text(cmd)
                                    .font(.system(size: 13, design: .monospaced))
                                    .lineLimit(1)
                                Spacer(minLength: 4)
                                Button {
                                    saveShortcuts(CliTermShortcuts.move(shortcuts, from: index, by: -1))
                                } label: { Image(systemName: "arrow.up") }
                                    .buttonStyle(.borderless)
                                    .disabled(index == 0)
                                    .accessibilityLabel("上移")
                                Button {
                                    saveShortcuts(CliTermShortcuts.move(shortcuts, from: index, by: 1))
                                } label: { Image(systemName: "arrow.down") }
                                    .buttonStyle(.borderless)
                                    .disabled(index == shortcuts.count - 1)
                                    .accessibilityLabel("下移")
                                Button(role: .destructive) {
                                    var next = shortcuts
                                    next.remove(at: index)
                                    saveShortcuts(next)
                                } label: { Image(systemName: "trash") }
                                    .buttonStyle(.borderless)
                                    .accessibilityLabel("删除")
                            }
                        }
                    }

                    HStack(spacing: 8) {
                        TextField("新增快捷命令，如 git status", text: $draftShortcut)
                            .font(.system(size: 13, design: .monospaced))
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                            .autocorrectionDisabled()
                            .onSubmit(addShortcut)
                        Button("添加", action: addShortcut)
                            .disabled(draftShortcut.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
            #if os(macOS)
            .formStyle(.grouped)
            .frame(minWidth: 420, minHeight: 460)
            #else
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .navigationTitle("终端设置")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }

    private func addShortcut() {
        let trimmed = draftShortcut.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        saveShortcuts(shortcuts + [trimmed])
        draftShortcut = ""
    }
}

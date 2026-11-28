import SwiftUI
import NexClientKit
#if os(iOS)
import UIKit
#endif

/// Persona-inspired single-row terminal key bar: tri-state modifiers (Ctrl / Alt / Shift),
/// Esc, Tab, ⌃C, quick commands popover, copy, paste, file attach, arrow keys / D-Pad,
/// and (on iOS) a keyboard show/hide toggle whose double-tap sends Return.
struct CliTerminalKeyBar: View {
    @Binding var mods: CliTermModifiers
    let disabled: Bool
    let isDark: Bool
    let shortcuts: [String]
    let onSendKey: (String) -> Void
    let onSendBare: (String) -> Void
    let onTypeCommand: (String, Bool) -> Void
    let onCopy: () -> Void
    let onPaste: () -> Void
    let onPickFile: () -> Void
    let onOpenSettings: () -> Void
    var onToggleKeyboard: (() -> Void)? = nil

    @State private var showShortcuts = false
    @State private var showPad = false
    @State private var lastTap: [CliTermModifierKey: Date] = [:]
    #if os(iOS)
    @State private var downAt: [CliTermModifierKey: Date] = [:]
    private static let holdDelayMs = 350
    #endif

    private static let doubleTapWindow: TimeInterval = 0.35

    var body: some View {
        HStack(spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 5) {
                    modifierCap(.ctrl, label: "Ctrl", name: "Control")
                    keyCap("Esc", name: "Esc") { press("esc") }
                    keyCap("Tab", name: "Tab") { press("tab") }
                    keyCap("⌃C", name: "发送 Ctrl+C") { onSendBare("ctrl+c") }
                    iconCap(showShortcuts ? "bolt.fill" : "bolt", name: "快捷命令", active: showShortcuts) {
                        showShortcuts.toggle()
                    }
                    .popover(isPresented: $showShortcuts, arrowEdge: .bottom) {
                        CliTermShortcutsPopover(
                            items: shortcuts,
                            onPick: { text, run in
                                onTypeCommand(text, run)
                                if run { showShortcuts = false }
                            },
                            onEdit: {
                                showShortcuts = false
                                onOpenSettings()
                            }
                        )
                    }
                    iconCap("doc.on.doc", name: "复制选中文本", active: false, allowWhenDisabled: true, action: onCopy)
                    iconCap("doc.on.clipboard", name: "粘贴", active: false, action: onPaste)
                    iconCap("paperclip", name: "上传文件并填入路径", active: false, action: onPickFile)
                    modifierCap(.alt, label: "Alt", name: "Option / Alt")
                    modifierCap(.shift, label: "⇧", name: "Shift")
                }
                .padding(.vertical, 2)
            }

            Divider().frame(height: 18).opacity(0.45)

            #if os(iOS)
            HStack(spacing: 4) {
                iconCap(showPad ? "gamecontroller.fill" : "gamecontroller", name: "方向键", active: showPad) {
                    withAnimation(.spring(duration: 0.25, bounce: 0.25)) { showPad.toggle() }
                }
                if let onToggleKeyboard {
                    Button {
                        haptic()
                        onToggleKeyboard()
                    } label: {
                        KeyCapLabel(symbol: "keyboard", state: .off)
                    }
                    .buttonStyle(.plain)
                    .disabled(disabled)
                    .highPriorityGesture(TapGesture(count: 2).onEnded {
                        guard !disabled else { return }
                        haptic()
                        press("enter")
                    })
                    .accessibilityLabel("切换键盘（双击发送回车）")
                }
            }
            #else
            HStack(spacing: 3) {
                iconCap("arrow.left", name: "左方向键", active: false) { press("left") }
                iconCap("arrow.up", name: "上方向键", active: false) { press("up") }
                iconCap("arrow.down", name: "下方向键", active: false) { press("down") }
                iconCap("arrow.right", name: "右方向键", active: false) { press("right") }
                iconCap("return", name: "回车", active: false) { press("enter") }
            }
            #endif
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(
            isDark ? SwiftUI.Color(hex: 0x181B20) : Theme.card,
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(isDark ? SwiftUI.Color.white.opacity(0.08) : Theme.border, lineWidth: 1)
        }
        .environment(\.colorScheme, isDark ? .dark : .light)
        .overlay(alignment: .bottomTrailing) {
            #if os(iOS)
            if showPad && !disabled {
                CliTermDirectionPad { key in press(key) }
                    .padding(.trailing, 8)
                    .offset(y: -48)
                    .transition(.scale(scale: 0.7, anchor: .bottomTrailing).combined(with: .opacity))
            }
            #endif
        }
        .onChange(of: disabled) { _, off in
            if off {
                showShortcuts = false
                showPad = false
            }
        }
    }

    private func press(_ key: String) {
        onSendKey(mods.apply(key))
        mods.pressed()
    }

    private func keyCap(_ label: String, name: String, action: @escaping () -> Void) -> some View {
        Button {
            haptic()
            action()
        } label: {
            KeyCapLabel(label: label, state: .off)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.38 : 1)
        .accessibilityLabel(name)
    }

    private func iconCap(_ symbol: String, name: String, active: Bool, allowWhenDisabled: Bool = false, action: @escaping () -> Void) -> some View {
        let isOff = disabled && !allowWhenDisabled
        return Button {
            haptic()
            action()
        } label: {
            KeyCapLabel(symbol: symbol, state: active ? .once : .off)
        }
        .buttonStyle(.plain)
        .disabled(isOff)
        .opacity(isOff ? 0.38 : 1)
        .accessibilityLabel(name)
    }

    @ViewBuilder
    private func modifierCap(_ key: CliTermModifierKey, label: String, name: String) -> some View {
        let state = mods[key]
        #if os(iOS)
        KeyCapLabel(label: label, state: state)
            .opacity(disabled ? 0.38 : 1)
            .overlay {
                if !disabled {
                    CliTermTouchArea(
                        down: { handleDown(key) },
                        up: { handleUp(key) },
                        cancel: { handleCancel(key) }
                    )
                }
            }
            .accessibilityElement()
            .accessibilityLabel(name)
            .accessibilityValue(state == .locked ? "已锁定" : state == .off ? "" : "已激活")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { mods.tap(key, quick: false) }
        #else
        Button {
            let now = Date()
            let quick = lastTap[key].map { now.timeIntervalSince($0) < Self.doubleTapWindow } ?? false
            lastTap[key] = now
            mods.tap(key, quick: quick)
        } label: {
            KeyCapLabel(label: label, state: state)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.38 : 1)
        .help("\(name)（单击一次生效，双击锁定）")
        .accessibilityLabel(name)
        #endif
    }

    #if os(iOS)
    private func handleDown(_ key: CliTermModifierKey) {
        guard downAt[key] == nil else { return }
        let stamp = Date()
        downAt[key] = stamp
        Task {
            try? await Task.sleep(for: .milliseconds(Self.holdDelayMs))
            guard downAt[key] == stamp else { return }
            haptic()
            mods.hold(key)
        }
    }

    private func handleUp(_ key: CliTermModifierKey) {
        downAt[key] = nil
        if mods[key] == .held {
            mods.release(key)
            return
        }
        let now = Date()
        let quick = lastTap[key].map { now.timeIntervalSince($0) < Self.doubleTapWindow } ?? false
        lastTap[key] = now
        haptic()
        mods.tap(key, quick: quick)
    }

    private func handleCancel(_ key: CliTermModifierKey) {
        downAt[key] = nil
        mods.release(key)
    }
    #endif

    private func haptic() {
        #if os(iOS)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
    }
}

private struct KeyCapLabel: View {
    var label = ""
    var symbol: String? = nil
    var state: CliTermModifierState

    var body: some View {
        Group {
            if let symbol {
                Image(systemName: symbol)
                    .font(.system(size: 13.5, weight: .medium))
                    .frame(width: 30)
            } else {
                Text(label)
                    .font(.system(size: 12.5, weight: .medium, design: .monospaced))
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.horizontal, 7)
            }
        }
        .foregroundStyle(state == .locked ? SwiftUI.Color.white : state == .off ? SwiftUI.Color.primary : Theme.nexAgentAccent)
        .frame(minWidth: 32, minHeight: 32)
        .background(
            state == .locked ? Theme.nexAgentSolid : state == .off ? SwiftUI.Color.clear : Theme.nexAgentAccent.opacity(0.16),
            in: Capsule()
        )
        .overlay(
            Capsule().strokeBorder(state == .once || state == .held ? Theme.nexAgentAccent : .clear, lineWidth: 1.5)
        )
        .overlay(alignment: .bottom) {
            if state == .locked {
                Capsule().fill(SwiftUI.Color.white).frame(width: 10, height: 2).padding(.bottom, 3)
            }
        }
        .scaleEffect(state == .held ? 0.94 : 1)
        .animation(.easeOut(duration: 0.12), value: state)
        .contentShape(Capsule())
    }
}

private struct CliTermShortcutsPopover: View {
    let items: [String]
    let onPick: (String, Bool) -> Void
    let onEdit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("快捷命令").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                Spacer(minLength: 8)
                Button("编辑", action: onEdit).font(.caption.weight(.medium)).buttonStyle(.plain).foregroundStyle(Theme.nexAgentAccent)
            }
            .padding(.horizontal, 12).padding(.vertical, 9)

            Divider().opacity(0.5)

            if items.isEmpty {
                Text("暂无快捷命令").font(.caption).foregroundStyle(Theme.muted).padding(12)
            } else {
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, cmd in
                            HStack(spacing: 4) {
                                Button { onPick(cmd, false) } label: {
                                    Text(cmd)
                                        .font(.system(size: 12.5, design: .monospaced))
                                        .lineLimit(1)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.horizontal, 8).padding(.vertical, 6)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)

                                Button { onPick(cmd, true) } label: {
                                    Image(systemName: "return")
                                        .font(.system(size: 12, weight: .medium))
                                        .foregroundStyle(Theme.nexAgentAccent)
                                        .frame(width: 28, height: 28)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("执行 \(cmd)")
                            }
                        }
                    }
                    .padding(6)
                }
                .frame(maxHeight: 220)
            }
        }
        .frame(width: 280)
        #if os(iOS)
        .presentationCompactAdaptation(.popover)
        #endif
    }
}

#if os(iOS)
/// UIKit touch detector for tri-state modifiers so quick double-taps and holds are never swallowed.
private struct CliTermTouchArea: UIViewRepresentable {
    var down: @MainActor () -> Void
    var up: @MainActor () -> Void
    var cancel: @MainActor () -> Void

    func makeUIView(context: Context) -> TouchView { TouchView() }
    func updateUIView(_ view: TouchView, context: Context) {
        view.down = down
        view.up = up
        view.cancel = cancel
    }

    final class TouchView: UIView {
        var down: (@MainActor () -> Void)?
        var up: (@MainActor () -> Void)?
        var cancel: (@MainActor () -> Void)?

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) { down?() }
        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) { up?() }
        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { cancel?() }
    }
}

private struct CliTermDirectionPad: View {
    let press: (String) -> Void
    private let size: CGFloat = 46

    var body: some View {
        Grid(horizontalSpacing: 6, verticalSpacing: 6) {
            GridRow {
                SwiftUI.Color.clear.frame(width: size, height: size)
                padButton("arrow.up", key: "up")
                SwiftUI.Color.clear.frame(width: size, height: size)
            }
            GridRow {
                padButton("arrow.left", key: "left")
                padButton("return", key: "enter", prominent: true)
                padButton("arrow.right", key: "right")
            }
            GridRow {
                SwiftUI.Color.clear.frame(width: size, height: size)
                padButton("arrow.down", key: "down")
                SwiftUI.Color.clear.frame(width: size, height: size)
            }
        }
        .padding(10)
        .glass(RoundedRectangle(cornerRadius: 16, style: .continuous), strong: true)
    }

    private func padButton(_ symbol: String, key: String, prominent: Bool = false) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            press(key)
        } label: {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(prominent ? SwiftUI.Color.white : SwiftUI.Color.primary)
                .frame(width: size, height: size)
                .background(prominent ? Theme.nexAgentSolid : Theme.wash, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(key)
    }
}
#endif

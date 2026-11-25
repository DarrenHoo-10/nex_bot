import SwiftUI

extension View {
    /// Keep the native button and its keyboard focus, with app-drawn feedback on macOS.
    func plainActionFeedback<S: InsettableShape>(in shape: S) -> some View {
        #if os(macOS)
        buttonStyle(ActionPressStyle()).actionFocusOutline(in: shape)
        #else
        buttonStyle(.plain)
        #endif
    }

    func actionFocusOutline<S: InsettableShape>(in shape: S) -> some View {
        #if os(macOS)
        modifier(ActionFocusOutline(shape: shape))
        #else
        self
        #endif
    }
}

#if os(macOS)
private struct ActionPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.78 : 1)
    }
}

private struct ActionFocusOutline<S: InsettableShape>: ViewModifier {
    let shape: S
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        content.focused($focused).focusEffectDisabled()
            .overlay {
                if focused {
                    shape.strokeBorder(Theme.identityAccent, lineWidth: 1.5)
                        .allowsHitTesting(false)
                }
            }
    }
}
#endif

struct ConversationActionButtonStyle: ButtonStyle {
    enum Tone { case light, dark }
    enum Size { case regular, compact }

    let tone: Tone
    let size: Size
    @Environment(\.isEnabled) private var enabled

    init(tone: Tone = .light, size: Size = .regular) {
        self.tone = tone
        self.size = size
    }

    func makeBody(configuration: Configuration) -> some View {
        let compact = size == .compact
        let shape = RoundedRectangle(cornerRadius: compact ? 8 : 12, style: .continuous)
        let light = tone == .light
        let surface: UInt32 = light ? (configuration.isPressed ? 0xecebef : 0xffffff) : (configuration.isPressed ? 0x19161f : 0x221e29)
        configuration.label
            .font(.system(size: compact ? 13 : 15, weight: .semibold))
            .lineLimit(1).minimumScaleFactor(0.8)
            .foregroundStyle(Color(hex: light ? 0x18151d : 0xf6f4f8))
            .padding(.horizontal, compact ? 12 : 16)
            .frame(minWidth: compact ? 52 : 84, minHeight: compact ? 32 : 44)
            .background(Color(hex: surface), in: shape)
            .overlay { shape.strokeBorder(light ? Color.black.opacity(0.10) : Color(hex: 0x3a3640)) }
            #if os(iOS)
            .frame(minHeight: 44)
            #endif
            .contentShape(shape)
            .opacity(enabled ? 1 : 0.5)
    }
}

import SwiftUI
import AppKit
import NexClientKit

/// Small building blocks shared by the connectors, devices and settings pages (web `Field`, `Button`, `Chip`).

struct MBButton: View {
    enum Kind { case primary, brand, secondary, danger }
    let title: String
    var kind = Kind.secondary
    var icon: String?
    var busy = false
    var enabled = true
    var minWidth: CGFloat?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if busy { ProgressView().controlSize(.small).scaleEffect(0.7).frame(width: 14, height: 14) }
                else if let icon { Image(systemName: icon).font(.system(size: 11, weight: .medium)) }
                Text(title).font(.system(size: 12, weight: kind == .primary || kind == .brand ? .semibold : .regular))
            }
            .foregroundStyle(foreground)
            .padding(.horizontal, 14).frame(minWidth: minWidth).frame(height: 34)
            .background(background, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(kind == .secondary || kind == .danger ? Theme.border : .clear))
            .opacity(enabled ? 1 : 0.5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled || busy)
    }

    private var foreground: Color {
        switch kind {
        case .primary: Theme.primaryForeground
        case .brand: .white
        case .secondary: Theme.foreground
        case .danger: Theme.danger
        }
    }
    private var background: Color {
        switch kind {
        case .primary: Theme.primary
        case .brand: Theme.brand
        case .secondary: Theme.secondary
        case .danger: Theme.card
        }
    }
}

struct MBChip: View {
    enum Tone { case success, danger, muted, brand }
    let text: String
    var tone = Tone.muted
    var body: some View {
        Text(text).font(.system(size: 10, weight: .medium)).foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(fill, in: Capsule())
    }
    private var color: Color {
        switch tone { case .success: Theme.success; case .danger: Theme.danger; case .muted: Theme.muted; case .brand: Theme.brand }
    }
    private var fill: Color {
        switch tone { case .success: Theme.successSoft; case .danger: Theme.danger.opacity(0.12); case .muted: Theme.secondary; case .brand: Theme.brandSoft }
    }
}

/// A labelled single-line input in the web style (white box, hairline border).
struct MBInput: View {
    let label: String
    @Binding var text: String
    var placeholder = ""
    var secure = false
    var mono = false
    var hint: String?
    var required = false
    var identifier: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.system(size: 12, weight: .medium))
            Group {
                if secure { SecureField("", text: $text, prompt: Text(placeholder).foregroundStyle(Theme.muted.opacity(0.7))) }
                else { TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Theme.muted.opacity(0.7))) }
            }
            .textFieldStyle(.plain)
            .font(.system(size: 12, design: mono ? .monospaced : .default))
            .autocorrectionDisabled()
            .padding(.horizontal, 12).frame(height: 38)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
            .accessibilityLabel(label)
            .accessibilityIdentifier(identifier ?? label)
            if let hint { Text(hint).font(.system(size: 10)).foregroundStyle(Theme.muted) }
        }
    }
}

/// A labelled pop-up menu styled like ``MBInput``.
struct MBSelect: View {
    let label: String
    @Binding var selection: String
    let options: [(value: String, title: String)]
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.system(size: 12, weight: .medium))
            Picker(label, selection: $selection) {
                ForEach(options, id: \.value) { Text($0.title).tag($0.value) }
            }
            .labelsHidden().pickerStyle(.menu)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 6).frame(height: 38)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
        }
    }
}

/// The 64pt title bar of a main-area page.
struct MBPageBar: View {
    let title: String
    var body: some View {
        VStack(spacing: 0) {
            HStack { Text(title).font(.system(size: 14, weight: .semibold)); Spacer() }
                .padding(.horizontal, 28).frame(height: 64)
            Hairline()
        }
    }
}

/// A one-line status banner (confirmation with a check, or a Core error).
struct MBBanner: View {
    let text: String
    var isError = false
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: isError ? "exclamationmark.circle" : "checkmark").font(.system(size: 11, weight: .medium))
                .foregroundStyle(isError ? Theme.danger : Theme.foreground)
            Text(text).font(.system(size: 12)).foregroundStyle(isError ? Theme.danger : Theme.foreground)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isError ? Theme.danger.opacity(0.08) : Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// White rounded card with a hairline border.
struct MBCard<Content: View>: View {
    var padding: CGFloat = 24
    @ViewBuilder let content: Content
    var body: some View {
        content.padding(padding).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border))
    }
}

/// A modal dialog over its parent: dims the page, closes on Escape.
struct MBModal<Content: View>: View {
    let title: String
    var closeLabel = "关闭"
    var width: CGFloat = 460
    var canClose = true
    let close: () -> Void
    @ViewBuilder let content: Content

    var body: some View {
        ZStack {
            Color.black.opacity(0.28).ignoresSafeArea()
                .onTapGesture { if canClose { close() } }
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text(title).font(.system(size: 16, weight: .bold))
                    Spacer()
                    Button(action: close) {
                        Image(systemName: "xmark").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.muted)
                            .frame(width: 26, height: 26).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!canClose).accessibilityLabel(closeLabel)
                }
                content
            }
            .padding(24).frame(width: width)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border))
            .shadow(color: .black.opacity(0.18), radius: 24, y: 8)
            Button("") { if canClose { close() } }.keyboardShortcut(.cancelAction).opacity(0).frame(width: 0, height: 0)
        }
        .transition(.opacity)
    }
}

/// A key/value row of a detail list.
struct MBInfoRow: View {
    let label: String
    let value: String
    var mono = false
    var labelWidth: CGFloat = 76
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(label).font(.system(size: 11)).foregroundStyle(Theme.muted).frame(width: labelWidth, alignment: .leading)
            Text(value).font(.system(size: 11, design: mono ? .monospaced : .default)).textSelection(.enabled)
            Spacer(minLength: 0)
        }
    }
}

/// A disclosure with the web `<details>` look: a small triangle, then the title.
struct MBDisclosure<Content: View>: View {
    let title: String
    @Binding var open: Bool
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Button { open.toggle() } label: {
                HStack(spacing: 6) {
                    Image(systemName: "triangleshape.fill").rotationEffect(.degrees(open ? 180 : 90)).font(.system(size: 6))
                    Text(title).font(.system(size: 11))
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open { content }
        }
    }
}

func mbFallbackMessage(_ error: Error) -> String {
    let text = message(of: error)
    return text.isEmpty ? "操作失败，请重试" : text
}

#if DEBUG
extension Notification.Name { static let mbDebug = Notification.Name("nexbot.macB.debug") }

/// DEBUG-only: lines appended to `$NEXBOT_DEBUG_COMMAND_FILE.b` are posted as `.mbDebug` notifications
/// (`cx ...` connectors, `dv ...` devices, `md ...` model, `mm ...` memory).
@MainActor enum MBDebug {
    private static var started = false
    static func start() {
        guard !started, let base = ProcessInfo.processInfo.environment["NEXBOT_DEBUG_COMMAND_FILE"] else { return }
        started = true
        let path = base + ".b"
        Task { @MainActor in
            while true {
                try? await Task.sleep(for: .milliseconds(300))
                guard let text = try? String(contentsOfFile: path, encoding: .utf8), !text.isEmpty else { continue }
                try? "".write(toFile: path, atomically: true, encoding: .utf8)
                for line in text.split(separator: "\n") {
                    NotificationCenter.default.post(name: .mbDebug, object: nil, userInfo: ["line": String(line)])
                }
            }
        }
    }
}

/// DEBUG: appends a line to `$NEXBOT_DEBUG_COMMAND_FILE.b.log`.
func mbLog(_ text: String) {
    guard let base = ProcessInfo.processInfo.environment["NEXBOT_DEBUG_COMMAND_FILE"] else { return }
    let path = base + ".b.log", line = text + "\n"
    if let handle = FileHandle(forWritingAtPath: path) { handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close() }
    else { try? line.write(toFile: path, atomically: true, encoding: .utf8) }
}

extension Notification {
    /// Splits a debug line `"cx fill a|b"` into prefix `cx`, verb `fill` and argument `a|b`.
    var mbCommand: (prefix: String, verb: String, arg: String)? {
        guard let line = userInfo?["line"] as? String else { return nil }
        let p = line.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
        guard p.count >= 2 else { return nil }
        return (p[0], p[1], p.count > 2 ? p[2] : "")
    }
}
#endif

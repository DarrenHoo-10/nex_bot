import SwiftUI
import NexClientKit

/// The in-app "退出当前账号？" dialog shared by the account menu and the settings window (web `LogoutConfirmation`).
/// Cancel is the default action and has initial focus; Escape cancels unless a logout is in flight.
struct LogoutConfirmation: View {
    let close: () -> Void
    let confirm: () async -> Bool

    @State private var pending = false
    @State private var error: String?
    @FocusState private var cancelFocused: Bool

    var body: some View {
        ZStack {
            Color.black.opacity(0.32).ignoresSafeArea()
                .onTapGesture { if !pending { close() } }
            VStack(alignment: .leading, spacing: 0) {
                Image(systemName: "rectangle.portrait.and.arrow.right").font(.system(size: 19, weight: .regular)).foregroundStyle(Theme.brand)
                    .frame(width: 44, height: 44)
                    .background(Theme.brandSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                Text("退出当前账号？").font(.system(size: 20, weight: .bold)).padding(.top, 18)
                Text("退出后需要重新登录。你的聊天和助手会保留。").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.top, 12)
                if let error {
                    Text(error).font(.system(size: 12)).foregroundStyle(Theme.danger).padding(.top, 12).accessibilityIdentifier("logout-error")
                }
                HStack(spacing: 10) {
                    Spacer()
                    Button(action: close) {
                        Text("取消").font(.system(size: 12)).foregroundStyle(Theme.foreground)
                            .padding(.horizontal, 18).frame(height: 38)
                            .background(Theme.card, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Theme.border))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(pending)
                    .focused($cancelFocused).focusEffectDisabled()
                    .keyboardShortcut(.defaultAction)
                    Button(action: run) {
                        Text(pending ? "正在退出…" : "退出登录").font(.system(size: 12, weight: .medium)).foregroundStyle(.white)
                            .padding(.horizontal, 18).frame(height: 38)
                            .background(Theme.brand, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                            .opacity(pending ? 0.7 : 1)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(pending)
                    .accessibilityIdentifier("logout-confirm")
                }
                .padding(.top, 26)
            }
            .padding(28).frame(width: 400)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.border))
            .shadow(color: .black.opacity(0.22), radius: 30, y: 10)
            .accessibilityElement(children: .contain)
            Button("") { if !pending { close() } }.keyboardShortcut(.cancelAction).opacity(0).frame(width: 0, height: 0)
        }
        .onAppear { cancelFocused = true }
        .onExitCommand { if !pending { close() } }
        .transition(.opacity)
    }

    private func run() {
        pending = true; error = nil
        Task {
            if await confirm() { return }
            error = "退出未完成，请重试"; pending = false
        }
    }
}

extension View {
    /// Presents ``LogoutConfirmation`` over this view while `isPresented`.
    func logoutConfirmation(isPresented: Binding<Bool>, confirm: @escaping () async -> Bool) -> some View {
        overlay { if isPresented.wrappedValue { LogoutConfirmation(close: { isPresented.wrappedValue = false }, confirm: confirm) } }
    }
}

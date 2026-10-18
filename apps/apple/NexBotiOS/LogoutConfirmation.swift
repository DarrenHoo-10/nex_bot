import SwiftUI
import NexClientKit

/// The one logout confirmation shared by the account menu and Settings (web `LogoutConfirmation` in auth.tsx).
/// Cancel is the safe default and the dismiss gesture; the sheet cannot be dismissed while signing out.
struct LogoutConfirmationSheet: View {
    let model: AppModel
    @Binding var isPresented: Bool
    @State private var pending = false
    @State private var errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: "rectangle.portrait.and.arrow.right")
                .font(.system(size: 20, weight: .medium)).foregroundStyle(Theme.brand)
                .frame(width: 44, height: 44)
                .background(Theme.brandSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityHidden(true)
            Text("退出当前账号？").font(.title3.weight(.bold)).padding(.top, 6)
            Text("退出后需要重新登录。你的聊天和助手会保留。").font(.subheadline).foregroundStyle(Theme.muted)
            if let errorText {
                Text(errorText).font(.footnote).foregroundStyle(Theme.danger).accessibilityAddTraits(.isStaticText)
            }
            Spacer(minLength: 8)
            HStack(spacing: 10) {
                Spacer()
                Button("取消") { isPresented = false }
                    .buttonStyle(PillButtonStyle()).disabled(pending)
                    .keyboardShortcut(.cancelAction)
                Button { confirm() } label: { Text(pending ? "正在退出…" : "退出登录") }
                    .buttonStyle(PillButtonStyle(primary: true, brand: true)).disabled(pending)
            }
        }
        .padding(.horizontal, 22).padding(.top, 26).padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.card)
        .foregroundStyle(Theme.foreground)
        .presentationDetents([.height(250)])
        .presentationBackground(Theme.card)
        .presentationCornerRadius(24)
        .interactiveDismissDisabled(pending)
        .onDebugUI { cmd, _ in if cmd == "logoutfail" { errorText = "退出未完成，请重试" } }
    }

    private func confirm() {
        pending = true; errorText = nil
        Task {
            await model.logout()
            // Success replaces the whole connected UI; if we are still here the sign-out did not complete.
            if model.phase == .connected { errorText = "退出未完成，请重试"; pending = false }
        }
    }
}

import SwiftUI
import NexClientKit

struct LoginView: View {
    @Bindable var model: AppModel
    @State private var account = ""
    @State private var password = ""
    @FocusState private var focus: Field?
    private enum Field { case account, password }

    private var errorText: String? {
        if case .loggedOut(let error) = model.phase { return error }
        return nil
    }

    var body: some View {
        Group {
            if model.phase == .resuming { resuming } else { form }
        }
        .background(Theme.background)
        .foregroundStyle(Theme.foreground)
    }

    private var resuming: some View {
        VStack(spacing: 20) {
            BrandMark(size: 44)
            ProgressView().controlSize(.large)
            Text("正在恢复登录…").font(.headline)
            Button("改用其他账号登录") { Task { await model.switchAccount() } }
                .buttonStyle(PillButtonStyle())
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                BrandMark(size: 56)
                Text("登录 NexBot").font(.title2.weight(.bold)).padding(.top, 4)
                field("邮箱") {
                    TextField("输入你的邮箱", text: $account)
                        .textContentType(.username).keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focus, equals: .account).submitLabel(.next)
                        .onSubmit { focus = .password }
                }
                field("密码") {
                    SecureField("输入密码", text: $password)
                        .textContentType(.password).focused($focus, equals: .password).submitLabel(.go)
                        .onSubmit(submit)
                }
                Button(action: submit) {
                    Group { if model.isLoggingIn { Text("正在登录…").font(.body.weight(.semibold)) } else { Text("登录").font(.body.weight(.semibold)) } }
                        .foregroundStyle(.white).frame(maxWidth: .infinity).frame(height: 48)
                        .background(Theme.brand, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(disabled).opacity(disabled ? 0.5 : 1)
                if let errorText { Text(errorText).foregroundStyle(Theme.danger).font(.callout).accessibilityAddTraits(.isStaticText) }
                if model.hasSavedLogin {
                    HStack(spacing: 12) {
                        Button("重新连接") { Task { await model.retryResume() } }.buttonStyle(PillButtonStyle())
                        Button("改用其他账号登录") { Task { await model.switchAccount() } }.buttonStyle(PillButtonStyle(danger: true))
                    }
                }
                HStack(spacing: 6) {
                    Text("没有账号？").foregroundStyle(Theme.muted)
                    Link("去注册", destination: URL(string: "https://user.nexorai.com.cn/register/nexbot")!).foregroundStyle(Theme.brand)
                }
                .font(.footnote).frame(maxWidth: .infinity).padding(.top, 4)
            }
            .padding(24)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Theme.border))
            .shadow(color: .black.opacity(0.06), radius: 18, y: 6)
            .frame(maxWidth: 420).frame(maxWidth: .infinity)
            .padding(.horizontal, 20).padding(.vertical, 40)
        }
        .scrollDismissesKeyboard(.interactively)
        .defaultScrollAnchor(.center)
        #if DEBUG
        .task { if let used = await DebugHooks.autoLogin(model) { account = used } }
        #endif
    }

    private var disabled: Bool { model.isLoggingIn || account.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty }

    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.footnote.weight(.semibold))
            content()
                .padding(.horizontal, 12).frame(height: 44)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.border))
        }
    }

    private func submit() {
        guard !disabled else { return }
        let secret = password
        password = ""
        focus = nil
        Task { await model.login(account: account, password: secret) }
    }
}

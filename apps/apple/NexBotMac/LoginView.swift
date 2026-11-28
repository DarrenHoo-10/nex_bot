import SwiftUI
import AppKit
import NexClientKit

struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var email = ""
    @State private var password = ""
    @FocusState private var focus: Field?
    private enum Field { case email, password }

    var body: some View {
        ZStack {
            WorkspaceSurface(kind: .login)
            VStack(alignment: .leading, spacing: 0) {
                BrandMark(size: 56)
                Text("登录 NexBot").font(.system(size: 26, weight: .bold)).padding(.top, 26)

                if model.phase == .resuming {
                    resuming
                } else {
                    form
                }
                if case .loggedOut(let error?) = model.phase {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 12)).foregroundStyle(Theme.danger)
                        .textSelection(.enabled).padding(.top, 14)
                        .accessibilityIdentifier("login-error")
                }
                if model.phase != .resuming, model.hasSavedLogin {
                    Button("使用已保存的登录重新连接") { Task { await model.retryResume() } }
                        .buttonStyle(.link).font(.system(size: 12)).padding(.top, 10)
                }
            }
            .padding(36)
            .frame(width: 420)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Theme.borderStrong))
            .shadow(color: Theme.shadowInk.opacity(0.10), radius: 28, y: 12)
        }
        .task { await debugAutoLogin() }
    }

    private var resuming: some View {
        VStack(spacing: 14) {
            ProgressView().controlSize(.regular)
            Text("正在恢复登录…").font(.system(size: 13)).foregroundStyle(Theme.muted)
            Button("改用其他账号登录") { Task { await model.switchAccount() } }
                .buttonStyle(.link).font(.system(size: 12))
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .padding(.top, 26).padding(.bottom, 6)
    }

    private func field<C: View>(_ label: String, active: Bool, @ViewBuilder _ content: () -> C) -> some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        return VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.system(size: 12, weight: .medium))
            content()
                .textFieldStyle(.plain).font(.system(size: 14)).autocorrectionDisabled()
                .padding(.horizontal, 14).frame(height: 44)
                .background(Theme.card, in: shape)
                .overlay(shape.strokeBorder(active ? Theme.brand : Theme.borderStrong, lineWidth: active ? 1.2 : 1))
                .shadow(color: active ? Theme.brandSoft : .clear, radius: 0, x: 0, y: 0)
                .overlay(shape.stroke(active ? Theme.brandSoft : .clear, lineWidth: 3))
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 16) {
            field("邮箱", active: focus == .email) {
                TextField("", text: $email, prompt: Text("输入你的邮箱").foregroundStyle(Theme.muted.opacity(0.7)))
                    .textContentType(.username)
                    .focused($focus, equals: .email)
                    .onSubmit { focus = .password }
            }
            field("密码", active: focus == .password) {
                SecureField("", text: $password, prompt: Text("输入密码").foregroundStyle(Theme.muted.opacity(0.7)))
                    .textContentType(.password)
                    .focused($focus, equals: .password)
                    .onSubmit(submit)
            }
            Button(action: submit) {
                HStack(spacing: 8) {
                    if self.model.isLoggingIn { ProgressView().controlSize(.small) }
                    Text(self.model.isLoggingIn ? "正在登录…" : "登录").font(.system(size: 14, weight: .semibold))
                }
                .foregroundStyle(.white).frame(maxWidth: .infinity).frame(height: 44)
                .background(Theme.brand.opacity(canSubmit ? 1 : 0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .shadow(color: canSubmit ? Theme.brand.opacity(0.24) : .clear, radius: 10, y: 4)
                .contentShape(Rectangle())
            }
            .plainActionFeedback()
            .keyboardShortcut(.defaultAction)
            .disabled(!canSubmit)

            HStack(spacing: 6) {
                Text("没有账号？").foregroundStyle(Theme.muted)
                Button("去注册") { NSWorkspace.shared.open(URL(string: "https://user.nexorai.com.cn/register/nexbot")!) }
                    .buttonStyle(.plain).foregroundStyle(Theme.brand)
            }
            .font(.system(size: 13)).frame(maxWidth: .infinity).padding(.top, 8)
        }
        .padding(.top, 28)
        .disabled(self.model.isLoggingIn)
        .onAppear { if email.isEmpty { focus = .email } }
    }

    private var canSubmit: Bool {
        !model.isLoggingIn && !email.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
    }

    private func submit() {
        let account = email, secret = password
        password = ""  // cleared after every attempt
        guard !account.trimmingCharacters(in: .whitespaces).isEmpty, !secret.isEmpty else { return }
        Task { await model.login(account: account, password: secret) }
    }

    /// DEBUG-only: NEXBOT_FIXTURE_AUTOLOGIN_ACCOUNT / _PASSWORD submit the form once per launch so fixture runs can be scripted.
    private func debugAutoLogin() async {
        #if DEBUG
        let env = ProcessInfo.processInfo.environment
        guard !DebugHooks.autoLoginUsed, let account = env["NEXBOT_FIXTURE_AUTOLOGIN_ACCOUNT"], let secret = env["NEXBOT_FIXTURE_AUTOLOGIN_PASSWORD"] else { return }
        DebugHooks.autoLoginUsed = true
        while model.phase == .launching || model.phase == .resuming { try? await Task.sleep(for: .milliseconds(100)) }
        guard case .loggedOut = model.phase else { return }
        email = account
        await model.login(account: account, password: secret)
        #endif
    }
}

#if DEBUG
@MainActor enum DebugHooks { static var autoLoginUsed = false }
#endif

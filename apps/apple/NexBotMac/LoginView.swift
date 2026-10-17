import SwiftUI
import AppKit
import NexClientKit

struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var email = ""
    @State private var password = ""
    @State private var showAdvanced = false
    @FocusState private var focus: Field?
    private enum Field { case email, password }

    private static let page = Theme.dynamic(light: 0xF5F6F8, dark: 0x0B0C0E)

    var body: some View {
        @Bindable var model = model
        ZStack {
            Self.page.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 0) {
                BrandMark(size: 44)
                Text("NEXBOT · PERSONAL AI OS").font(.system(size: 10)).tracking(1.6).foregroundStyle(Theme.muted).padding(.top, 22)
                Text("登录你的个人 Agent").font(.system(size: 24, weight: .bold)).padding(.top, 14)
                Text("使用 NexorAI 账号登录，连接你的 Agent、消息与记忆。")
                    .font(.system(size: 13)).foregroundStyle(Theme.muted).lineSpacing(4).padding(.top, 10)
                    .fixedSize(horizontal: false, vertical: true)

                if model.phase == .resuming {
                    resuming
                } else {
                    form(model: $model)
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
            .padding(34)
            .frame(width: 420)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.border.opacity(0.6)))
            .shadow(color: .black.opacity(0.08), radius: 24, y: 10)
        }
        .task { await debugAutoLogin() }
    }

    private var resuming: some View {
        VStack(spacing: 14) {
            ProgressView().controlSize(.regular)
            Text("正在恢复登录，连接云端服务…").font(.system(size: 13)).foregroundStyle(Theme.muted)
            Button("改用其他账号登录") { Task { await model.switchAccount() } }
                .buttonStyle(.link).font(.system(size: 12))
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .padding(.top, 26).padding(.bottom, 6)
    }

    private func field<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.system(size: 12, weight: .medium))
            content()
                .textFieldStyle(.plain).font(.system(size: 14)).autocorrectionDisabled()
                .padding(.horizontal, 14).frame(height: 42)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
        }
    }

    private func form(model: Bindable<AppModel>) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            field("邮箱") {
                TextField("", text: $email)
                    .textContentType(.username)
                    .focused($focus, equals: .email)
                    .onSubmit { focus = .password }
            }
            field("密码") {
                SecureField("", text: $password)
                    .textContentType(.password)
                    .focused($focus, equals: .password)
                    .onSubmit(submit)
            }
            Button(action: submit) {
                HStack(spacing: 8) {
                    if self.model.isLoggingIn { ProgressView().controlSize(.small) }
                    Text(self.model.isLoggingIn ? "正在登录…" : "登录").font(.system(size: 14, weight: .medium))
                }
                .foregroundStyle(.white).frame(maxWidth: .infinity).frame(height: 44)
                .background(Theme.brand.opacity(canSubmit ? 1 : 0.6), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.defaultAction)
            .disabled(!canSubmit)

            Button { showAdvanced.toggle() } label: {
                HStack(spacing: 5) {
                    Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold)).rotationEffect(.degrees(showAdvanced ? 90 : 0))
                    Text("高级：后端服务地址").font(.system(size: 12))
                }
                .foregroundStyle(Theme.muted).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if showAdvanced {
                field("Core 地址") { TextField("https://你的后端地址", text: model.origin) }
                field("此设备名称") { TextField("我的电脑", text: model.deviceName) }
                Text("默认连接云端服务 bot.nexorai.com.cn；远程连接须使用 HTTPS。")
                    .font(.system(size: 11)).foregroundStyle(Theme.muted)
            }
            Button("打开 NexorAI 账号中心") { NSWorkspace.shared.open(URL(string: "https://user.nexorai.com.cn/login")!) }
                .buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(Theme.brand)
        }
        .padding(.top, 24)
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

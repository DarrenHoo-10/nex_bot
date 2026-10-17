import SwiftUI
import NexClientKit

struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var email = ""
    @State private var password = ""
    @State private var showAdvanced = false
    @FocusState private var focus: Field?
    private enum Field { case email, password }

    var body: some View {
        @Bindable var model = model
        ZStack {
            Rectangle().fill(.background)
            VStack(spacing: 18) {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(.system(size: 34))
                    .foregroundStyle(.white)
                    .frame(width: 68, height: 68)
                    .background(Color.accentColor.gradient, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                Text("NEXBOT CLIENT").font(.caption.weight(.semibold)).foregroundStyle(.secondary).tracking(1.5)
                Text("登录你的个人 Agent").font(.title.weight(.semibold))
                Text("使用 NexorAI 账号登录。Agent、消息与记忆由云端服务统一管理。")
                    .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)

                if model.phase == .resuming {
                    resuming
                } else {
                    form(model: $model)
                }
                if case .loggedOut(let error?) = model.phase {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout).foregroundStyle(.red)
                        .multilineTextAlignment(.leading)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("login-error")
                }
                if model.phase != .resuming, model.hasSavedLogin {
                    Button("使用已保存的登录重新连接") { Task { await model.retryResume() } }
                        .buttonStyle(.link)
                }
                Text("默认连接云端服务 bot.nexorai.com.cn；使用自建后端时在“高级”中修改地址。远程连接须使用 HTTPS。")
                    .font(.caption).foregroundStyle(.tertiary).multilineTextAlignment(.center)
            }
            .frame(maxWidth: 380)
            .padding(32)
        }
        .task { await debugAutoLogin() }
    }

    private var resuming: some View {
        VStack(spacing: 12) {
            ProgressView().controlSize(.regular)
            Text("正在恢复登录，连接云端服务…").foregroundStyle(.secondary)
            Button("改用其他账号登录") { Task { await model.switchAccount() } }
        }
        .accessibilityElement(children: .contain)
        .padding(.vertical, 8)
    }

    private func form(model: Bindable<AppModel>) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            DisclosureGroup("高级", isExpanded: $showAdvanced) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Core 地址").font(.caption).foregroundStyle(.secondary)
                    TextField("https://你的后端地址", text: model.origin)
                        .textFieldStyle(.roundedBorder).autocorrectionDisabled()
                }.padding(.top, 6)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("此设备名称").font(.caption).foregroundStyle(.secondary)
                TextField("我的电脑", text: model.deviceName).textFieldStyle(.roundedBorder)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("邮箱").font(.caption).foregroundStyle(.secondary)
                TextField("name@example.com", text: $email)
                    .textContentType(.username).textFieldStyle(.roundedBorder)
                    .focused($focus, equals: .email)
                    .onSubmit { focus = .password }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("密码").font(.caption).foregroundStyle(.secondary)
                SecureField("密码", text: $password)
                    .textContentType(.password).textFieldStyle(.roundedBorder)
                    .focused($focus, equals: .password)
                    .onSubmit(submit)
            }
            Button(action: submit) {
                HStack {
                    if self.model.isLoggingIn { ProgressView().controlSize(.small) }
                    Text(self.model.isLoggingIn ? "正在登录…" : "登录并连接").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent).controlSize(.large)
            .keyboardShortcut(.defaultAction)
            .disabled(self.model.isLoggingIn || email.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)
        }
        .disabled(self.model.isLoggingIn)
        .onAppear { if email.isEmpty { focus = .email } }
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

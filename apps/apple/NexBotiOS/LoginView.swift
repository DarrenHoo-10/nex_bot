import SwiftUI
import NexClientKit

struct LoginView: View {
    @Bindable var model: AppModel
    @State private var account = ""
    @State private var password = ""
    @State private var showAdvanced = false
    @FocusState private var focus: Field?
    private enum Field { case origin, device, account, password }

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
            Text("正在恢复登录").font(.headline)
            Button("改用其他账号登录") { Task { await model.switchAccount() } }
                .buttonStyle(PillButtonStyle())
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                BrandMark(size: 44).padding(.bottom, 4)
                Text("NEXBOT · PERSONAL AI OS").font(.system(size: 10)).tracking(1.5).foregroundStyle(Theme.muted)
                Text("登录你的个人 Agent").font(.title.weight(.bold))
                Text("使用 NexorAI 账号登录，连接你的 Agent、消息与记忆。").font(.subheadline).foregroundStyle(Theme.muted)
                field("邮箱") {
                    TextField("", text: $account)
                        .textContentType(.username).keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focus, equals: .account).submitLabel(.next)
                        .onSubmit { focus = .password }
                }
                field("密码") {
                    SecureField("", text: $password)
                        .textContentType(.password).focused($focus, equals: .password).submitLabel(.go)
                        .onSubmit(submit)
                }
                if let errorText { Text(errorText).foregroundStyle(Theme.danger).font(.callout) }
                Button(action: submit) {
                    Group { if model.isLoggingIn { ProgressView().tint(.white) } else { Text("登录").font(.body.weight(.semibold)) } }
                        .foregroundStyle(.white).frame(maxWidth: .infinity).frame(height: 48)
                        .background(Theme.brand, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(disabled).opacity(disabled ? 0.5 : 1)
                if model.hasSavedLogin {
                    HStack(spacing: 12) {
                        Button("重试已保存的登录") { Task { await model.retryResume() } }.buttonStyle(PillButtonStyle())
                        Button("改用其他账号登录") { Task { await model.switchAccount() } }.buttonStyle(PillButtonStyle(danger: true))
                    }
                }
                Link("打开 NexorAI 账号中心", destination: URL(string: "https://user.nexorai.com.cn/login")!)
                    .font(.footnote).foregroundStyle(Theme.brand)
                advanced
            }
            .padding(.horizontal, 24).padding(.vertical, 32)
            .frame(maxWidth: 480).frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        #if DEBUG
        .task { if let used = await DebugHooks.autoLogin(model) { account = used } }
        #endif
    }

    private var disabled: Bool { model.isLoggingIn || account.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty }

    private var advanced: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(.easeOut(duration: 0.15)) { showAdvanced.toggle() } } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).rotationEffect(.degrees(showAdvanced ? 90 : 0))
                    Text("高级：后端服务地址")
                }
                .font(.footnote).foregroundStyle(Theme.muted)
            }
            .buttonStyle(.plain)
            if showAdvanced {
                field("Core 地址") {
                    TextField("https://", text: $model.origin)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focus, equals: .origin)
                }
                field("此设备名称") {
                    TextField("我的设备", text: $model.deviceName).focused($focus, equals: .device)
                }
            }
        }
        .padding(.top, 4)
    }

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

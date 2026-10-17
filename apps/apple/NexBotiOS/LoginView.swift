import SwiftUI
import NexClientKit

struct LoginView: View {
    @Bindable var model: AppModel
    @State private var account = ""
    @State private var password = ""
    @FocusState private var focus: Field?
    private enum Field { case origin, device, account, password }

    private var errorText: String? {
        if case .loggedOut(let error) = model.phase { return error }
        return nil
    }

    var body: some View {
        NavigationStack {
            if model.phase == .resuming { resuming } else { form }
        }
    }

    private var resuming: some View {
        VStack(spacing: 20) {
            ProgressView().controlSize(.large)
            Text("正在恢复登录").font(.headline)
            Button("改用其他账号登录") { Task { await model.switchAccount() } }
                .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle("NexBot")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var form: some View {
        Form {
            Section {
                Text("登录后可在手机上与你的 Agent 对话、处理审批。").font(.footnote).foregroundStyle(.secondary)
            }
            Section("高级") {
                LabeledContent("Core 地址") {
                    TextField("https://", text: $model.origin)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .multilineTextAlignment(.trailing).focused($focus, equals: .origin)
                }
                LabeledContent("此设备名称") {
                    TextField("我的设备", text: $model.deviceName)
                        .multilineTextAlignment(.trailing).focused($focus, equals: .device)
                }
            }
            Section("账号") {
                TextField("邮箱", text: $account)
                    .textContentType(.username).keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .focused($focus, equals: .account).submitLabel(.next)
                    .onSubmit { focus = .password }
                SecureField("密码", text: $password)
                    .textContentType(.password).focused($focus, equals: .password).submitLabel(.go)
                    .onSubmit(submit)
            }
            if let errorText {
                Section { Text(errorText).foregroundStyle(.red).font(.callout) }
            }
            Section {
                Button(action: submit) {
                    HStack {
                        Spacer()
                        if model.isLoggingIn { ProgressView() } else { Text("登录并连接").bold() }
                        Spacer()
                    }
                }
                .disabled(model.isLoggingIn || account.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)
                if model.hasSavedLogin {
                    Button("重试已保存的登录") { Task { await model.retryResume() } }
                    Button("改用其他账号登录", role: .destructive) { Task { await model.switchAccount() } }
                }
            }
        }
        .navigationTitle("登录 NexBot")
        .scrollDismissesKeyboard(.interactively)
        #if DEBUG
        .task { if let used = await DebugHooks.autoLogin(model) { account = used } }
        #endif
    }

    private func submit() {
        let secret = password
        password = ""
        focus = nil
        Task { await model.login(account: account, password: secret) }
    }
}

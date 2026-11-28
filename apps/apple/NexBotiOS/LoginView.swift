import SwiftUI
import NexClientKit

struct LoginView: View {
    @Bindable var model: AppModel
    @State private var account = ""
    @State private var password = ""
    @State private var editingOrigin = false
    @State private var originDraft = ""
    @State private var originError: String?
    @FocusState private var focus: Field?
    private enum Field { case account, password }

    private var errorText: String? {
        if case .loggedOut(let error) = model.phase { return error }
        return nil
    }

    private var originLabel: String {
        let trimmed = model.origin.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? CoreOrigin.defaultString : trimmed
    }

    var body: some View {
        ZStack {
            WorkspaceSurface(kind: .login)
            if model.phase == .resuming { resuming } else { form }
        }
        .foregroundStyle(Theme.foreground)
        .alert("服务器地址", isPresented: $editingOrigin) {
            TextField(CoreOrigin.defaultString, text: $originDraft)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("保存") {
                let candidate = originDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                if candidate.isEmpty {
                    model.origin = CoreOrigin.defaultString
                    originError = nil
                } else {
                    do {
                        model.origin = try CoreOrigin(candidate).string
                        originError = nil
                    } catch {
                        originError = CoreError.wrap(error).message
                    }
                }
            }
            Button("恢复默认") {
                model.origin = CoreOrigin.defaultString
                originError = nil
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("填写自托管 Core 根地址（HTTPS 或私有网络 / Tailscale HTTP）")
        }
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
            VStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 16) {
                    BrandMark(size: 56)
                    Text("登录 NexBot").font(.title2.weight(.bold)).padding(.top, 4)
                    field("邮箱", active: focus == .account) {
                        TextField("输入你的邮箱", text: $account)
                            .textContentType(.username).keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .focused($focus, equals: .account).submitLabel(.next)
                            .onSubmit { focus = .password }
                    }
                    field("密码", active: focus == .password) {
                        SecureField("输入密码", text: $password)
                            .textContentType(.password).focused($focus, equals: .password).submitLabel(.go)
                            .onSubmit(submit)
                    }
                    Button(action: submit) {
                        Group { if model.isLoggingIn { Text("正在登录…").font(.body.weight(.semibold)) } else { Text("登录").font(.body.weight(.semibold)) } }
                            .foregroundStyle(.white).frame(maxWidth: .infinity).frame(height: 46)
                            .background(Theme.brand, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .shadow(color: disabled ? .clear : Theme.brand.opacity(0.24), radius: 10, y: 4)
                    }
                    .plainActionFeedback()
                    .disabled(disabled).opacity(disabled ? 0.5 : 1)
                    if let errorText { Text(errorText).foregroundStyle(Theme.danger).font(.callout).accessibilityAddTraits(.isStaticText) }
                    if let originError { Text(originError).foregroundStyle(Theme.danger).font(.footnote) }
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
                .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Theme.borderStrong))
                .shadow(color: Theme.shadowInk.opacity(0.08), radius: 22, y: 8)
                .frame(maxWidth: 420)

                Button {
                    originDraft = originLabel
                    editingOrigin = true
                } label: {
                    HStack(spacing: 4) {
                        Text("服务器：\(originLabel)")
                        Image(systemName: "pencil").font(.caption2)
                    }
                    .font(.caption)
                    .foregroundStyle(Theme.muted)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 20).padding(.vertical, 40)
        }
        .scrollDismissesKeyboard(.interactively)
        .defaultScrollAnchor(.center)
        #if DEBUG
        .task { if let used = await DebugHooks.autoLogin(model) { account = used } }
        #endif
    }

    private var disabled: Bool { model.isLoggingIn || account.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty }

    private func field<Content: View>(_ label: String, active: Bool, @ViewBuilder content: () -> Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        return VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.footnote.weight(.semibold))
            content()
                .padding(.horizontal, 12).frame(height: 44)
                .background(Theme.card, in: shape)
                .overlay(shape.stroke(active ? Theme.brand : Theme.borderStrong, lineWidth: active ? 1.2 : 1))
                .overlay(shape.stroke(active ? Theme.brandSoft : .clear, lineWidth: 3))
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

import SwiftUI
import CoreImage.CIFilterBuiltins
import NexClientKit

/// 连接器页的飞书入口行：应用数量与异常数。
struct FeishuSection: View {
    let workspace: WorkspaceStore

    var body: some View {
        let feishu = workspace.state?.feishu
        let apps = feishu?.apps ?? []
        let issues = apps.filter { $0.status == "error" || $0.status == "busy" }.count
        NavigationLink {
            FeishuDetailView(workspace: workspace)
        } label: {
            HStack(spacing: 14) {
                FeishuLogo(size: 44)
                VStack(alignment: .leading, spacing: 3) {
                    Text("飞书").font(.system(size: 15.5, weight: .semibold)).foregroundStyle(Theme.foreground)
                    Text(apps.isEmpty ? (feishu?.job?.isRunning == true ? "等待扫码" : "未连接") : issues > 0 ? "\(apps.count) 个应用 · \(issues) 个异常" : "\(apps.count) 个应用")
                        .font(.system(size: 12.5)).foregroundStyle(issues > 0 ? Theme.danger : Theme.muted)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
            }
            .padding(.vertical, 12).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 14).cardStyle()
    }
}

/// 飞书应用列表与添加应用。
struct FeishuDetailView: View {
    let workspace: WorkspaceStore
    @Environment(\.openURL) private var openURL
    @State private var selectedBotID = ""
    private var botID: String { workspace.feishuReceiverID(selection: selectedBotID) }
    @State private var manual = false
    @State private var adding = false
    @State private var bindCodes: [String: String] = [:]
    @State private var confirmingRemove: FeishuAppView?
    @State private var busy = false
    @State private var errorText: String?

    private var feishu: FeishuState? { workspace.state?.feishu }
    private var apps: [FeishuAppView] { feishu?.apps ?? [] }
    private var job: FeishuJob? { feishu?.job }
    private var auth: FeishuJob? { feishu?.userAuth }
    private var showAdd: Bool { apps.isEmpty || adding || job?.isRunning == true || job?.stage == "error" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let errorText { InlineBanner(text: errorText) }
                if showAdd { setup }
                if !apps.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(Array(apps.enumerated()), id: \.element.id) { index, app in
                            if index > 0 { Divider().overlay(Theme.border) }
                            row(app)
                        }
                    }
                    .padding(.horizontal, 14).cardStyle()
                }
                FeishuDeliveryView(workspace: workspace)
            }
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.background)
        .navigationTitle("飞书")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .toolbar {
            if !apps.isEmpty && !showAdd {
                ToolbarItem(placement: .topBarTrailing) { Button("添加飞书应用", systemImage: "plus") { adding = true; errorText = nil } }
            }
        }
        .refreshable { await workspace.refresh() }
        .sheet(isPresented: $manual) {
            FeishuManualSheet(workspace: workspace, botID: botID) { manual = false }
        }
        .confirmationDialog("移除「\(confirmingRemove?.displayName ?? "")」？", isPresented: Binding(get: { confirmingRemove != nil }, set: { if !$0 { confirmingRemove = nil } }), titleVisibility: .visible) {
            Button("确认移除", role: .destructive) { if let app = confirmingRemove { run { try await workspace.removeFeishu(appID: app.id) } } }
        }
        .task(id: feishu?.needsPolling == true) { await poll() }
        .onChange(of: apps.count) { old, new in if new > old { adding = false; selectedBotID = "" } }
    }

    @ViewBuilder private func row(_ app: FeishuAppView) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                NavigationLink { FeishuAppScreen(workspace: workspace, appID: app.id) } label: {
                    HStack(spacing: 12) {
                        FeishuAvatar(app: app)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(app.displayName).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.foreground)
                            Text("接收助手 \(app.botName) · \(app.groupCount) 个群").font(.caption).foregroundStyle(Theme.muted)
                            Text(app.statusLabel).font(.caption.weight(.medium)).foregroundStyle(app.statusTint)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Menu {
                    if app.status == "error" { Button("重新连接") { run { try await workspace.setFeishuEnabled(appID: app.id, true) } } }
                    if !app.ownerBound { Button("绑定主人") { run { bindCodes[app.id] = try await workspace.startFeishuBind(appID: app.id) } } }
                    Button(app.userAuthorized ? "重新授权文档" : "授权文档访问") { run { try await workspace.startFeishuUserAuth(appID: app.id) } }
                    Button(app.enabled ? "停用" : "启用") { run { try await workspace.setFeishuEnabled(appID: app.id, !app.enabled) } }
                    Button("移除", role: .destructive) { confirmingRemove = app }
                } label: { Image(systemName: "ellipsis.circle").font(.body).foregroundStyle(Theme.muted).frame(width: 36, height: 36) }
                .disabled(busy)
                .accessibilityLabel("更多操作")
            }
            if let status = app.profileStatusLabel { Text(status).font(.caption).foregroundStyle(Theme.muted) }
            if app.status == "error", let appError = app.error { Text(appError).font(.caption).foregroundStyle(Theme.danger) }
            if let code = bindCodes[app.id], !app.ownerBound {
                Text("在飞书私聊机器人发送 \(code)，10 分钟内有效").font(.footnote).foregroundStyle(Theme.muted).textSelection(.enabled)
            }
            if let auth, auth.appID == app.id {
                if auth.isRunning, let url = auth.url {
                    VStack(alignment: .leading, spacing: 10) {
                        FeishuQRView(text: url)
                        Text("用飞书扫码完成文档授权").font(.footnote).foregroundStyle(Theme.muted)
                        HStack(spacing: 10) {
                            if let link = URL(string: url), Markdown.isOpenable(link) {
                                Button("打开飞书授权页") { openURL(link) }.buttonStyle(PillButtonStyle(primary: true))
                            }
                            Button("取消") { run { try await workspace.cancelFeishuUserAuth() } }.buttonStyle(PillButtonStyle()).disabled(busy)
                        }
                    }
                } else if auth.stage == "error", let authError = auth.error { Text(authError).font(.caption).foregroundStyle(Theme.danger) }
            }
        }
        .padding(.vertical, 12)
    }

    @ViewBuilder private var setup: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let job, job.stage == "qr", let qr = job.qrValue(origin: workspace.client.origin) {
                VStack(alignment: .leading, spacing: 12) {
                    FeishuQRView(text: qr)
                    Text("用飞书「扫一扫」扫码并确认，完成后自动连接。").font(.footnote).foregroundStyle(Theme.muted)
                    HStack(spacing: 10) {
                        if let rawURL = job.url, let link = URL(string: rawURL), Markdown.isOpenable(link) {
                            Button("打开飞书授权页") { openURL(link) }.buttonStyle(PillButtonStyle(primary: true))
                        }
                        Button("取消") { run { try await workspace.cancelFeishuRegister() } }.buttonStyle(PillButtonStyle()).disabled(busy)
                    }
                }
            } else if job?.stage == "preparing" {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("正在生成二维码…").font(.footnote).foregroundStyle(Theme.muted)
                    Spacer()
                    Button("取消") { run { try await workspace.cancelFeishuRegister() } }.buttonStyle(PillButtonStyle()).disabled(busy)
                }
            } else {
                if let job, job.stage == "error", let jobError = job.error { InlineBanner(text: jobError) }
                Picker("接收助手", selection: Binding(get: { botID }, set: { selectedBotID = $0 })) {
                    Text("请选择助手").tag("")
                    ForEach(workspace.bots) { bot in Text(bot.name).tag(bot.id) }
                }
                .pickerStyle(.menu)
                HStack(spacing: 10) {
                    Button { run { try await workspace.startFeishuRegister(botID: botID) } } label: {
                        HStack(spacing: 6) { if busy { ProgressView().controlSize(.small) }; Text("扫码创建应用") }
                    }
                    .buttonStyle(PillButtonStyle(primary: true)).disabled(busy || botID.isEmpty)
                    Button("使用已有应用") { errorText = nil; manual = true }
                        .buttonStyle(PillButtonStyle()).disabled(busy || botID.isEmpty)
                    if !apps.isEmpty { Button("取消") { adding = false; selectedBotID = "" }.buttonStyle(PillButtonStyle()).disabled(busy) }
                }
            }
        }
    }

    /// Register and user-auth jobs change server state without a request from us: poll until they settle.
    private func poll() async {
        while workspace.state?.feishu?.needsPolling == true {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled else { return }
            await workspace.refresh()
        }
    }

    private func run(_ work: @escaping () async throws -> Void) {
        busy = true; errorText = nil
        Task {
            defer { busy = false }
            do { try await work() } catch { errorText = coreMessage(error) }
            await workspace.refresh()
        }
    }
}

/// 单个飞书应用：只管理每个群的回复模式与系统上下文。
struct FeishuAppScreen: View {
    let workspace: WorkspaceStore
    let appID: String
    @State private var busy = false
    @State private var errorText: String?

    var body: some View {
        ScrollView {
            if let app = workspace.state?.feishu?.app(appID) {
                VStack(alignment: .leading, spacing: 16) {
                    FeishuAppOverview(workspace: workspace, app: app, busy: busy) { botID in
                        run { try await workspace.changeFeishuReceiver(appID: app.id, botID: botID) }
                    }
                    if app.status == "error" {
                        VStack(alignment: .leading, spacing: 8) {
                            InlineBanner(text: app.error ?? "连接异常")
                            Button("重新连接") { run { try await workspace.setFeishuEnabled(appID: app.id, true) } }
                                .buttonStyle(PillButtonStyle(primary: true)).disabled(busy)
                        }
                    }
                    else if app.status == "busy" { InlineBanner(text: "另一个程序正在使用这个应用的长连接") }
                    else if !app.enabled {
                        HStack {
                            Text("已停用，不收发消息").font(.footnote).foregroundStyle(Theme.muted)
                            Spacer()
                            Button("启用") { run { try await workspace.setFeishuEnabled(appID: app.id, true) } }.buttonStyle(PillButtonStyle()).disabled(busy)
                        }
                    }
                    if let errorText { InlineBanner(text: errorText) }
                    FeishuGroupsView(workspace: workspace, app: app)
                }
                .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 32)
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text("应用已移除").font(.footnote).foregroundStyle(Theme.muted).padding(.top, 40).frame(maxWidth: .infinity)
            }
        }
        .background(Theme.background)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .toolbarBackground(Theme.background, for: .navigationBar)
    }

    private func run(_ work: @escaping () async throws -> Void) {
        busy = true; errorText = nil
        Task {
            defer { busy = false }
            do { try await work() } catch { errorText = coreMessage(error) }
            await workspace.refresh()
        }
    }
}

// 使用已有应用（兜底）：粘贴 App ID / Secret，主人稍后用绑定码绑定。
private struct FeishuManualSheet: View {
    let workspace: WorkspaceStore
    let botID: String
    let close: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var appID = ""
    @State private var secret = ""
    @State private var brand = "feishu"
    @State private var busy = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("应用凭据") {
                    TextField("App ID (cli_xxx)", text: $appID).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("App Secret", text: $secret)
                    Picker("品牌", selection: $brand) {
                        Text("飞书").tag("feishu"); Text("Lark").tag("lark")
                    }
                }
                Section {
                    Button(busy ? "保存中…" : "保存并连接") { Task { await save() } }.disabled(busy || appID.isEmpty || secret.isEmpty || botID.isEmpty)
                    Button("取消", role: .cancel) { close() }
                }
                if let errorText { Section { Text(errorText).font(.footnote).foregroundStyle(Theme.danger) } }
            }
            .navigationTitle("使用已有应用")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarRole(.editor)
        }
        .presentationDetents([.medium, .large])
    }

    private func save() async {
        busy = true; errorText = nil
        defer { busy = false }
        do {
            _ = try await workspace.saveFeishuApp(appID: appID.trimmingCharacters(in: .whitespaces), secret: secret.trimmingCharacters(in: .whitespaces), brand: brand, botID: botID)
            await workspace.refresh()
            close()
        } catch { errorText = coreMessage(error) }
    }
}

/// 主人授权二维码（CIQRCodeGenerator）。
struct FeishuQRView: View {
    let text: String
    var size: CGFloat = 160

    var body: some View {
        Group {
            if let image = Self.qrImage(text) {
                Image(uiImage: image).interpolation(.none).resizable().frame(width: size, height: size)
                    .padding(10)
                    .background(.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.border))
            } else {
                Text("二维码生成失败").font(.footnote).foregroundStyle(Theme.muted)
                    .frame(width: size, height: size).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
        }
    }

    private static func qrImage(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let scaled = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)) else { return nil }
        let context = CIContext()
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}

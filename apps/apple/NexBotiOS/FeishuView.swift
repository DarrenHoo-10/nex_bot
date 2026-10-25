import SwiftUI
import CoreImage.CIFilterBuiltins
import NexClientKit

/// 连接器页的飞书入口行（状态）与详情屏：扫码建应用、已有应用、绑定码、主人授权与启停。
struct FeishuSection: View {
    let workspace: WorkspaceStore

    var body: some View {
        let feishu = workspace.state?.feishu
        NavigationLink {
            FeishuDetailView(workspace: workspace)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "message.fill").font(.subheadline).foregroundStyle(Theme.muted).frame(width: 26)
                VStack(alignment: .leading, spacing: 2) {
                    Text("飞书").font(.subheadline.weight(.semibold))
                    Text(feishu?.app.map { $0.enabled ? $0.statusLabel : "已停用" } ?? (feishu?.job?.isRunning == true ? "等待扫码" : "未连接"))
                        .font(.caption).foregroundStyle(Theme.muted)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 14).frame(height: 60).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 14).cardStyle()
    }
}

struct FeishuDetailView: View {
    let workspace: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    @State private var botID = ""
    @State private var manual = false
    @State private var bindCode = ""
    @State private var busy = false
    @State private var notice: String?
    @State private var errorText: String?

    private var feishu: FeishuState? { workspace.state?.feishu }
    private var app: FeishuAppView? { feishu?.app }
    private var job: FeishuJob? { feishu?.job }
    private var auth: FeishuJob? { feishu?.userAuth }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let notice { InlineBanner(text: notice, tone: .good) }
                if let errorText { InlineBanner(text: errorText) }
                if let app { connected(app) } else { setup }
            }
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.background)
        .navigationTitle("飞书")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .refreshable { await workspace.refresh() }
        .sheet(isPresented: $manual) {
            FeishuManualSheet(workspace: workspace, botID: botID) { manual = false }
        }
        .task(id: feishu?.needsPolling == true) { await poll() }
        .onAppear { if botID.isEmpty { botID = workspace.bots.first?.id ?? "" } }
    }

    @ViewBuilder private func connected(_ app: FeishuAppView) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: "message.fill").font(.title3).foregroundStyle(Theme.muted).frame(width: 44, height: 44)
                    .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text("飞书").font(.title3.weight(.bold))
                    StatusChip(text: app.enabled ? app.statusLabel : "已停用", tone: !app.enabled ? .neutral : app.status == "error" || app.error != nil ? .bad : app.status == "connected" ? .good : .neutral)
                }
                Spacer()
            }
            VStack(spacing: 0) {
                FactRow(title: "App ID", value: app.appID)
                Divider().overlay(Theme.border)
                FactRow(title: "接收助手", value: app.botName)
                Divider().overlay(Theme.border)
                FactRow(title: "品牌", value: app.brand == "lark" ? "Lark" : "飞书")
                Divider().overlay(Theme.border)
                FactRow(title: "主人授权", value: app.userAuthorized ? "已授权 · \(app.userScopes.count) 项权限" : "未授权")
            }
            .padding(.horizontal, 14).cardStyle()
            if let appError = app.error { InlineBanner(text: appError) }
            bindCodeSection(app)
            authSection
            HStack(spacing: 10) {
                Button { run { try await workspace.startFeishuUserAuth() } } label: {
                    HStack(spacing: 6) { if busy { ProgressView().controlSize(.small) }; Text(app.userAuthorized ? "重新授权" : "授权文档访问") }
                }
                .buttonStyle(PillButtonStyle(primary: true)).disabled(busy)
                Button(app.enabled ? "停用" : "启用") { run { try await workspace.setFeishuEnabled(!app.enabled) } }
                    .buttonStyle(PillButtonStyle()).disabled(busy)
                Spacer()
            }
            Button("移除飞书连接", role: .destructive) { run { try await workspace.removeFeishu(); bindCode = "" } }
                .buttonStyle(PillButtonStyle(danger: true)).disabled(busy)
        }
    }

    @ViewBuilder private var setup: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let job, job.stage == "qr", let url = job.url {
                VStack(alignment: .leading, spacing: 12) {
                    FeishuQRView(text: url)
                    Text("用飞书扫码并确认，完成后自动连接。").font(.footnote).foregroundStyle(Theme.muted)
                    Button("取消") { run { try await workspace.cancelFeishuRegister() } }.buttonStyle(PillButtonStyle()).disabled(busy)
                }
            } else if job?.stage == "preparing" {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("正在生成二维码…").font(.footnote).foregroundStyle(Theme.muted) }
            } else {
                if let job, job.stage == "error", let jobError = job.error { InlineBanner(text: jobError) }
                Picker("接收助手", selection: $botID) {
                    ForEach(workspace.bots) { bot in Text(bot.name).tag(bot.id) }
                }
                .pickerStyle(.menu)
                HStack(spacing: 10) {
                    Button { run { try await workspace.startFeishuRegister(botID: botID) } } label: {
                        HStack(spacing: 6) { if busy { ProgressView().controlSize(.small) }; Text("扫码连接飞书") }
                    }
                    .buttonStyle(PillButtonStyle(primary: true)).disabled(busy || botID.isEmpty)
                    Button("使用已有应用") { errorText = nil; notice = nil; manual = true }
                        .buttonStyle(PillButtonStyle()).disabled(busy)
                }
            }
        }
    }

    @ViewBuilder private func bindCodeSection(_ app: FeishuAppView) -> some View {
        if !app.ownerBound {
            if bindCode.isEmpty {
                Button("生成绑定码") { run { bindCode = try await workspace.startFeishuBind() } }
                    .buttonStyle(PillButtonStyle()).disabled(busy)
            } else {
                Text("绑定码 \(bindCode)：在飞书私聊机器人发送这串数字，10 分钟内有效。")
                    .font(.footnote).foregroundStyle(Theme.muted).textSelection(.enabled)
            }
        }
    }

    @ViewBuilder private var authSection: some View {
        if let auth, auth.isRunning, let url = auth.url {
            VStack(alignment: .leading, spacing: 12) {
                FeishuQRView(text: url)
                Text("用飞书扫码完成主人身份授权。").font(.footnote).foregroundStyle(Theme.muted)
                Button("取消") { run { try await workspace.cancelFeishuUserAuth() } }.buttonStyle(PillButtonStyle()).disabled(busy)
            }
        } else if let auth, auth.stage == "error", let authError = auth.error {
            InlineBanner(text: authError)
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
        busy = true; notice = nil; errorText = nil
        Task {
            defer { busy = false }
            do { try await work() } catch { errorText = coreMessage(error) }
            await workspace.refresh()
        }
    }
}

/// 使用已有应用（兜底）：粘贴 App ID / Secret，主人稍后用绑定码绑定。
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

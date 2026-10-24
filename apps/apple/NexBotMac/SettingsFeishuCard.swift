import SwiftUI
import CoreImage.CIFilterBuiltins
import NexClientKit

/// 连接器页的飞书卡片：扫码建应用、已有应用、绑定码、主人授权与启停。
struct SettingsFeishuCard: View {
    let workspace: WorkspaceStore
    @State private var botID = ""
    @State private var manual = false
    @State private var manualAppID = ""
    @State private var manualSecret = ""
    @State private var manualBrand = "feishu"
    @State private var bindCode = ""
    @State private var confirmingRemove = false
    @State private var busy = false
    @State private var notice: String?
    @State private var error: String?

    private var feishu: FeishuState? { workspace.state?.feishu }
    private var app: FeishuAppView? { feishu?.app }
    private var job: FeishuJob? { feishu?.job }
    private var auth: FeishuJob? { feishu?.userAuth }

    var body: some View {
        ZStack {
            MBCard {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "message.fill").font(.system(size: 14)).foregroundStyle(Theme.muted)
                            .frame(width: 38, height: 38).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                        VStack(alignment: .leading, spacing: 6) {
                            Text("飞书").font(.system(size: 16, weight: .bold))
                            Text(statusText).font(.system(size: 10, weight: .medium)).foregroundStyle(statusTint)
                        }
                        Spacer()
                    }
                    if let notice { MBBanner(text: notice, isError: false).padding(.top, 16) }
                    if let error { MBBanner(text: error, isError: true).padding(.top, 16) }
                    content.padding(.top, 18)
                }
            }
            if manual { FeishuManualSheet(workspace: workspace, botID: botID, close: { manual = false }) }
        }
        .task(id: feishu?.needsPolling == true) { await poll() }
    }

    private var statusText: String {
        if let app { return app.statusLabel }
        return job?.isRunning == true ? "等待扫码" : "未连接"
    }
    private var statusTint: Color {
        guard let app else { return Theme.muted }
        if !app.enabled { return Theme.muted }
        return app.status == "error" || app.error != nil ? Theme.danger : app.status == "connected" ? Theme.success : Theme.muted
    }

    @ViewBuilder private var content: some View {
        if let app {
            VStack(alignment: .leading, spacing: 12) {
                MBInfoRow(label: "App ID", value: app.appID, mono: true)
                MBInfoRow(label: "接收助手", value: app.botName)
                MBInfoRow(label: "品牌", value: app.brand == "lark" ? "Lark" : "飞书")
                MBInfoRow(label: "主人授权", value: app.userAuthLabel)
            }
            if let appError = app.error { errorText(appError).padding(.top, 14) }
            bindCodeSection(app).padding(.top, 12)
            authSection.padding(.top, 12)
            HStack(spacing: 8) {
                MBButton(title: app.userAuthorized ? "重新授权" : "授权文档访问", busy: busy) {
                    perform { try await workspace.startFeishuUserAuth() }
                }
                MBButton(title: app.enabled ? "停用" : "启用", enabled: !busy) {
                    perform { try await workspace.setFeishuEnabled(!app.enabled) }
                }
                removeControl
            }
            .padding(.top, 16)
        } else if let job, job.stage == "qr", let url = job.url {
            HStack(alignment: .top, spacing: 16) {
                FeishuQRView(text: url)
                VStack(alignment: .leading, spacing: 10) {
                    Text("用飞书扫码并确认，完成后自动连接。").font(.system(size: 11)).foregroundStyle(Theme.muted)
                    MBButton(title: "取消", enabled: !busy) { perform { try await workspace.cancelFeishuRegister() } }
                }
            }
        } else if job?.stage == "preparing" {
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text("正在生成二维码…").font(.system(size: 11)).foregroundStyle(Theme.muted)
                MBButton(title: "取消", enabled: !busy) { perform { try await workspace.cancelFeishuRegister() } }
            }
        } else {
            VStack(alignment: .leading, spacing: 12) {
                if let job, job.stage == "error", let jobError = job.error { errorText(jobError) }
                MBSelect(label: "接收助手", selection: $botID, options: workspace.bots.map { ($0.id, $0.name) })
                HStack(spacing: 8) {
                    MBButton(title: "扫码连接飞书", kind: .primary, busy: busy, enabled: !botID.isEmpty) {
                        perform { try await workspace.startFeishuRegister(botID: botID) }
                    }
                    MBButton(title: "使用已有应用", enabled: !busy) { error = nil; notice = nil; manual = true }
                }
            }
            .onAppear { if botID.isEmpty { botID = workspace.bots.first?.id ?? "" } }
        }
    }

    @ViewBuilder private func bindCodeSection(_ app: FeishuAppView) -> some View {
        if !app.ownerBound {
            if bindCode.isEmpty {
                MBButton(title: "生成绑定码", busy: busy) {
                    perform { bindCode = try await workspace.startFeishuBind() }
                }
            } else {
                Text("绑定码 \(bindCode)：在飞书私聊机器人发送这串数字，10 分钟内有效。")
                    .font(.system(size: 11)).foregroundStyle(Theme.muted).textSelection(.enabled)
            }
        }
    }

    @ViewBuilder private var authSection: some View {
        if let auth, auth.isRunning, let url = auth.url {
            HStack(alignment: .top, spacing: 16) {
                FeishuQRView(text: url)
                VStack(alignment: .leading, spacing: 10) {
                    Text("用飞书扫码完成主人身份授权。").font(.system(size: 11)).foregroundStyle(Theme.muted)
                    MBButton(title: "取消", enabled: !busy) { perform { try await workspace.cancelFeishuUserAuth() } }
                }
            }
        } else if let auth, auth.stage == "error", let authError = auth.error {
            errorText(authError)
        }
    }

    @ViewBuilder private var removeControl: some View {
        if confirmingRemove {
            HStack(spacing: 8) {
                Text("移除飞书连接？").font(.system(size: 12))
                MBButton(title: "确认移除", kind: .danger, busy: busy) {
                    perform { try await workspace.removeFeishu(); bindCode = ""; confirmingRemove = false }
                }
                MBButton(title: "取消") { confirmingRemove = false }
            }
        } else {
            Button { confirmingRemove = true } label: {
                HStack(spacing: 6) { Image(systemName: "trash").font(.system(size: 11)); Text("移除").font(.system(size: 12)) }
                    .foregroundStyle(Theme.danger).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private func errorText(_ text: String) -> some View {
        Text(text).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled)
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    /// Register and user-auth jobs change server state without a request from us: poll until they settle.
    private func poll() async {
        while workspace.state?.feishu?.needsPolling == true {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled else { return }
            await workspace.refresh()
        }
    }

    private func perform(_ success: String? = nil, _ work: @escaping () async throws -> Void) {
        busy = true; error = nil; notice = nil
        Task {
            defer { busy = false }
            do {
                try await work()
                if let success { notice = success }
            } catch { self.error = mbFallbackMessage(error) }
            await workspace.refresh()
        }
    }
}

/// 使用已有应用（兜底）：粘贴 App ID / Secret，主人稍后用绑定码绑定。
private struct FeishuManualSheet: View {
    let workspace: WorkspaceStore
    let botID: String
    let close: () -> Void
    @State private var appID = ""
    @State private var secret = ""
    @State private var brand = "feishu"
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        MBModal(title: "使用已有应用", closeLabel: "关闭飞书应用编辑", canClose: !busy, close: close) {
            VStack(alignment: .leading, spacing: 16) {
                MBInput(label: "App ID", text: $appID, placeholder: "cli_xxx", mono: true)
                MBInput(label: "App Secret", text: $secret, placeholder: "在开放平台获取", secure: true)
                MBSelect(label: "品牌", selection: $brand, options: [("feishu", "飞书"), ("lark", "Lark")])
                if let error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled) }
                HStack(spacing: 8) {
                    MBButton(title: busy ? "保存中…" : "保存并连接", kind: .primary, busy: busy, enabled: valid, action: submit)
                    MBButton(title: "取消", enabled: !busy, action: close)
                }
            }
        }
    }

    private var valid: Bool { !appID.trimmingCharacters(in: .whitespaces).isEmpty && !secret.trimmingCharacters(in: .whitespaces).isEmpty && !botID.isEmpty }

    private func submit() {
        guard valid, !busy else { return }
        busy = true; error = nil
        Task {
            defer { busy = false }
            do {
                _ = try await workspace.saveFeishuApp(appID: appID.trimmingCharacters(in: .whitespaces), secret: secret.trimmingCharacters(in: .whitespaces), brand: brand, botID: botID)
                await workspace.refresh()
                close()
            } catch { self.error = mbFallbackMessage(error) }
        }
    }
}

/// 长连接事件二维码（CIQRCodeGenerator）。
struct FeishuQRView: View {
    let text: String
    var size: CGFloat = 148

    var body: some View {
        Group {
            if let image = Self.qrImage(text) {
                Image(nsImage: image).interpolation(.none).resizable().frame(width: size, height: size)
            } else {
                Text("二维码生成失败").font(.system(size: 11)).foregroundStyle(Theme.muted)
                    .frame(width: size, height: size).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
        }
    }

    private static func qrImage(_ text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let scaled = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)) else { return nil }
        let rep = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}

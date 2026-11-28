import SwiftUI
import CoreImage.CIFilterBuiltins
import NexClientKit

/// 连接器页的飞书卡片：应用列表、添加应用（扫码或已有应用），点开应用管理每个群的回复模式与系统上下文。
struct SettingsFeishuCard: View {
    let workspace: WorkspaceStore
    @Environment(\.openURL) private var openURL
    @State private var selectedBotID = ""
    private var botID: String { workspace.feishuReceiverID(selection: selectedBotID) }
    @State private var manual = false
    @State private var adding = false
    @State private var openAppID: String?
    @State private var bindCodes: [String: String] = [:]
    @State private var confirmingRemove: String?
    @State private var busy = false
    @State private var notice: String?
    @State private var error: String?

    private var feishu: FeishuState? { workspace.state?.feishu }
    private var apps: [FeishuAppView] { feishu?.apps ?? [] }
    private var job: FeishuJob? { feishu?.job }
    private var auth: FeishuJob? { feishu?.userAuth }
    private var showAdd: Bool { apps.isEmpty || adding || job?.isRunning == true || job?.stage == "error" }

    var body: some View {
        ZStack {
            MBCard {
                VStack(alignment: .leading, spacing: 0) {
                    if let id = openAppID, let app = feishu?.app(id) { appDetail(app) } else { list }
                }
            }
            if manual { FeishuManualSheet(workspace: workspace, botID: botID, close: { manual = false }) }
        }
        .task(id: feishu?.needsPolling == true) { await poll() }
        .onChange(of: apps.count) { old, new in if new > old { adding = false; selectedBotID = "" } }
    }

    @ViewBuilder private var list: some View {
        HStack(alignment: .center, spacing: 12) {
            FeishuLogo(size: 38)
            VStack(alignment: .leading, spacing: 4) {
                Text("飞书").font(.system(size: 16, weight: .bold))
                Text(apps.isEmpty ? (job?.isRunning == true ? "等待扫码" : "未连接") : "\(apps.count) 个应用").font(.system(size: 11)).foregroundStyle(Theme.muted)
            }
            Spacer()
            if !apps.isEmpty && !showAdd { MBButton(title: "添加飞书应用", icon: "plus") { adding = true; error = nil; notice = nil } }
        }
        if let notice { MBBanner(text: notice, isError: false).padding(.top, 16) }
        if let error { MBBanner(text: error, isError: true).padding(.top, 16) }
        if showAdd { addSection.padding(.top, 18) }
        if !apps.isEmpty {
            VStack(spacing: 0) {
                ForEach(Array(apps.enumerated()), id: \.element.id) { index, app in
                    if index > 0 { Divider().overlay(Theme.border) }
                    appRow(app)
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.border))
            .padding(.top, 18)
        }
        FeishuDeliveryView(workspace: workspace).padding(.top, 18)
    }

    @ViewBuilder private func appRow(_ app: FeishuAppView) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Button { openAppID = app.id; error = nil; notice = nil } label: {
                    HStack(spacing: 12) {
                        FeishuAvatar(app: app)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                Text(app.displayName).font(.system(size: 14, weight: .medium))
                                if app.brand == "lark" { Text("Lark").font(.system(size: 10)).foregroundStyle(Theme.muted).padding(.horizontal, 6).padding(.vertical, 1).background(Theme.secondary, in: Capsule()) }
                            }
                            Text("\(app.appID) · 接收助手 \(app.botName) · \(app.groupCount) 个群").font(.system(size: 11)).foregroundStyle(Theme.muted)
                            if let status = app.profileStatusLabel { Text(status).font(.system(size: 11)).foregroundStyle(Theme.muted) }
                            if app.status == "error", let appError = app.error { Text(appError).font(.system(size: 11)).foregroundStyle(Theme.danger) }
                        }
                        Spacer(minLength: 8)
                        Text(app.statusLabel).font(.system(size: 11, weight: .medium)).foregroundStyle(app.statusTint)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Menu {
                    if app.status == "error" { Button("重新连接") { perform { try await workspace.setFeishuEnabled(appID: app.id, true) } } }
                    if !app.ownerBound { Button("绑定主人") { perform { bindCodes[app.id] = try await workspace.startFeishuBind(appID: app.id) } } }
                    Button(app.userAuthorized ? "重新授权文档" : "授权文档访问") { perform { try await workspace.startFeishuUserAuth(appID: app.id) } }
                    Button(app.enabled ? "停用" : "启用") { perform { try await workspace.setFeishuEnabled(appID: app.id, !app.enabled) } }
                    Divider()
                    Button("移除", role: .destructive) { confirmingRemove = app.id }
                } label: { Image(systemName: "ellipsis").font(.system(size: 13)).foregroundStyle(Theme.muted).frame(width: 28, height: 28) }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().disabled(busy)
                .accessibilityLabel("更多操作")
            }
            if confirmingRemove == app.id {
                HStack(spacing: 8) {
                    Text("移除「\(app.displayName)」？").font(.system(size: 12))
                    MBButton(title: "确认移除", kind: .danger, busy: busy) { perform { try await workspace.removeFeishu(appID: app.id); confirmingRemove = nil } }
                    MBButton(title: "取消") { confirmingRemove = nil }
                }
            }
            if let code = bindCodes[app.id], !app.ownerBound {
                Text("在飞书私聊机器人发送 \(code)，10 分钟内有效").font(.system(size: 11)).foregroundStyle(Theme.muted).textSelection(.enabled)
            }
            if let auth, auth.appID == app.id { authSection(auth) }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
    }

    @ViewBuilder private func appDetail(_ app: FeishuAppView) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Button { openAppID = nil } label: {
                HStack(spacing: 4) { Image(systemName: "chevron.left").font(.system(size: 11, weight: .semibold)); Text("飞书").font(.system(size: 12)) }
                    .foregroundStyle(Theme.muted).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            FeishuAppOverview(workspace: workspace, app: app, busy: busy) { botID in
                perform { try await workspace.changeFeishuReceiver(appID: app.id, botID: botID) }
            }
            if app.status == "error" {
                HStack(spacing: 10) {
                    MBBanner(text: app.error ?? "连接异常", isError: true)
                    MBButton(title: "重新连接", kind: .brand, busy: busy) { perform { try await workspace.setFeishuEnabled(appID: app.id, true) } }
                }
            }
            else if app.status == "busy" { MBBanner(text: "另一个程序正在使用这个应用的长连接", isError: true) }
            else if !app.enabled {
                HStack { MBBanner(text: "已停用，不收发消息"); MBButton(title: "启用", busy: busy) { perform { try await workspace.setFeishuEnabled(appID: app.id, true) } } }
            }
            if let error { MBBanner(text: error, isError: true) }
            FeishuGroupsView(workspace: workspace, app: app)
        }
    }

    @ViewBuilder private var addSection: some View {
        if let job, job.stage == "qr", let qr = job.qrValue(origin: workspace.client.origin) {
            HStack(alignment: .top, spacing: 16) {
                FeishuQRView(text: qr)
                VStack(alignment: .leading, spacing: 10) {
                    Text("用飞书「扫一扫」扫码并确认，完成后自动连接。").font(.system(size: 11)).foregroundStyle(Theme.muted)
                    HStack(spacing: 8) {
                        if let rawURL = job.url, let link = URL(string: rawURL), Markdown.isOpenable(link) {
                            MBButton(title: "打开飞书授权页", kind: .brand) { openURL(link) }
                        }
                        MBButton(title: "取消", enabled: !busy) { perform { try await workspace.cancelFeishuRegister() } }
                    }
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
                if let job, job.stage == "error", let jobError = job.error { MBBanner(text: jobError, isError: true) }
                MBSelect(label: "接收助手", selection: Binding(get: { botID }, set: { selectedBotID = $0 }), options: [("", "请选择助手")] + workspace.bots.map { ($0.id, $0.name) })
                HStack(spacing: 8) {
                    MBButton(title: "扫码创建应用", kind: .primary, busy: busy, enabled: !botID.isEmpty) {
                        perform { try await workspace.startFeishuRegister(botID: botID) }
                    }
                    MBButton(title: "使用已有应用", enabled: !busy && !botID.isEmpty) { error = nil; notice = nil; manual = true }
                    if !apps.isEmpty { MBButton(title: "取消", enabled: !busy) { adding = false; selectedBotID = "" } }
                }
            }
        }
    }

    @ViewBuilder private func authSection(_ auth: FeishuJob) -> some View {
        if auth.isRunning, let url = auth.url {
            HStack(alignment: .top, spacing: 16) {
                FeishuQRView(text: url)
                VStack(alignment: .leading, spacing: 10) {
                    Text("用飞书扫码完成文档授权").font(.system(size: 11)).foregroundStyle(Theme.muted)
                    HStack(spacing: 8) {
                        if let link = URL(string: url), Markdown.isOpenable(link) {
                            MBButton(title: "打开飞书授权页", kind: .brand) { openURL(link) }
                        }
                        MBButton(title: "取消", enabled: !busy) { perform { try await workspace.cancelFeishuUserAuth() } }
                    }
                }
            }
        } else if auth.stage == "error", let authError = auth.error {
            Text(authError).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled)
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

// 使用已有应用（兜底）：粘贴 App ID / Secret，主人稍后用绑定码绑定。
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
                    .padding(10)
                    .background(.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.border))
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

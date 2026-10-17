import SwiftUI
import NexClientKit

/// The 设备网络 page pushed from the account menu: devices, host-device capabilities and the backend address.
struct DevicesView: View {
    let workspace: WorkspaceStore
    @State private var pairing = false
    @State private var revoking: Device?
    @State private var reconciling: UnknownCall?
    @State private var rootText = ""
    @State private var rootEdited = false
    @State private var savingRoot = false
    @State private var rootNotice: String?
    @State private var rootError: String?
    @State private var errorText: String?

    private var state: WorkspaceState? { workspace.state }
    private var devices: [Device] { state?.devices ?? [] }
    private var node: NodeState? { state?.node }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                if let errorText { InlineBanner(text: errorText) }
                deviceList
                if let node {
                    if node.hosted { hostedCard } else { hostCard(node) }
                }
                connectionCard
            }
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.background)
        .navigationTitle("设备网络")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .refreshable { await workspace.refresh() }
        .onAppear { syncRoot() }
        .onChange(of: node?.root) { _, _ in syncRoot() }
        .sheet(isPresented: $pairing) { PairDeviceSheet(workspace: workspace) }
        .confirmationDialog("撤销该设备的配对？", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible, presenting: revoking) { device in
            Button("撤销「\(device.name)」", role: .destructive) { Task { await revoke(device) } }
            Button("取消", role: .cancel) {}
        } message: { _ in Text("撤销后，该设备将无法继续连接后端。") }
        .confirmationDialog("确认该调用已停止？", isPresented: Binding(get: { reconciling != nil }, set: { if !$0 { reconciling = nil } }), titleVisibility: .visible, presenting: reconciling) { call in
            Button("已核实停止", role: .destructive) { Task { await reconcile(call) } }
            Button("取消", role: .cancel) {}
        } message: { _ in Text("请先检查设备实际执行结果。确认后不会重试原操作。") }
        .onDebugUI { cmd, arg in
            switch cmd {
            case "d-pairopen": pairing = true
            case "d-root": rootText = arg; rootEdited = true
            case "d-saveroot": Task { await saveRoot() }
            case "d-revoke": if let d = devices.first(where: { $0.name == arg }) { revoking = d }
            case "d-revokeconfirm": if let d = devices.first(where: { $0.name == arg }) { Task { await revoke(d) } }
            case "d-reconcile": reconciling = node?.unknownCalls.first
            default: break
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("PERSONAL AI OS · DEVICES").font(.caption).foregroundStyle(Theme.muted)
            Text("设备网络").font(.largeTitle.weight(.bold))
            Text("设备执行节点独立连接后端。客户端只显示和管理后端已注册的设备。").font(.subheadline).foregroundStyle(Theme.muted)
            Button { pairing = true } label: {
                Label("生成配对令牌", systemImage: "plus").font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.primaryForeground).padding(.horizontal, 16).padding(.vertical, 10)
                    .background(Theme.primary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain).padding(.top, 8)
        }
    }

    private var deviceList: some View {
        VStack(spacing: 10) {
            ForEach(devices, id: \.id) { device in
                let isHost = state?.isHost(device) == true
                HStack(spacing: 12) {
                    Image(systemName: isHost ? "desktopcomputer" : "laptopcomputer.and.iphone").foregroundStyle(Theme.muted)
                        .frame(width: 36, height: 36).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(device.name + (isHost ? " · 后端主机" : "")).font(.subheadline.weight(.semibold)).lineLimit(2)
                        StatusChip(text: device.statusText, tone: device.isRevoked ? .bad : device.online ? .good : .neutral)
                    }
                    Spacer()
                    if device.isBound && !isHost {
                        Button("撤销") { revoking = device }.buttonStyle(PillButtonStyle(danger: true))
                    }
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading).cardStyle()
            }
        }
    }

    private var hostedCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("你的设备").font(.subheadline.weight(.semibold))
            Text("此工作区只连接你配对的设备。添加设备后，Agent 可以使用该设备授权的能力。").font(.footnote).foregroundStyle(Theme.muted)
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading).cardStyle()
    }

    private func hostCard(_ node: NodeState) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("后端主机能力").font(.subheadline.weight(.semibold))
                Spacer()
                StatusChip(text: "状态：\(node.status)", tone: node.connected ? .good : .neutral)
            }
            Text("这些能力作用于运行后端服务的主机。客户端不运行本地终端或设备执行节点。").font(.footnote).foregroundStyle(Theme.muted)
            Text(node.summary).font(.footnote)
            ForEach(node.unknownCalls, id: \.callID) { call in
                VStack(alignment: .leading, spacing: 8) {
                    Text("需要核对设备执行结果").font(.subheadline.weight(.semibold))
                    Text(call.argumentsText).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    Text("上次执行中断，这个调用不会重放。请检查后端主机上的进程和操作结果，再确认已停止。").font(.footnote).foregroundStyle(Theme.muted)
                    Button("已核实停止") { reconciling = call }.buttonStyle(PillButtonStyle())
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.approvalSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            FormField(title: "后端允许读取的目录（可留空）") {
                TextField("填写后端主机上的目录路径", text: Binding(get: { rootText }, set: { rootText = $0; rootEdited = true; rootNotice = nil }))
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
            }
            if let rootError {
                InlineBanner(text: rootError)
                if rootError.contains("没有配置后端设备能力的权限") {
                    Text("后端主机能力只能由后端所在电脑上的客户端修改；这里仅显示当前状态。").font(.caption).foregroundStyle(Theme.muted)
                }
            }
            if let rootNotice { InlineBanner(text: rootNotice, tone: .good) }
            PrimaryButton(title: savingRoot ? "保存中…" : "保存后端文件目录", busy: savingRoot) { Task { await saveRoot() } }.disabled(savingRoot)
            Text("危险操作会在执行 Agent 的消息中请求批准。").font(.caption).foregroundStyle(Theme.muted)
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading).cardStyle()
    }

    private var connectionCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("后端连接").font(.subheadline.weight(.semibold))
            Text(state?.address ?? "").font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                .padding(8).frame(maxWidth: .infinity, alignment: .leading).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            Text("监听地址、HTTPS 与端口由后端服务的部署配置管理。").font(.footnote).foregroundStyle(Theme.muted)
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading).cardStyle()
    }

    // MARK: Actions

    private func syncRoot() { if !rootEdited { rootText = node?.root ?? "" } }

    private func revoke(_ device: Device) async {
        errorText = nil
        do { try await workspace.revokeDevice(device.id) }
        catch { errorText = coreMessage(error); await workspace.refresh() }
    }

    private func reconcile(_ call: UnknownCall) async {
        rootError = nil
        do { try await workspace.reconcileNodeCall(call.callID) }
        catch { rootError = coreMessage(error); await workspace.refresh() }
    }

    private func saveRoot() async {
        savingRoot = true; rootError = nil; rootNotice = nil
        defer { savingRoot = false }
        do {
            let next = try await workspace.configureNode(root: rootText.trimmingCharacters(in: .whitespaces))
            rootEdited = false; rootText = next.root; rootNotice = "后端文件目录已保存。"
        } catch { rootError = coreMessage(error) }
    }
}

// MARK: - Pair sheet

/// Sheet: name a device, then show the one-time pairing token with copy.
private struct PairDeviceSheet: View {
    let workspace: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var busy = false
    @State private var errorText: String?
    @State private var pairing: DevicePairing?
    @State private var copied = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let pairing { result(pairing) } else { form }
                }
                .padding(16)
            }
            .background(Theme.background)
            .navigationTitle(pairing == nil ? "添加设备" : "在设备执行节点完成配对")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { if pairing == nil { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(busy) } } }
            .onDebugUI { cmd, arg in
                if cmd == "d-name" { name = arg }
                if cmd == "d-pair" { Task { await pair() } }
                if cmd == "d-copy" { copy() }
                if cmd == "d-close" { dismiss() }
            }
        }
        .interactiveDismissDisabled(pairing != nil || busy)
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 16) {
            FormField(title: "设备名称") {
                TextField("例如：书房电脑", text: $name).onChange(of: name) { _, v in if v.count > 80 { name = String(v.prefix(80)) } }
            }
            if let errorText { InlineBanner(text: errorText) }
            PrimaryButton(title: busy ? "生成中…" : "生成配对令牌", busy: busy) { Task { await pair() } }
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || busy)
        }
    }

    private func result(_ pairing: DevicePairing) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("后端地址：\(workspace.state?.address ?? "")").font(.footnote).foregroundStyle(Theme.muted).textSelection(.enabled)
            FormField(title: "设备令牌（仅显示本次）") {
                Text(pairing.token).font(.system(.footnote, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            }
            Button { copy() } label: { Label(copied ? "已复制" : "复制令牌", systemImage: copied ? "checkmark" : "doc.on.doc") }
                .buttonStyle(PillButtonStyle())
            PrimaryButton(title: "已复制，关闭") { dismiss() }
        }
    }

    private func copy() {
        guard let token = pairing?.token else { return }
        UIPasteboard.general.string = token; copied = true
    }

    private func pair() async {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !busy else { return }
        busy = true; errorText = nil
        defer { busy = false }
        do { pairing = try await workspace.pairDevice(name: trimmed) }
        catch { errorText = coreMessage(error) }
    }
}

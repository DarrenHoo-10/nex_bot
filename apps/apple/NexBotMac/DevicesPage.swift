import SwiftUI
import AppKit
import NexClientKit

/// Main-area 设备网络 page: paired devices, host capabilities and the backend address (web `Devices`).
struct DevicesPage: View {
    let workspace: WorkspaceStore

    @State private var showPair = false
    @State private var pairName = ""
    @State private var pairing: DevicePairing?
    @State private var revokeTarget: Device?
    @State private var reconcileTarget: UnknownCall?
    @State private var banner: String?
    @State private var root = ""
    @State private var rootDirty = false
    @State private var nodeFeedback: (text: String, isError: Bool)?
    @State private var busy = false

    private var state: WorkspaceState? { workspace.state }
    private var address: String { state?.address ?? "" }

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                MBPageBar(title: "设备网络")
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        header
                        if let banner { MBBanner(text: banner, isError: true) }
                        if let pairing { pairingCard(pairing) }
                        ForEach(state?.devices ?? []) { deviceRow($0) }
                        if let node = state?.node {
                            if node.hosted { hostedCard } else { hostCard(node) }
                        }
                        connectionCard
                    }
                    .frame(maxWidth: 780, alignment: .leading)
                    .padding(.horizontal, 40).padding(.vertical, 40)
                    .frame(maxWidth: .infinity)
                }
            }
            if showPair { pairDialog }
            if let device = revokeTarget { revokeDialog(device) }
            if let call = reconcileTarget { reconcileDialog(call) }
        }
        .background(Theme.background)
        .onAppear { syncRoot() }
        .onChange(of: state?.node?.root) { if !rootDirty { syncRoot() } }
        #if DEBUG
        .task { MBDebug.start() }
        .onReceive(NotificationCenter.default.publisher(for: .mbDebug)) { handleDebug($0) }
        #endif
    }

    private func syncRoot() { root = state?.node?.root ?? "" }

    // MARK: Cards

    private var header: some View {
        MBCard {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 0) {
                    Text("PERSONAL AI OS · DEVICES").font(.system(size: 9, weight: .semibold)).tracking(1).foregroundStyle(Theme.muted.opacity(0.7))
                    Text("设备网络").font(.system(size: 22, weight: .bold)).padding(.top, 10)
                    Text("设备执行节点独立连接后端。客户端只显示和管理后端已注册的设备。").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.top, 8)
                }
                Spacer()
                MBButton(title: "生成配对令牌", kind: .primary, icon: "plus") { pairName = ""; showPair = true }
            }
        }
    }

    private func pairingCard(_ pairing: DevicePairing) -> some View {
        MBCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("在设备执行节点完成配对").font(.system(size: 14, weight: .bold))
                Text("后端地址：\(address)").font(.system(size: 12)).foregroundStyle(Theme.muted).textSelection(.enabled)
                VStack(alignment: .leading, spacing: 8) {
                    Text("设备令牌（仅显示本次）").font(.system(size: 12, weight: .medium))
                    TextField("", text: .constant(pairing.token)).textFieldStyle(.plain)
                        .font(.system(size: 11, design: .monospaced)).padding(.horizontal, 12).frame(height: 38)
                        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .accessibilityLabel("设备令牌（仅显示本次）")
                }
                HStack(spacing: 8) {
                    MBButton(title: "复制令牌", icon: "doc.on.doc") { copy(pairing.token) }
                    MBButton(title: "已复制，关闭", kind: .primary) { copy(pairing.token); self.pairing = nil }
                }
            }
        }
    }

    private func deviceRow(_ device: Device) -> some View {
        let isHost = device.id == state?.hostDeviceID
        return MBCard(padding: 20) {
            HStack(spacing: 14) {
                Image(systemName: "cpu").font(.system(size: 20, weight: .light)).frame(width: 32)
                VStack(alignment: .leading, spacing: 5) {
                    Text(device.name + (isHost ? " · 后端主机" : "")).font(.system(size: 12, weight: .bold))
                    Text(device.statusText).font(.system(size: 10)).foregroundStyle(Theme.muted)
                }
                Spacer()
                if device.isBound && !isHost { MBButton(title: "撤销", kind: .danger) { revokeTarget = device } }
            }
        }
    }

    private var hostedCard: some View {
        MBCard {
            VStack(alignment: .leading, spacing: 8) {
                Text("你的设备").font(.system(size: 14, weight: .bold))
                Text("此工作区只连接你配对的设备。添加设备后，Agent 可以使用该设备授权的能力。").font(.system(size: 12)).foregroundStyle(Theme.muted)
            }
        }
    }

    private func hostCard(_ node: NodeState) -> some View {
        MBCard {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "shield").font(.system(size: 14)).foregroundStyle(Theme.brand)
                        .frame(width: 36, height: 36).background(Theme.brandSoft, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    VStack(alignment: .leading, spacing: 6) {
                        Text("后端主机能力").font(.system(size: 14, weight: .bold))
                        Text("这些能力作用于运行后端服务的主机。客户端不运行本地终端或设备执行节点。").font(.system(size: 11)).foregroundStyle(Theme.muted)
                    }
                    Spacer()
                    MBChip(text: "状态：\(node.status)", tone: .success)
                }
                Text(node.summary).font(.system(size: 11)).foregroundStyle(Theme.muted)
                ForEach(node.unknownCalls) { call in
                    VStack(alignment: .leading, spacing: 10) {
                        Text("需要核对设备执行结果").font(.system(size: 12, weight: .bold))
                        Text(call.argumentsText).font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
                            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.card, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        Text("上次执行中断，这个调用不会重放。请检查后端主机上的进程和操作结果，再确认已停止。").font(.system(size: 11)).foregroundStyle(Theme.muted)
                        MBButton(title: "已核实停止") { reconcileTarget = call }
                    }
                    .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.approvalSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                MBInput(label: "后端允许读取的目录（可留空）", text: Binding(get: { root }, set: { root = $0; rootDirty = true; nodeFeedback = nil }),
                        placeholder: "填写后端主机上的目录路径", mono: true)
                VStack(alignment: .leading, spacing: 8) {
                    MBButton(title: "保存后端文件目录", kind: .primary, busy: busy, action: saveRoot)
                    Text("危险操作会在执行 Agent 的消息中请求批准。").font(.system(size: 10)).foregroundStyle(Theme.muted)
                    if let nodeFeedback {
                        Text(nodeFeedback.text).font(.system(size: 11)).foregroundStyle(nodeFeedback.isError ? Theme.danger : Theme.success).textSelection(.enabled)
                    }
                }
            }
        }
    }

    private var connectionCard: some View {
        MBCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("后端连接").font(.system(size: 14, weight: .bold))
                Text(address).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted).textSelection(.enabled)
                Text("监听地址、HTTPS 与端口由后端服务的部署配置管理。").font(.system(size: 11)).foregroundStyle(Theme.muted)
            }
        }
    }

    // MARK: Dialogs

    private var pairDialog: some View {
        MBModal(title: "添加设备", closeLabel: "关闭", canClose: !busy, close: { showPair = false }) {
            VStack(alignment: .leading, spacing: 16) {
                MBInput(label: "设备名称", text: $pairName, placeholder: "例如：办公室电脑")
                HStack(spacing: 8) {
                    MBButton(title: busy ? "处理中…" : "生成配对令牌", kind: .primary, busy: busy,
                             enabled: !pairName.trimmingCharacters(in: .whitespaces).isEmpty, action: pair)
                    MBButton(title: "取消", enabled: !busy) { showPair = false }
                }
            }
        }
    }

    private func revokeDialog(_ device: Device) -> some View {
        MBModal(title: "确认撤销该设备？", width: 400, canClose: !busy, close: { revokeTarget = nil }) {
            VStack(alignment: .leading, spacing: 16) {
                Text("撤销“\(device.name)”后，它将无法再连接此工作区。").font(.system(size: 12)).foregroundStyle(Theme.muted)
                HStack(spacing: 8) {
                    MBButton(title: "确认撤销", kind: .danger, busy: busy) { revoke(device) }
                    MBButton(title: "取消", enabled: !busy) { revokeTarget = nil }
                }
            }
        }
    }

    private func reconcileDialog(_ call: UnknownCall) -> some View {
        MBModal(title: "确认该调用已停止？", width: 400, canClose: !busy, close: { reconcileTarget = nil }) {
            VStack(alignment: .leading, spacing: 16) {
                Text("请先检查设备实际执行结果。确认后不会重试原操作。").font(.system(size: 12)).foregroundStyle(Theme.muted)
                HStack(spacing: 8) {
                    MBButton(title: "已核实停止", kind: .primary, busy: busy) { reconcile(call) }
                    MBButton(title: "取消", enabled: !busy) { reconcileTarget = nil }
                }
            }
        }
    }

    // MARK: Actions

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    private func pair() {
        busy = true
        Task {
            defer { busy = false }
            do { pairing = try await workspace.pairDevice(name: pairName.trimmingCharacters(in: .whitespaces)); showPair = false; banner = nil }
            catch { showPair = false; banner = mbFallbackMessage(error) }
        }
    }

    private func revoke(_ device: Device) {
        busy = true
        Task {
            defer { busy = false; revokeTarget = nil }
            do { try await workspace.revokeDevice(device.id); banner = nil }
            catch { banner = mbFallbackMessage(error); await workspace.refresh() }
        }
    }

    private func reconcile(_ call: UnknownCall) {
        busy = true
        Task {
            defer { busy = false; reconcileTarget = nil }
            do { try await workspace.reconcileNodeCall(call.callID); nodeFeedback = nil }
            catch { nodeFeedback = (mbFallbackMessage(error), true); await workspace.refresh() }
        }
    }

    private func saveRoot() {
        busy = true
        Task {
            defer { busy = false }
            do {
                let node = try await workspace.configureNode(root: root.trimmingCharacters(in: .whitespaces))
                root = node.root; rootDirty = false
                nodeFeedback = ("后端文件目录已保存。", false)
            } catch { nodeFeedback = (mbFallbackMessage(error), true) }
        }
    }

    #if DEBUG
    private func handleDebug(_ note: Notification) {
        guard let cmd = note.mbCommand, cmd.prefix == "dv" else { return }
        switch cmd.verb {
        case "pair": pairName = ""; showPair = true
        case "name": pairName = cmd.arg
        case "submit": pair()
        case "closepair": pairing = nil
        case "revoke": revokeTarget = state?.devices.first { $0.name == cmd.arg }
        case "confirm": if let d = revokeTarget { revoke(d) }
        case "cancel": revokeTarget = nil; reconcileTarget = nil; showPair = false
        case "root": root = cmd.arg; rootDirty = true
        case "saveroot": saveRoot()
        case "reconcile": reconcileTarget = state?.node?.unknownCalls.first
        case "confirmreconcile": if let c = reconcileTarget { reconcile(c) }
        default: break
        }
    }
    #endif
}

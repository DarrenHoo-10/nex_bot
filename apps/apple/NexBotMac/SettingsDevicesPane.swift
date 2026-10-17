import SwiftUI
import AppKit
import NexClientKit

/// Settings 设备 category: paired devices and unresolved device calls (web `Devices` inside settings).
struct SettingsDevicesPane: View {
    let workspace: WorkspaceStore

    @State private var showPair = false
    @State private var pairName = ""
    @State private var pairing: DevicePairing?
    @State private var revokeTarget: Device?
    @State private var reconcileTarget: UnknownCall?
    @State private var banner: String?
    @State private var busy = false
    @State private var nodeError: String?

    private var state: WorkspaceState? { workspace.state }
    private var address: String { state?.address ?? "" }

    var body: some View {
        ZStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    if let banner { MBBanner(text: banner, isError: true) }
                    if let pairing { pairingCard(pairing) }
                    ForEach(state?.devices ?? []) { deviceRow($0) }
                    ForEach(state?.node?.unknownCalls ?? []) { unknownCallCard($0) }
                }
                .padding(.bottom, 34)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if showPair { pairDialog }
            if let device = revokeTarget { revokeDialog(device) }
            if let call = reconcileTarget { reconcileDialog(call) }
        }
        #if DEBUG
        .task { MBDebug.start() }
        .onReceive(NotificationCenter.default.publisher(for: .mbDebug)) { handleDebug($0) }
        #endif
    }

    // MARK: Cards

    private var header: some View {
        paneHeader("设备网络", "管理助手可以使用的设备。") {
            MBButton(title: "生成配对令牌", kind: .brand, icon: "plus") { pairName = ""; showPair = true }
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

    private func unknownCallCard(_ call: UnknownCall) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("需要核对设备执行结果").font(.system(size: 12, weight: .bold))
            Text(call.argumentsText).font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            Text("上次执行中断，这个调用不会重放。请检查后端主机上的进程和操作结果，再确认已停止。").font(.system(size: 11)).foregroundStyle(Theme.muted)
            if let nodeError { Text(nodeError).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled) }
            MBButton(title: "已核实停止") { reconcileTarget = call }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.approvalSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
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
            do { try await workspace.reconcileNodeCall(call.callID); nodeError = nil }
            catch { nodeError = mbFallbackMessage(error); await workspace.refresh() }
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
        case "reconcile": reconcileTarget = state?.node?.unknownCalls.first
        case "confirmreconcile": if let c = reconcileTarget { reconcile(c) }
        default: break
        }
    }
    #endif
}

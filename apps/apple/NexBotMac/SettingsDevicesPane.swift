import SwiftUI
import NexClientKit

/// Settings 设备 category: signed-in devices (`/api/clients`) and unresolved device calls (web `Devices` inside settings).
struct SettingsDevicesPane: View {
    let workspace: WorkspaceStore
    @Environment(LocalDeviceController.self) private var device

    @State private var reconcileTarget: UnknownCall?
    @State private var localReconcile: UnknownCall?
    @State private var busy = false
    @State private var localPending = false
    @State private var nodeError: String?
    @State private var listError = false
    @State private var actionError: String?
    @State private var loaded = false
    @State private var clock = Date()

    private var state: WorkspaceState? { workspace.state }
    private var local: LocalDeviceState { device.state }
    private var visible: [ClientSession] {
        workspace.sessions
            .filter { $0.row.double("revoked_at") == nil && ($0.expiresAt.map { $0 > clock } ?? true) }
            .sorted { ($0.sessionID == workspace.currentSessionID ? 1 : 0) > ($1.sessionID == workspace.currentSessionID ? 1 : 0) }
    }

    var body: some View {
        ZStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    paneHeader("设备")
                    VStack(spacing: 0) { ForEach(visible) { sessionRow($0) } }
                    VStack(alignment: .leading, spacing: 14) {
                        if !loaded { Text("正在加载…").font(.system(size: 12)).foregroundStyle(Theme.muted) }
                        else if !listError && visible.isEmpty { Text("暂无设备").font(.system(size: 12)).foregroundStyle(Theme.muted) }
                        if listError { Text("设备列表加载失败").font(.system(size: 12)).foregroundStyle(Theme.danger) }
                        if let actionError { Text(actionError).font(.system(size: 12)).foregroundStyle(Theme.danger).textSelection(.enabled) }
                        ForEach(local.unknownCalls) { localUnknownCard($0) }
                        ForEach(state?.node?.unknownCalls ?? []) { unknownCallCard($0) }
                    }
                    .padding(.top, 18)
                }
                .padding(.bottom, 34)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let call = reconcileTarget { reconcileDialog(call) }
            if let call = localReconcile { localReconcileDialog(call) }
        }
        .task { await poll() }
        #if DEBUG
        .task { MBDebug.start() }
        .onReceive(NotificationCenter.default.publisher(for: .mbDebug)) { handleDebug($0) }
        #endif
    }

    // MARK: Rows

    private func sessionRow(_ session: ClientSession) -> some View {
        let isCurrent = session.sessionID == workspace.currentSessionID
        let online = session.lastSeenAt.map { clock.timeIntervalSince($0) < 90 } ?? false
        return VStack(spacing: 0) {
            HStack(spacing: 16) {
                Image(systemName: "laptopcomputer").font(.system(size: 18, weight: .light)).foregroundStyle(Theme.muted).frame(width: 26)
                HStack(spacing: 10) {
                    Text(session.name.isEmpty ? "未命名设备" : session.name).font(.system(size: 13, weight: .bold))
                    if isCurrent {
                        Text("本设备").font(.system(size: 10, weight: .medium)).foregroundStyle(Theme.brand)
                            .padding(.horizontal, 7).padding(.vertical, 2).background(Theme.brandSoft, in: RoundedRectangle(cornerRadius: 5))
                    }
                }
                Spacer()
                HStack(spacing: 7) {
                    Circle().fill(online ? Theme.brand : Theme.muted).frame(width: 6, height: 6)
                    Text((online ? "在线" : "离线") + (isCurrent && local.paused ? " · 已暂停" : "")).font(.system(size: 12)).foregroundStyle(Theme.muted)
                }
                if isCurrent && local.available {
                    MBButton(title: localPending ? "处理中…" : local.paused ? "恢复控制" : "暂停控制", enabled: !localPending && local.authorized) { togglePause() }
                }
            }
            .padding(.vertical, 20)
            Hairline()
        }
    }

    private func localUnknownCard(_ call: UnknownCall) -> some View {
        HStack {
            Text("需要核实执行结果").font(.system(size: 12, weight: .bold))
            Spacer()
            MBButton(title: "核实并解除暂停", enabled: !localPending) { localReconcile = call }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.approvalSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func unknownCallCard(_ call: UnknownCall) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("需要核对设备执行结果").font(.system(size: 12, weight: .bold))
            Text(call.argumentsText).font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            if let nodeError { Text(nodeError).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled) }
            MBButton(title: "已核实停止") { reconcileTarget = call }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.approvalSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // MARK: Dialogs

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

    private func localReconcileDialog(_ call: UnknownCall) -> some View {
        MBModal(title: "核实执行结果", width: 400, canClose: !localPending, close: { localReconcile = nil }) {
            VStack(alignment: .leading, spacing: 16) {
                Text("已确认这项操作停止？").font(.system(size: 13, weight: .medium))
                Text("确认后只清除未决状态，不会重新执行。").font(.system(size: 12)).foregroundStyle(Theme.muted)
                HStack(spacing: 8) {
                    MBButton(title: "已确认停止", kind: .primary, busy: localPending) { reconcileLocal(call) }
                    MBButton(title: "取消", enabled: !localPending) { localReconcile = nil }
                }
            }
        }
    }

    // MARK: Actions

    /// Refreshes the signed-in devices every 2 s while the pane is on screen (like the web).
    private func poll() async {
        while !Task.isCancelled {
            do { try await workspace.loadSessions(); listError = false }
            catch { listError = true }
            loaded = true; clock = Date()
            try? await Task.sleep(for: .seconds(2))
        }
    }

    private func togglePause() {
        localPending = true; actionError = nil
        Task {
            defer { localPending = false }
            do { try await device.setPaused(!local.paused) } catch { actionError = mbFallbackMessage(error) }
        }
    }

    private func reconcileLocal(_ call: UnknownCall) {
        localPending = true; actionError = nil
        Task {
            defer { localPending = false; localReconcile = nil }
            do { try await device.reconcile(call) } catch { actionError = mbFallbackMessage(error) }
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
        case "cancel": reconcileTarget = nil; localReconcile = nil
        case "reconcile": reconcileTarget = state?.node?.unknownCalls.first
        case "confirmreconcile": if let c = reconcileTarget { reconcile(c) }
        default: break
        }
    }
    #endif
}

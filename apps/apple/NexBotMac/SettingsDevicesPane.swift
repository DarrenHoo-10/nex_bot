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
    @State private var agentPending = false
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
                VStack(alignment: .leading, spacing: 18) {
                    paneHeader("设备")
                    if !visible.isEmpty {
                        MBCard(padding: 0) {
                            VStack(spacing: 0) {
                                ForEach(Array(visible.enumerated()), id: \.element.id) { index, session in
                                    sessionRow(session, showDivider: index < visible.count - 1)
                                }
                            }
                        }
                    }
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

    private func deviceSymbol(_ name: String) -> String {
        let lower = name.lowercased()
        if lower.range(of: #"\b(android|iphone|ipad|ios|mobile|phone|pixel|huawei|xiaomi|redmi|honor|oppo|vivo|oneplus|samsung)\b|手机"#, options: .regularExpression) != nil {
            return "iphone"
        }
        if lower.range(of: #"\b(browser|chrome|safari|firefox|edge|web)\b|浏览器"#, options: .regularExpression) != nil {
            return "globe"
        }
        return "laptopcomputer"
    }

    private func sessionRow(_ session: ClientSession, showDivider: Bool) -> some View {
        let isCurrent = session.sessionID == workspace.currentSessionID
        let online = session.lastSeenAt.map { clock.timeIntervalSince($0) < 90 } ?? false
        return VStack(spacing: 0) {
            HStack(spacing: 14) {
                Image(systemName: deviceSymbol(session.name))
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Theme.brand)
                    .frame(width: 36, height: 36)
                    .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border))
                HStack(spacing: 10) {
                    Text(session.name.isEmpty ? "未命名设备" : session.name).font(.system(size: 13, weight: .bold))
                    if isCurrent {
                        Text("当前设备").font(.system(size: 10.5, weight: .medium)).foregroundStyle(Theme.brandInk)
                            .padding(.horizontal, 8).padding(.vertical, 2).background(Theme.brandSoft, in: Capsule())
                    }
                }
                Spacer()
                HStack(spacing: 7) {
                    Circle()
                        .fill(online ? Theme.success : Theme.muted)
                        .frame(width: 7, height: 7)
                        .shadow(color: online ? Theme.success.opacity(0.45) : .clear, radius: 3)
                    Text((online ? "在线" : "离线") + (isCurrent && local.paused ? " · 已暂停" : "")).font(.system(size: 12)).foregroundStyle(Theme.muted)
                }
                if isCurrent && local.available {
                    MBButton(title: localPending ? "处理中…" : local.paused ? "恢复控制" : "暂停控制", enabled: !localPending && local.authorized) { togglePause() }
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 15)
            if isCurrent && local.available && local.authorized && local.agentSessions.available { agentRow }
            if showDivider { Hairline().padding(.leading, 66) }
        }
    }

    /// This Mac's "Agent 会话" switch with the herdr-core / CLI status in one line.
    private var agentRow: some View {
        let agent = local.agentSessions
        let status = agentStatus
        return HStack(spacing: 10) {
            Text("Agent 会话").font(.system(size: 12, weight: .medium))
            Text(status.text).font(.system(size: 12)).foregroundStyle(status.failed ? Theme.danger : Theme.muted).lineLimit(1)
            Spacer()
            Toggle("", isOn: Binding(get: { agent.enabled }, set: { setAgentSessions($0) }))
                .toggleStyle(.switch).tint(Theme.brand).labelsHidden().controlSize(.mini).disabled(agentPending)
        }
        .padding(.leading, 66).padding(.trailing, 16).padding(.bottom, 14)
    }

    private var agentStatus: (text: String, failed: Bool) {
        let agent = local.agentSessions
        if !agent.enabled { return ("已关闭", false) }
        if local.paused { return ("已暂停", false) }
        switch agent.hc {
        case "error": return ("不可用", true)
        case "ready":
            let found = agent.engines.map { engine in
                let name: String = switch engine.engine {
                case "claude": "Claude Code"
                case "codex": "Codex"
                case "zcode": "ZCode"
                case "agy": "Antigravity"
                default: engine.engine
                }
                let number = engine.version.range(of: #"\d+(\.\d+)+"#, options: .regularExpression).map { String(engine.version[$0]) }
                return [name, number].compactMap { $0 }.joined(separator: " ")
            }
            return (found.isEmpty ? "未找到可用 CLI 工具" : found.joined(separator: " · "), false)
        default: return ("正在启动", false)
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

    private func setAgentSessions(_ enabled: Bool) {
        agentPending = true; actionError = nil
        Task {
            defer { agentPending = false }
            do { try await device.setAgentSessions(enabled: enabled) } catch { actionError = mbFallbackMessage(error) }
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

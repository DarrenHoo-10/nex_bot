import SwiftUI
import NexClientKit

/// The 设备 settings category (embedded in SettingsView's scroll view): signed-in devices from `/api/clients`
/// (refreshed every 2 s while visible, like the web) and unresolved execution approvals.
struct DevicesView: View {
    let workspace: WorkspaceStore
    @State private var reconciling: UnknownCall?
    @State private var reconcileError: String?
    @State private var loaded = false
    @State private var listFailed = false
    @State private var clock = Date()

    private var node: NodeState? { workspace.state?.node }
    private var visible: [ClientSession] {
        workspace.sessions
            .filter { $0.row.double("revoked_at") == nil && ($0.expiresAt.map { $0 > clock } ?? true) }
            .sorted { ($0.sessionID == workspace.currentSessionID ? 1 : 0) > ($1.sessionID == workspace.currentSessionID ? 1 : 0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !visible.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(visible.enumerated()), id: \.element.id) { index, session in
                        sessionRow(session)
                        if index < visible.count - 1 { Divider().overlay(Theme.border).padding(.leading, 62) }
                    }
                }
                .cardStyle(radius: 16)
            }
            if !loaded { Text("正在加载…").font(.footnote).foregroundStyle(Theme.muted) }
            else if !listFailed && visible.isEmpty { Text("暂无设备").font(.footnote).foregroundStyle(Theme.muted) }
            if listFailed { Text("设备列表加载失败").font(.footnote).foregroundStyle(Theme.danger) }
            ForEach(node?.unknownCalls ?? [], id: \.callID) { call in unknownCall(call) }
        }
        .task { await poll() }
        .confirmationDialog("确认该调用已停止？", isPresented: Binding(get: { reconciling != nil }, set: { if !$0 { reconciling = nil } }), titleVisibility: .visible, presenting: reconciling) { call in
            Button("已核实停止", role: .destructive) { Task { await reconcile(call) } }
            Button("取消", role: .cancel) {}
        } message: { _ in Text("请先检查设备实际执行结果。确认后不会重试原操作。") }
        .onDebugUI { cmd, _ in
            if cmd == "d-reconcile" { reconciling = node?.unknownCalls.first }
        }
    }

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

    private func sessionRow(_ session: ClientSession) -> some View {
        let isCurrent = session.sessionID == workspace.currentSessionID
        let online = session.lastSeenAt.map { clock.timeIntervalSince($0) < 90 } ?? false
        return HStack(spacing: 12) {
            Image(systemName: deviceSymbol(session.name))
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Theme.brand)
                .frame(width: 36, height: 36)
                .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.border))
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(session.name.isEmpty ? "未命名设备" : session.name).font(.subheadline.weight(.bold)).lineLimit(2)
                    if isCurrent {
                        Text("当前设备").font(.caption2.weight(.medium)).foregroundStyle(Theme.brandInk)
                            .padding(.horizontal, 8).padding(.vertical, 2).background(Theme.brandSoft, in: Capsule())
                    }
                }
                HStack(spacing: 6) {
                    Circle().fill(online ? Theme.success : Theme.muted).frame(width: 7, height: 7)
                    Text(online ? "在线" : "离线").font(.caption).foregroundStyle(Theme.muted)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 14)
    }

    private func unknownCall(_ call: UnknownCall) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("需要核对设备执行结果").font(.subheadline.weight(.semibold))
            Text(call.argumentsText).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            if let reconcileError { InlineBanner(text: reconcileError) }
            Button("已核实停止") { reconciling = call }.buttonStyle(PillButtonStyle())
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.approvalSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    // MARK: Actions

    private func poll() async {
        while !Task.isCancelled {
            do { try await workspace.loadSessions(); listFailed = false } catch { listFailed = true }
            loaded = true; clock = Date()
            try? await Task.sleep(for: .seconds(2))
        }
    }

    private func reconcile(_ call: UnknownCall) async {
        reconcileError = nil
        do { try await workspace.reconcileNodeCall(call.callID) }
        catch { reconcileError = coreMessage(error); await workspace.refresh() }
    }
}

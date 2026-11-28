import SwiftUI
import NexClientKit

struct AboutSettingsPane: View {
    let workspace: WorkspaceStore
    @State private var updater = AppUpdater.shared
    @State private var installError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            paneHeader("关于")
            MBCard(padding: 20) {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 14) {
                        BrandMark(size: 42)
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) {
                                Text("NexBot").font(.system(size: 16, weight: .bold))
                                Text(updater.current.isEmpty ? "—" : "v\(updater.current)")
                                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                                    .foregroundStyle(Theme.brandInk)
                                    .padding(.horizontal, 8).padding(.vertical, 2)
                                    .background(Theme.brandSoft, in: Capsule())
                            }
                            Text("macOS 原生客户端").font(.system(size: 12)).foregroundStyle(Theme.muted)
                        }
                        Spacer()
                        if case .ready = updater.status {
                            MBButton(title: updater.installing ? "正在更新…" : "立即更新", kind: .primary, busy: updater.installing) {
                                installError = nil
                                Task { do { try await updater.install() } catch { installError = (error as? CoreError)?.message ?? "安装更新失败" } }
                            }
                        } else {
                            MBButton(title: "检查更新", busy: busy) { Task { await updater.check(workspace.client) } }
                        }
                    }
                    if hasStatus {
                        Hairline()
                        Group {
                            switch updater.status {
                            case .checking:
                                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("正在检查更新…") }
                            case .downloading(let version, let progress):
                                let pct = progress.map { " \(Int(($0 * 100).rounded()))%" } ?? ""
                                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("新版本 \(version) 正在下载\(pct)…") }
                            case .ready(let version):
                                Label("新版本 \(version) 已就绪", systemImage: "checkmark.circle.fill").foregroundStyle(Theme.success)
                            case .current:
                                Text("已是最新版").foregroundStyle(Theme.muted)
                            case .failed(let message):
                                Text("检查更新失败：\(message)").foregroundStyle(Theme.danger)
                            case .idle:
                                EmptyView()
                            }
                        }
                        .font(.system(size: 12))
                        .accessibilityIdentifier("update-status")
                    }
                    if let installError { Text(installError).font(.system(size: 12)).foregroundStyle(Theme.danger) }
                }
            }
        }
    }

    private var hasStatus: Bool {
        if case .idle = updater.status { return false }
        return true
    }

    private var busy: Bool {
        switch updater.status { case .checking, .downloading: true; default: false }
    }
}

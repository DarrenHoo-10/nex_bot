import SwiftUI
import NexClientKit

struct AboutSettingsPane: View {
    let workspace: WorkspaceStore
    @State private var updater = AppUpdater.shared
    @State private var installError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            paneHeader("关于")
            Text("NexBot").font(.headline)
            infoRow("当前版本", updater.current.isEmpty ? "—" : updater.current)
            Group {
                switch updater.status {
                case .checking: ProgressView("正在检查更新…")
                case .downloading(let version): ProgressView("新版本 \(version) 正在下载…")
                case .ready(let version): Text("新版本 \(version) 已就绪")
                case .current: Text("已是最新版")
                case .failed(let message): Text("检查更新失败：\(message)").foregroundStyle(Theme.danger)
                case .idle: EmptyView()
                }
            }.font(.system(size: 12)).accessibilityIdentifier("update-status")
            if case .ready = updater.status {
                Button(updater.installing ? "正在更新…" : "立即更新") {
                    installError = nil
                    Task { do { try await updater.install() } catch { installError = (error as? CoreError)?.message ?? "安装更新失败" } }
                }.disabled(updater.installing)
            } else {
                Button("检查更新") { Task { await updater.check(workspace.client) } }
                    .disabled(busy)
            }
            if let installError { Text(installError).font(.system(size: 12)).foregroundStyle(Theme.danger) }
        }
    }

    private var busy: Bool {
        switch updater.status { case .checking, .downloading: true; default: false }
    }
}

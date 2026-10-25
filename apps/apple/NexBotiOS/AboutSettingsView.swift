import SwiftUI
import NexClientKit

struct AboutSettingsView: View {
    let workspace: WorkspaceStore
    @Environment(\.openURL) private var openURL
    @State private var checking = false
    @State private var checked = false
    @State private var offer: ClientUpdateOffer?
    @State private var error: String?
    private let current = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            PageHeading(title: "关于")
            Text("NexBot").font(.headline)
            FactRow(title: "当前版本", value: current.isEmpty ? "—" : current)
            if checking { ProgressView("正在检查更新…") }
            else if let error { Text("检查更新失败：\(error)").foregroundStyle(Theme.danger) }
            else if let offer { Text("新版本 \(offer.version) 可用") }
            else if checked { Text("已是最新版") }
            HStack {
                Button("检查更新") { Task { await check() } }
                    .buttonStyle(PillButtonStyle()).disabled(checking)
                if let offer, !checking {
                    Button("下载更新") { openURL(offer.url) }.buttonStyle(PillButtonStyle())
                }
            }
        }.font(.subheadline)
    }

    @MainActor private func check() async {
        guard !checking else { return }
        checking = true; error = nil; offer = nil
        defer { checking = false }
        do {
            offer = try await workspace.client.clientUpdate(platform: "ios", current: current)
            checked = true
        } catch { self.error = coreMessage(error) }
    }
}

import Observation
import SwiftUI
import NexClientKit

struct AboutSettingsView: View {
    let workspace: WorkspaceStore
    @Environment(\.openURL) private var openURL
    @Environment(IOSAppUpdater.self) private var updater

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            PageHeading(title: "关于")
            Text("NexBot").font(.headline)
            FactRow(title: "当前版本", value: updater.current.isEmpty ? "—" : updater.current)
            if updater.checking { ProgressView("正在检查更新…") }
            else if let error = updater.error { Text("检查更新失败：\(error)").foregroundStyle(Theme.danger) }
            else if let offer = updater.offer { Text("新版本 \(offer.version) 可用") }
            else if updater.checked { Text("已是最新版") }
            HStack {
                Button("检查更新") { Task { await updater.check(workspace.client) } }
                    .buttonStyle(PillButtonStyle()).disabled(updater.checking)
                if let offer = updater.offer, !updater.checking {
                    Button("下载更新") { openURL(offer.url) }.buttonStyle(PillButtonStyle())
                }
            }
        }.font(.subheadline)
    }
}

@MainActor @Observable
final class IOSAppUpdater {
    let current = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    private(set) var checking = false
    private(set) var checked = false
    private(set) var offer: ClientUpdateOffer?
    private(set) var error: String?
    private var nextCheck = Date.distantPast

    func checkIfDue(_ client: CoreClient) async -> ClientUpdateOffer? {
        guard Date() >= nextCheck else { return nil }
        return await check(client)
    }

    @discardableResult
    func check(_ client: CoreClient) async -> ClientUpdateOffer? {
        guard !checking else { return nil }
        checking = true
        error = nil
        defer { checking = false }
        do {
            let latest = try await client.clientUpdate(platform: "ios", current: current)
            guard !Task.isCancelled else { return nil }
            offer = latest
            checked = true
            nextCheck = Date().addingTimeInterval(6 * 60 * 60)
            return latest
        } catch {
            if !Task.isCancelled { self.error = coreMessage(error) }
            return nil
        }
    }
}

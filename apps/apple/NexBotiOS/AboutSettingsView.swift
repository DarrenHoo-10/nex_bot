import Observation
import SwiftUI
import NexClientKit

struct AboutSettingsView: View {
    let workspace: WorkspaceStore
    @Environment(\.openURL) private var openURL
    @Environment(IOSAppUpdater.self) private var updater

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 14) {
                    BrandMark(size: 42)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Text("NexBot").font(.headline)
                            Text(updater.current.isEmpty ? "—" : "v\(updater.current)")
                                .font(.caption.monospaced().weight(.medium))
                                .foregroundStyle(Theme.brandInk)
                                .padding(.horizontal, 8).padding(.vertical, 2)
                                .background(Theme.brandSoft, in: Capsule())
                        }
                        Text("iOS 原生客户端").font(.footnote).foregroundStyle(Theme.muted)
                    }
                    Spacer()
                }
                Divider().overlay(Theme.border)
                if updater.checking {
                    HStack(spacing: 8) { ProgressView(); Text("正在检查更新…").foregroundStyle(Theme.muted) }
                } else if let error = updater.error {
                    Text("检查更新失败：\(error)").foregroundStyle(Theme.danger)
                } else if let offer = updater.offer {
                    Label("新版本 \(offer.version) 可用", systemImage: "arrow.down.circle.fill").foregroundStyle(Theme.brand)
                } else if updater.checked {
                    Text("已是最新版").foregroundStyle(Theme.muted)
                }
                HStack(spacing: 10) {
                    Button("检查更新") { Task { await updater.check(workspace.client) } }
                        .buttonStyle(PillButtonStyle()).disabled(updater.checking)
                    if let offer = updater.offer, !updater.checking {
                        Button("下载更新") { openURL(offer.url) }.buttonStyle(PillButtonStyle(primary: true, brand: true))
                    }
                }
            }
            .padding(16)
            .cardStyle(radius: 16)
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

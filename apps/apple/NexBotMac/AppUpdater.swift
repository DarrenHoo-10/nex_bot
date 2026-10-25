import SwiftUI
import AppKit
import NexClientKit

/// Checks Core for a newer Mac build after sign-in and every six hours, downloads the DMG in the background
/// and offers it only once its size and SHA-256 match. Installing mounts the DMG, checks the app inside is
/// NexBot at the offered version, quits, and a detached script swaps the bundle and relaunches it.
@MainActor @Observable
final class AppUpdater {
    static let shared = AppUpdater()
    enum Status: Equatable { case idle, checking, current, downloading(String), ready(String), failed(String) }
    private(set) var status = Status.idle
    private(set) var installing = false
    @ObservationIgnored private var file: URL?
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var checking = false
    let current = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""

    func start(client: @escaping @MainActor () -> CoreClient) {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.check(client())
                try? await Task.sleep(for: .seconds(6 * 60 * 60))
            }
        }
    }
    func stop() { loop?.cancel(); loop = nil }

    func check(_ client: CoreClient) async {
        guard !checking, !installing else { return }
        if case .ready = status { return }
        checking = true
        status = .checking
        defer { checking = false }
        do {
            guard let offer = try await client.clientUpdate(platform: "mac", current: current) else { status = .current; return }
            status = .downloading(offer.version)
            let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("NexBotUpdates", isDirectory: true)
            let name = "NexBot-\(offer.version).dmg"
            for old in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] where old.lastPathComponent != name {
                try? FileManager.default.removeItem(at: old)
            }
            file = try await client.downloadUpdate(offer, to: dir.appendingPathComponent(name))
            status = .ready(offer.version)
        } catch {
            if Task.isCancelled { status = .idle; return }
            status = .failed((error as? CoreError)?.message ?? "检查更新失败")
        }
    }

    func install() async throws {
        guard case .ready(let version) = status, let file, !installing else { return }
        installing = true
        defer { installing = false }
        let target = Bundle.main.bundleURL, bundleID = Bundle.main.bundleIdentifier ?? ""
        let script = try await Task.detached { try Self.prepare(dmg: file, version: version, bundleID: bundleID, target: target) }.value
        let helper = Process()
        helper.executableURL = URL(fileURLWithPath: "/bin/sh")
        helper.arguments = [script.path, String(ProcessInfo.processInfo.processIdentifier)]
        try helper.run()
        NSApp.terminate(nil)
    }

    /// Mounts the DMG, checks the app inside, and writes the swap script. Returns the script.
    nonisolated private static func prepare(dmg: URL, version: String, bundleID: String, target: URL) throws -> URL {
        let work = FileManager.default.temporaryDirectory.appendingPathComponent("NexBotUpdate-\(UUID().uuidString)", isDirectory: true)
        let mount = work.appendingPathComponent("mount", isDirectory: true)
        try FileManager.default.createDirectory(at: mount, withIntermediateDirectories: true)
        try run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount.path, dmg.path])
        let app = mount.appendingPathComponent("NexBot.app")
        let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
        guard info?["CFBundleIdentifier"] as? String == bundleID, info?["CFBundleShortVersionString"] as? String == version,
              (try? run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])) != nil else {
            try? run("/usr/bin/hdiutil", ["detach", "-quiet", mount.path])
            throw CoreError(kind: .http, message: "更新文件不是有效的 NexBot", status: 0)
        }
        let staged = target.deletingLastPathComponent().appendingPathComponent(".NexBot-update-\(version).app")
        // Waits for this process, copies the new app beside the old one, swaps them, and relaunches.
        // If the copy fails the old app is relaunched unchanged.
        let script = work.appendingPathComponent("swap.sh")
        let body = """
        while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
        rm -rf \(quote(staged.path))
        if /usr/bin/ditto \(quote(app.path)) \(quote(staged.path)); then
          rm -rf \(quote(target.path)) && mv \(quote(staged.path)) \(quote(target.path))
        fi
        /usr/bin/hdiutil detach -quiet \(quote(mount.path))
        /usr/bin/open \(quote(target.path))
        rm -rf \(quote(work.path))
        """
        try body.write(to: script, atomically: true, encoding: .utf8)
        return script
    }

    nonisolated private static func quote(_ path: String) -> String { "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    @discardableResult
    nonisolated private static func run(_ tool: String, _ arguments: [String]) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        try process.run(); process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw CoreError(kind: .http, message: "安装更新失败", status: 0) }
        return process.terminationStatus
    }
}

/// "新版本 x 已就绪 [立即更新]" above the conversation once a verified update is downloaded.
struct UpdateBanner: View {
    @State private var updater = AppUpdater.shared
    @State private var error: String?

    var body: some View {
        if case .ready(let version) = updater.status {
            HStack(spacing: 10) {
                Text("新版本 \(version) 已就绪").font(.system(size: 12)).foregroundStyle(Theme.foreground)
                if let error { Text(error).font(.system(size: 12)).foregroundStyle(Theme.danger) }
                Spacer()
                Button(updater.installing ? "正在更新…" : "立即更新") {
                    error = nil
                    Task { do { try await updater.install() } catch { self.error = (error as? CoreError)?.message ?? "安装更新失败" } }
                }
                .disabled(updater.installing)
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(Theme.card)
            .overlay(alignment: .bottom) { Hairline(vertical: false) }
        }
    }
}

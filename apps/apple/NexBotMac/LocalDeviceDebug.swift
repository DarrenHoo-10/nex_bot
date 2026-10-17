#if DEBUG
import Foundation
import AppKit
import NexClientKit

/// DEBUG-only automation for the device executor: lines appended to `$NEXBOT_DEBUG_COMMAND_FILE.d` are consumed, and
/// results are appended to `$NEXBOT_DEBUG_COMMAND_FILE.d.log`.
/// Commands: `devicepause on|off`, `devicestate` (logs the public state), `devicekill` (kills the host process, which must
/// restart), `devicequit` (the normal Cmd-Q path), `devicelogout` (revokes then calls `AppModel.logout()`, like the logout dialog).
@MainActor enum LocalDeviceDebug {
    private static var started = false
    static func start(device: LocalDeviceController, model: AppModel) {
        guard !started, let base = ProcessInfo.processInfo.environment["NEXBOT_DEBUG_COMMAND_FILE"] else { return }
        started = true
        let path = base + ".d"
        func log(_ text: String) {
            let data = Data((text + "\n").utf8)
            if let handle = FileHandle(forWritingAtPath: path + ".log") { handle.seekToEndOfFile(); handle.write(data); try? handle.close() }
            else { try? data.write(to: URL(fileURLWithPath: path + ".log")) }
        }
        Task { @MainActor in
            while true {
                try? await Task.sleep(for: .milliseconds(300))
                guard let text = try? String(contentsOfFile: path, encoding: .utf8), !text.isEmpty else { continue }
                try? "".write(toFile: path, atomically: true, encoding: .utf8)
                for line in text.split(separator: "\n") {
                    let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
                    do {
                        switch parts.first {
                        case "devicepause": try await device.setPaused(parts.last == "on"); log("paused=\(device.state.paused) connected=\(device.state.connected)")
                        case "devicestate":
                            let s = device.state
                            log("state available=\(s.available) connected=\(s.connected) paused=\(s.paused) device=\(s.deviceID) status=\(s.status)")
                        case "devicekill": device.debugKillHost(); log("killed host")
                        case "devicequit": RunLoop.main.perform { MainActor.assumeIsolated { NSApp.terminate(nil) } } // from the run loop (not a main-actor job or queue block), as a real Cmd-Q is
                        case "devicelogout": await device.stop(revoke: true); await model.logout(); log("logged out")
                        default: break
                        }
                    } catch { log("ERR \(line): \(message(of: error))") }
                }
            }
        }
    }
}
#endif

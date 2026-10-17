import Foundation
import Observation
import NexClientKit

/// Public state of this Mac's device executor, mirroring `ClientDevice.state()` in
/// `electron/nex-client-device.mjs` (the web reads it as `LocalDeviceState`).
struct LocalDeviceState: Equatable, Sendable {
    /// False when the app has no bundled executor or nobody is signed in.
    var available = false
    var name = ""
    var status = ""
    var connected = false
    var authorized = false
    var paused = false
    var deviceID = ""
    var unknownCalls: [UnknownCall] = []
}

/// Owns the bundled Node executor for the signed-in session. Login starts it, logout stops it and revokes
/// the device, quitting only stops it. Credentials never leave this object; views read `state` and call
/// `setPaused` / `reconcile`.
@MainActor @Observable
final class LocalDeviceController {
    private(set) var state = LocalDeviceState()

    /// Starts (or restarts) the executor for a signed-in session.
    func start(credential: StoredCredential) async {}
    /// Stops the executor. `revoke` also revokes this device on Core (explicit logout).
    func stop(revoke: Bool) async {}
    /// Pause stops immediately, including a running command; resume reconnects. Returns Core/executor errors.
    func setPaused(_ paused: Bool) async throws {}
    /// Clears an interrupted call after the user confirmed it stopped; never replays it.
    func reconcile(_ call: UnknownCall) async throws {}
}

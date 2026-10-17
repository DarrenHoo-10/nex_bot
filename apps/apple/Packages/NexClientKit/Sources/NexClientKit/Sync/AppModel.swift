import Foundation
import Observation
#if canImport(UIKit)
import UIKit
#endif

/// Root observable for both apps: login state machine plus the connected ``WorkspaceStore``.
@MainActor @Observable
public final class AppModel {
    public enum Phase: Equatable, Sendable {
        case launching
        /// Resuming a saved login; offer cancel / switch account.
        case resuming
        case loggedOut(error: String?)
        case connected
    }

    public private(set) var phase: Phase = .launching
    /// Present exactly while ``phase`` is `.connected`.
    public private(set) var workspace: WorkspaceStore?
    /// The record of the current login (origin, device name, session id, expiry).
    public private(set) var credential: StoredCredential?
    public private(set) var isLoggingIn = false
    /// A saved login exists (a failed resume can be retried with ``retryResume()``).
    public private(set) var hasSavedLogin = false
    /// Login form fields; pre-filled from the saved login, `--origin=` or the default.
    public var origin: String = CoreOrigin.defaultString
    public var deviceName: String
    public let options: LaunchOptions
    public var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0" }

    @ObservationIgnored private let service: LoginService
    @ObservationIgnored private var attempt: Task<Void, Never>?
    @ObservationIgnored private let launchError: String?
    @ObservationIgnored private let timing: SyncTiming

    /// - Parameters:
    ///   - options: profile and origin override; defaults to the process arguments and environment.
    ///   - store: credential storage; defaults to the Keychain for the profile.
    ///   - session: URLSession override for tests.
    public init(options: LaunchOptions, store: CredentialStore? = nil, session: URLSession? = nil,
                deviceName: String, timing: SyncTiming = SyncTiming()) {
        self.options = options; self.deviceName = deviceName; self.timing = timing
        var override: CoreOrigin?, problem: String?
        do { override = try options.originOverride() } catch let e { problem = (e as? CoreError)?.message ?? "\(e)" }
        launchError = problem
        service = LoginService(store: store ?? KeychainCredentialStore(profile: options.profile), session: session ?? CoreClient.makeSession(), overrideOrigin: override)
    }

    /// Production setup: process arguments/environment, Keychain store, hostname as device name.
    public convenience init() { self.init(options: LaunchOptions.current, deviceName: AppModel.defaultDeviceName()) }

    /// The device name offered on first login.
    public static func defaultDeviceName() -> String {
        #if canImport(UIKit)
        UIDevice.current.name
        #else
        Host.current().localizedName ?? ProcessInfo.processInfo.hostName
        #endif
    }

    /// Loads the saved login and resumes it. Call once at launch.
    public func start() async {
        guard phase == .launching else { return }
        let defaults = await service.bootstrap(deviceName: deviceName)
        origin = defaults.origin; deviceName = defaults.name; hasSavedLogin = defaults.hasSavedLogin
        if defaults.hasSavedLogin { await retryResume() } else { phase = .loggedOut(error: launchError) }
    }

    /// Resumes the saved login (also the retry after a network failure).
    public func retryResume() async {
        phase = .resuming
        let task = Task {
            do {
                let connection = try await service.resume()
                if Task.isCancelled { return }
                connect(connection)
            } catch {
                let e = CoreError.wrap(error)
                if e.isCancellation || Task.isCancelled { return }
                hasSavedLogin = await service.hasSavedLogin
                phase = .loggedOut(error: e.message)
            }
        }
        attempt = task
        await task.value
    }

    /// Cancels a running resume and shows the login form, keeping the saved login.
    public func cancelResume() {
        attempt?.cancel(); attempt = nil
        if phase == .resuming { phase = .loggedOut(error: nil) }
    }

    /// 改用其他账号登录: cancels any resume and deletes the saved login.
    public func switchAccount() async {
        cancelResume()
        await service.forget()
        hasSavedLogin = false
        phase = .loggedOut(error: nil)
    }

    /// Password login with the form fields. The caller should clear its password field afterwards.
    public func login(account: String, password: String) async {
        guard !isLoggingIn else { return }
        isLoggingIn = true; defer { isLoggingIn = false }
        let name = deviceName.trimmingCharacters(in: .whitespaces)
        let task = Task {
            do {
                let connection = try await service.login(origin: origin.trimmingCharacters(in: .whitespaces), name: name.isEmpty ? "我的设备" : name, account: account.trimmingCharacters(in: .whitespaces), password: password)
                if !Task.isCancelled { connect(connection) }
            } catch {
                let e = CoreError.wrap(error)
                if !e.isCancellation { phase = .loggedOut(error: e.message) }
            }
        }
        attempt = task
        await task.value
    }

    /// Signs out: tells Core (best effort), deletes the credential, drops all cached content.
    public func logout() async {
        workspace?.stop(); workspace = nil; credential = nil
        await service.logout()
        hasSavedLogin = false
        phase = .loggedOut(error: nil)
    }

    /// iOS: pass `scenePhase == .active`. Backgrounding closes the stream; returning does a full refresh.
    public func setForeground(_ active: Bool) {
        if active { workspace?.start() } else { workspace?.stop() }
    }

    private func connect(_ connection: Connection) {
        let store = WorkspaceStore(client: connection.client, timing: timing)
        store.onSessionEnded = { [weak self] end in self?.sessionEnded(end) }
        workspace = store; credential = connection.credential; hasSavedLogin = true
        phase = .connected
        store.start()
    }

    private func sessionEnded(_ end: SessionEnd) {
        workspace?.stop(); workspace = nil; credential = nil
        if end.deleteCredential { hasSavedLogin = false; Task { await service.forget() } }
        phase = .loggedOut(error: end.message)
    }
}

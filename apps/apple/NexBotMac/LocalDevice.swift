import Foundation
import Observation
import Security
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

    /// Builds the state from the host's `ClientDevice.state()` JSON.
    init(json: JSONValue? = nil) {
        guard let row = json?.objectValue else { return }
        available = row.bool("available") ?? true
        name = row.string("name") ?? ""
        status = row.string("status") ?? ""
        connected = row.bool("connected") ?? false
        authorized = row.bool("authorized") ?? false
        paused = row.bool("paused") ?? false
        deviceID = row.string("deviceId") ?? ""
        unknownCalls = row["unknownCalls"]?.arrayValue?.compactMap(\.objectValue).map(UnknownCall.init) ?? []
    }
}

/// Owns the bundled Node executor for the signed-in session. Login starts it, logout stops it and revokes
/// the device, quitting only stops it. Credentials never leave this object; views read `state` and call
/// `setPaused` / `reconcile`.
///
/// The executor is `Contents/Resources/Executor/node executor-host.mjs <dataDir>` (see `Executor/executor-host.mjs`
/// for the newline-delimited JSON protocol). It is the same `ClientDevice` lifecycle and `DeviceNode` as the
/// Electron client. The 32-byte key that encrypts its binding, consent and database lives in the Keychain and is
/// handed over once on the pipe; it never appears in argv or the environment.
@MainActor @Observable
final class LocalDeviceController {
    static let shared = LocalDeviceController()

    private(set) var state = LocalDeviceState()

    @ObservationIgnored private var session: StoredCredential?
    @ObservationIgnored private var host: ExecutorHost?
    @ObservationIgnored private var pending: [Int: CheckedContinuation<LocalDeviceState, Error>] = [:]
    @ObservationIgnored private var timers: [Int: Task<Void, Never>] = [:]
    @ObservationIgnored private var nextID = 0
    @ObservationIgnored private var restartTask: Task<Void, Never>?
    @ObservationIgnored private var backoff = 1.0
    @ObservationIgnored private var revokeTask: Task<Void, Never>?
    @ObservationIgnored private var attached: Task<Void, Never>?
    @ObservationIgnored private let profile: String

    init() {
        profile = LaunchOptions.current.profile ?? "default"
        signal(SIGPIPE, SIG_IGN) // a dead host must surface as a write error, not kill the app
    }

    /// True while a host process exists (the quit handler waits for it).
    var isRunning: Bool { host?.isRunning == true }

    // MARK: Public interface

    /// Starts (or restarts) the executor for a signed-in session.
    func start(credential: StoredCredential) async {
        restartTask?.cancel(); restartTask = nil; revokeTask = nil
        session = credential
        guard bundle != nil else { state = LocalDeviceState(); return }
        state = LocalDeviceState()
        state.available = true; state.name = credential.name; state.status = "正在连接此电脑"
        await connect()
    }

    /// Stops the executor. `revoke` also revokes this device on Core (explicit logout).
    func stop(revoke: Bool) async {
        let ended = session
        session = nil
        restartTask?.cancel(); restartTask = nil
        if revoke, let ended { beginRevoke(session: ended) }
        let revocation = revokeTask
        if let host, host.isRunning {
            // Also asks the host to revoke, which covers a registration still in flight; the revoke is idempotent.
            _ = try? await call(["op": "stop", "revoke": revoke], timeout: 20)
            host.closeInput()
            await host.waitForExit(seconds: 3)
            host.terminate()
        }
        await revocation?.value
        revokeTask = nil
        failPending("执行器已停止")
        host = nil
        state = LocalDeviceState()
    }

    /// Pause stops immediately, including a running command; resume reconnects. Returns Core/executor errors.
    func setPaused(_ paused: Bool) async throws {
        guard session != nil else { throw CoreError(kind: .unsupported, message: "请等待此电脑完成登录") }
        apply(try await call(["op": "pause", "paused": paused], timeout: 60))
    }

    /// Clears an interrupted call after the user confirmed it stopped; never replays it.
    func reconcile(_ call: UnknownCall) async throws {
        guard session != nil else { throw CoreError(kind: .unsupported, message: "此电脑未连接") }
        apply(try await self.call(["op": "reconcile", "callId": call.callID, "version": call.version], timeout: 30))
    }

    /// Stops the host for app quit without revoking, waiting briefly so no orphan `node` is left.
    func shutdown() async {
        // stop() already escalates to SIGTERM/SIGKILL; this cap only covers a stuck request.
        let watchdog = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(6))
            if !Task.isCancelled { self?.host?.terminate() }
        }
        await stop(revoke: false)
        watchdog.cancel()
        host?.terminate()
    }

    #if DEBUG
    func debugKillHost() { if let pid = host?.processID { kill(pid, SIGKILL) } }
    #endif

    // MARK: Following the app model

    /// Starts following the login: connected starts the executor; any logout or ended session stops it. Revoking on an
    /// explicit logout is the caller's job (`stop(revoke: true)` before `AppModel.logout()`), never inferred here. Idempotent; the task lives as long as the controller (not a window).
    func attach(_ model: AppModel) {
        guard attached == nil else { return }
        attached = Task { @MainActor [weak self] in
            let (stream, wake) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
            @MainActor func arm() {
                withObservationTracking {
                    _ = model.credential; _ = model.phase; _ = model.workspace
                } onChange: {
                    wake.yield()
                }
            }
            arm(); wake.yield()
            for await _ in stream {
                arm()
                await self?.follow(model)
            }
        }
    }

    private func follow(_ model: AppModel) async {
        if model.phase == .connected, let credential = model.credential {
            guard session?.sessionId != credential.sessionId || session?.token != credential.token else { return }
            await start(credential: credential)
        } else if session != nil {
            await stop(revoke: false)
        }
    }

    // MARK: Revoke

    /// Sends `POST /api/devices/revoke` for this Mac's device with the session token. Starts the request before
    /// returning. Failure (session already revoked) is harmless: the device then shows as bound until revoked elsewhere.
    private func beginRevoke(session ended: StoredCredential) {
        guard revokeTask == nil, !state.deviceID.isEmpty, let url = URL(string: ended.origin + "/api/devices/revoke") else { return }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(ended.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["id": state.deviceID])
        let task = Self.revokeSession.dataTask(with: request)
        task.resume()
        revokeTask = Task { @MainActor in
            while task.state == .running || task.state == .suspended { try? await Task.sleep(for: .milliseconds(25)) }
        }
    }

    private static let revokeSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        return URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }()

    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    }

    // MARK: Host process

    private struct Bundle_ { let node: URL; let script: URL; let directory: URL }
    private var bundle: Bundle_? {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("Executor") else { return nil }
        let node = root.appendingPathComponent("node"), script = root.appendingPathComponent("executor-host.mjs")
        let fm = FileManager.default
        guard fm.isExecutableFile(atPath: node.path), fm.fileExists(atPath: script.path) else { return nil }
        return Bundle_(node: node, script: script, directory: root)
    }

    /// `~/Library/Application Support/NexBot/<profile>/devices`, mode 0700.
    private func dataDirectory() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let account = base.appendingPathComponent("NexBot").appendingPathComponent(profile)
        let devices = account.appendingPathComponent("devices")
        for url in [account.deletingLastPathComponent(), account, devices] {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        }
        return devices
    }

    private func keychainError(_ status: OSStatus) -> CoreError { CoreError(kind: .unsupported, message: "钥匙串错误 (\(status))") }

    private func masterKey() throws -> Data {
        let account = "executor-key:" + profile
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: KeychainCredentialStore.service, kSecAttrAccount as String: account]
        var read = query; read[kSecReturnData as String] = true; read[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data, data.count == 32 { return data }
        guard status == errSecItemNotFound || status == errSecSuccess else { throw keychainError(status) }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, 32, &bytes) == errSecSuccess else { throw keychainError(errSecAllocate) }
        let key = Data(bytes)
        SecItemDelete(query as CFDictionary)
        var add = query; add[kSecValueData as String] = key; add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw keychainError(added) }
        return key
    }

    private func launchHost() throws {
        if let host, host.isRunning { return }
        guard let bundle else { throw CoreError(kind: .unsupported, message: "此版本未包含本机执行器") }
        let key = try masterKey(), directory = try dataDirectory()
        let source = ProcessInfo.processInfo.environment
        let environment = ["PATH", "HOME", "TMPDIR"].reduce(into: [String: String]()) { if let v = source[$1] { $0[$1] = v } }
        let next = try ExecutorHost(node: bundle.node, script: bundle.script, directory: bundle.directory, data: directory, environment: environment,
                                    onLine: { [weak self] line in self?.receive(line) },
                                    onExit: { [weak self] host, code in self?.hostExited(host, code: code) })
        host = next
        try next.send(["op": "init", "key": key.base64EncodedString()])
    }

    private func connect() async {
        guard let credential = session else { return }
        do {
            try launchHost()
            let reply = try await call([
                "op": "start",
                "session": ["origin": credential.origin, "name": credential.name, "token": credential.token, "coreId": credential.coreId,
                            "sessionId": credential.sessionId, "expiresAt": credential.expiresAt] as [String: Any],
            ], timeout: 90)
            guard session?.sessionId == credential.sessionId else { return }
            apply(reply); backoff = 1
        } catch {
            guard session?.sessionId == credential.sessionId else { return }
            state.connected = false
            state.status = "此电脑连接失败，正在重试：" + CoreError.wrap(error).message
            scheduleRestart()
        }
    }

    private func scheduleRestart() {
        guard restartTask == nil, session != nil else { return }
        let delay = backoff
        backoff = min(backoff * 2, 30)
        restartTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.restartTask = nil
            await self.connect()
        }
    }

    private func hostExited(_ exited: ExecutorHost, code: Int32) {
        guard host === exited else { return }
        host = nil
        failPending("执行器已退出（\(code)）")
        guard session != nil else { return }
        state.connected = false; state.status = "本机执行器已退出，正在重启"
        scheduleRestart()
    }

    // MARK: Requests

    private func call(_ body: [String: Any], timeout: TimeInterval) async throws -> LocalDeviceState {
        guard let host, host.isRunning else { throw CoreError(kind: .unsupported, message: "本机执行器未运行") }
        nextID += 1
        let id = nextID
        var payload = body; payload["id"] = id
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            timers[id] = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                guard !Task.isCancelled, let self, let waiting = self.pending.removeValue(forKey: id) else { return }
                self.timers[id] = nil
                waiting.resume(throwing: CoreError(kind: .network, message: "本机执行器没有响应"))
                host.terminate() // restarts through hostExited while signed in
            }
            do { try host.send(payload) }
            catch {
                timers.removeValue(forKey: id)?.cancel()
                pending.removeValue(forKey: id)?.resume(throwing: CoreError(kind: .network, message: "无法联系本机执行器"))
            }
        }
    }

    private func failPending(_ message: String) {
        let waiting = pending; pending = [:]
        timers.values.forEach { $0.cancel() }; timers = [:]
        for (_, continuation) in waiting { continuation.resume(throwing: CoreError(kind: .network, message: message)) }
    }

    private func receive(_ line: String) {
        guard let data = line.data(using: .utf8), let message = try? JSONDecoder().decode(JSONValue.self, from: data) else { return }
        if message["event"]?.stringValue == "state" {
            if session != nil { apply(message["state"]) }
            return
        }
        guard let id = message["id"]?.intValue, let continuation = pending.removeValue(forKey: id) else { return }
        timers.removeValue(forKey: id)?.cancel()
        if message["ok"]?.boolValue == true { continuation.resume(returning: LocalDeviceState(json: message["state"])) }
        else { continuation.resume(throwing: CoreError(kind: .unsupported, message: message["error"]?.stringValue ?? "本机执行器出错")) }
    }

    private func apply(_ json: JSONValue?) { apply(LocalDeviceState(json: json)) }
    private func apply(_ next: LocalDeviceState) {
        guard session != nil else { return }
        var value = next
        value.available = true
        if value.name.isEmpty { value.name = session?.name ?? "" }
        if value != state { state = value }
    }
}

/// One `node executor-host.mjs` child with line-framed stdin/stdout. Callbacks arrive on the main thread.
private final class ExecutorHost: @unchecked Sendable {
    private let process = Process()
    private let input = Pipe(), output = Pipe()
    private let lock = NSLock()
    private var closed = false
    private var exited = false

    var isRunning: Bool { lock.withLock { !exited } && process.isRunning }

    @MainActor
    init(node: URL, script: URL, directory: URL, data: URL, environment: [String: String],
         onLine: @escaping @MainActor (String) -> Void, onExit: @escaping @MainActor (ExecutorHost, Int32) -> Void) throws {
        process.executableURL = node
        process.arguments = [script.path, data.path]
        process.currentDirectoryURL = directory
        process.environment = environment
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.standardError
        let buffer = LineBuffer()
        output.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil; return }
            for line in buffer.lines(appending: chunk) {
                DispatchQueue.main.async { MainActor.assumeIsolated { onLine(line) } }
            }
        }
        process.terminationHandler = { [unowned self] finished in
            lock.withLock { exited = true }
            output.fileHandleForReading.readabilityHandler = nil
            let code = finished.terminationStatus
            DispatchQueue.main.async { MainActor.assumeIsolated { onExit(self, code) } }
        }
        try process.run()
    }

    func send(_ value: [String: Any]) throws {
        var data = try JSONSerialization.data(withJSONObject: value)
        data.append(0x0A)
        try lock.withLock {
            guard !closed, !exited else { throw CocoaError(.fileWriteUnknown) }
            try input.fileHandleForWriting.write(contentsOf: data)
        }
    }

    /// EOF on stdin makes the host stop its device (without revoking) and exit.
    func closeInput() {
        lock.withLock { if !closed { closed = true; try? input.fileHandleForWriting.close() } }
    }

    var processID: Int32? { process.isRunning ? process.processIdentifier : nil }

    func waitForExit(seconds: Double) async {
        let deadline = Date().addingTimeInterval(seconds)
        while isRunning, Date() < deadline { try? await Task.sleep(for: .milliseconds(50)) }
    }

    func terminate() {
        if process.isRunning { process.terminate() }
        if process.isRunning { Task.detached { [process] in try? await Task.sleep(for: .seconds(2)); if process.isRunning { kill(process.processIdentifier, SIGKILL) } } }
    }
}

/// Accumulates pipe chunks into complete lines. Only the pipe's readability handler touches it.
private final class LineBuffer: @unchecked Sendable {
    private var data = Data()
    func lines(appending chunk: Data) -> [String] {
        data.append(chunk)
        var result: [String] = []
        while let newline = data.firstIndex(of: 0x0A) {
            result.append(String(decoding: data[data.startIndex..<newline], as: UTF8.self))
            data.removeSubrange(data.startIndex...newline)
        }
        return result
    }
}

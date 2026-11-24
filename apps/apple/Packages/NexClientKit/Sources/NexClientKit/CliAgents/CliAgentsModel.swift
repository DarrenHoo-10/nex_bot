import Foundation
import Observation

/// Shows a local notification. The app supplies the implementation.
public protocol CliNotifying: AnyObject {
    @MainActor func notify(title: String, body: String, key: CliSessionKey)
}

/// What the Agent section shows: computers, sessions, transcripts, pending requests and the live link. One HTTP snapshot, then
/// the WebSocket keeps it current.
@MainActor @Observable
public final class CliAgentsModel {
    public struct Transcript: Sendable, Equatable {
        public var items: [CliItem] = []
        public var more = false
        public var loaded = false
        public var loadingOlder = false
        public var translationEnabled = false
        public var error: String?
        public init() {}
    }

    public static let selectedKeyDefault = "nexbot.cliSelected"
    public static let notifyDefault = "nexbot.cliNotify"

    public private(set) var devices: [CliDevice] = []
    public private(set) var sessions: [CliSession] = []
    public private(set) var requests = CliRequestStore()
    public private(set) var transcripts: [CliSessionKey: Transcript] = [:]
    @ObservationIgnored private var closedTranscripts: [CliSessionKey: Date] = [:]
    public private(set) var supervision: CliSupervision?
    /// New sessions being started, newest first.
    public private(set) var launches: [CliLaunch] = []
    /// The first message of a session started here, until its transcript holds it.
    public private(set) var echoes: [CliSessionKey: String] = [:]
    public private(set) var link: CliAgentStream.Status = .idle
    /// A first list has arrived.
    public private(set) var loaded = false
    public private(set) var loadError: String?
    /// Epoch milliseconds, refreshed on every change and when a card expires.
    public private(set) var now: Int = CliAgentsModel.currentMs()

    public var showHidden = false
    public private(set) var selectedKey: CliSessionKey?
    public private(set) var notificationsOn: Bool
    public var notifier: (any CliNotifying)?
    /// True while the app is in front; notifications are only for when it is not.
    public var isForeground: @MainActor () -> Bool = { true }

    @ObservationIgnored private let clientProvider: @MainActor () -> CoreClient
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored public private(set) var stream: CliAgentStream?
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var expiryTask: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var started = false
    @ObservationIgnored private var previousStates: [CliSessionKey: CliSessionState]?
    @ObservationIgnored private var previousRequestIds: Set<String>?
    @ObservationIgnored private var subscribed: [CliSessionKey: Int] = [:]
    private struct StoredTail: Codable, Sendable {
        var marks: [String]
        var items: [CliItem]
        var translationEnabled: Bool?

        var persistable: StoredTail {
            let saved = zip(marks, items).filter { $0.1.kind != .tool && $0.1.kind != .thinking }
            return StoredTail(marks: saved.map { $0.0 }, items: saved.map { $0.1 }, translationEnabled: translationEnabled)
        }
    }
    @ObservationIgnored private var cachedTails: [CliSessionKey: StoredTail] = [:]
    @ObservationIgnored private var openGeneration: [CliSessionKey: UUID] = [:]
    @ObservationIgnored private let cacheScope: @MainActor () -> String?
    @ObservationIgnored private var awaitingCacheAuthorization = false
    @ObservationIgnored private var terminal: CliTerminalController?
    @ObservationIgnored private let streamFactory: (@MainActor (CliAgentsModel) -> CliAgentStream)?
    @ObservationIgnored private var launchTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var catalogs: [String: (at: Int, catalog: CliModelCatalog)] = [:]
    /// How long a send waits between tries while a just-started session is not listed yet.
    @ObservationIgnored var launchRetryNanos: UInt64 = 500_000_000

    public init(client: @escaping @MainActor () -> CoreClient, defaults: UserDefaults = .standard,
                streamFactory: (@MainActor (CliAgentsModel) -> CliAgentStream)? = nil,
                cacheScope: @escaping @MainActor () -> String? = { nil }) {
        clientProvider = client; self.defaults = defaults; self.streamFactory = streamFactory; self.cacheScope = cacheScope
        selectedKey = defaults.string(forKey: Self.selectedKeyDefault)
        notificationsOn = defaults.string(forKey: Self.notifyDefault) == "1"
    }

    nonisolated static func currentMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

    // MARK: Derived

    /// Sessions as shown: one that holds a pending request reads as waiting. Sessions being started come first; a started
    /// one keeps its placeholder until its first message is out.
    public var displaySessions: [CliSession] {
        let counts = pendingCounts
        let starting = Set(launches.compactMap(\.target))
        return launches.map(CliLaunches.row) + sessions.filter { !starting.contains($0.key) }.map { CliSessions.asked($0, pending: counts[$0.key] ?? 0) }
    }

    /// The launch the selection points at, while it is being started.
    public var selectedLaunch: CliLaunch? { launches.first { $0.key == selectedKey } }

    public var pendingCounts: [CliSessionKey: Int] { requests.counts(now: now) }
    public var groups: [CliDeviceGroup] { CliSessions.group(devices: devices, sessions: displaySessions, showHidden: showHidden) }
    public var hiddenCount: Int { CliSessions.hiddenCount(sessions) }
    public var waitingCount: Int { CliSessions.waitingCount(sessions, asked: Set(pendingCounts.keys)) }
    public var selected: CliSession? { selectedKey.flatMap { key in displaySessions.first { $0.key == key } } }
    public func device(_ id: String) -> CliDevice? { devices.first { $0.id == id } }
    /// The cards of a session: open ones and the ones closed lately, oldest first.
    public func cards(_ key: CliSessionKey) -> [CliRequestRecord] { requests.records[key] ?? [] }
    public func cardState(_ record: CliRequestRecord) -> CliCardState { CliRequestStore.state(of: record, now: now) }
    public func transcript(_ key: CliSessionKey) -> Transcript { transcripts[key] ?? Transcript() }
    public var connected: Bool { link == .open }

    // MARK: Lifecycle

    /// Starts the live link and loads the first snapshot. Safe to call again.
    public func start() {
        guard !started else { return }
        started = true
        let stream = streamFactory?(self) ?? CliAgentStream(requestProvider: { [weak self] in await self?.streamRequest() })
        self.stream = stream
        eventTask = Task { [weak self] in
            for await event in stream.events { self?.handle(event) }
        }
        Task {
            await stream.start()
            await stream.subscribeList()
            for key in subscribed.keys { await stream.subscribeSession(key) }
        }
        Task { await refresh() }
    }

    public func stop() {
        guard started else { return }
        started = false
        eventTask?.cancel(); eventTask = nil
        expiryTask?.cancel(); expiryTask = nil
        let stream = stream
        self.stream = nil
        closedTranscripts.removeAll()
        transcripts.removeAll()
        Task { await stream?.stop() }
        link = .idle
    }

    /// The token changed or the app came back: connect again now.
    public func reconnect() {
        guard let stream else { start(); return }
        Task {
            if case .closed = await stream.currentStatus() { await stream.stop(); await stream.start() } else { await stream.reconnectNow() }
        }
    }

    private func streamRequest() -> URLRequest? { clientProvider().cliStreamRequest() }

    /// Loads the snapshot over HTTP. Ignored if a pushed list arrived while it was on its way.
    public func refresh() async {
        let mine = generation
        do {
            let snapshot = try await clientProvider().cliSnapshot()
            guard mine == generation else { return }
            touch()
            devices = snapshot.devices; sessions = snapshot.sessions
            requests.mergePending(snapshot.requests)
            loaded = true; loadError = nil
            settleLaunches()
            evaluateNotifications()
            scheduleExpiry()
        } catch {
            guard mine == generation, !loaded else { return }
            loadError = CliErrorText.text(for: error, fallback: "读取失败")
        }
    }

    // MARK: Selection and subscriptions

    public func select(_ key: CliSessionKey?) {
        selectedKey = key
        // a session still starting has no key that outlives the app
        if CliLaunches.isLaunchKey(key) { return }
        if let key { defaults.set(key, forKey: Self.selectedKeyDefault) } else { defaults.removeObject(forKey: Self.selectedKeyDefault) }
    }

    /// The session view appeared: follow its transcript and requests.
    public func invalidateCachedTranscripts(waitForScope: Bool) {
        awaitingCacheAuthorization = waitForScope
        cachedTails.removeAll()
        openGeneration.removeAll()
        transcripts.removeAll()
        for key in subscribed.keys {
            Task {
                await stream?.updateSessionKnown(key, known: [])
                if !waitForScope, !awaitingCacheAuthorization, subscribed[key] != nil { await loadTranscript(key) }
            }
        }
    }

    public func openSession(_ key: CliSessionKey) {
        if let closed = closedTranscripts.removeValue(forKey: key), Date().timeIntervalSince(closed) >= 300 { transcripts[key] = nil }
        subscribed[key, default: 0] += 1
        if subscribed[key] == 1 {
            let scope = cacheScope(), generation = UUID()
            openGeneration[key] = generation
            let openingStream = stream
            Task {
                let cached = if let scope {
                    await LocalContentCache.shared.load(StoredTail.self, scope: scope, key: "cli-tail:" + key)
                } else { nil as StoredTail? }
                guard openGeneration[key] == generation, cacheScope() == scope else { return }
                cachedTails[key] = cached
                if let openingStream, self.stream === openingStream {
                    await openingStream.subscribeSession(key, known: scope == nil ? nil : cached?.marks ?? [])
                }
                if cached != nil { try? await Task.sleep(for: .milliseconds(1200)) }
                if openGeneration[key] == generation, cached == nil || !transcript(key).loaded { await loadTranscript(key) }
            }
        }
        Task { await loadRequests(key) }
    }

    public func closeSession(_ key: CliSessionKey) {
        guard let count = subscribed[key] else { return }
        if count <= 1 {
            subscribed[key] = nil
            openGeneration[key] = nil
            cachedTails[key] = nil
            if var cached = transcripts[key], cached.loaded {
                if cached.items.count > 200 { cached.items = Array(cached.items.suffix(200)); cached.more = true }
                transcripts[key] = cached
                closedTranscripts[key] = Date()
                if closedTranscripts.count > 8, let oldest = closedTranscripts.min(by: { $0.value < $1.value })?.key {
                    closedTranscripts.removeValue(forKey: oldest)
                    transcripts.removeValue(forKey: oldest)
                }
            } else { transcripts[key] = nil }
            if let stream { Task { await stream.unsubscribeSession(key) } }
        } else { subscribed[key] = count - 1 }
    }

    private func loadTranscript(_ key: CliSessionKey) async {
        do {
            let page = try await clientProvider().cliItems(key: key)
            guard subscribed[key] != nil, !awaitingCacheAuthorization else { return }
            var t = transcript(key)
            // a push that arrived first is newer than this answer
            if !t.loaded { t.items = CliTranscript.merge(t.items, page.items); t.more = page.more; t.loaded = true }
            t.translationEnabled = page.translationEnabled
            if var tail = cachedTails[key], let scope = cacheScope() {
                tail.translationEnabled = page.translationEnabled
                cachedTails[key] = tail
                Task { [tail] in await LocalContentCache.shared.enqueue(tail.persistable, scope: scope, key: "cli-tail:" + key) }
            }
            t.error = nil
            transcripts[key] = t
            await fillEarlierTurns(key)
        } catch {
            guard subscribed[key] != nil else { return }
            var t = transcript(key)
            if !t.loaded { t.error = CliErrorText.text(for: error, fallback: "读取失败") }
            transcripts[key] = t
        }
    }

    private func loadRequests(_ key: CliSessionKey) async {
        guard let list = try? await clientProvider().cliRequests(key: key) else { return }
        touch()
        requests.mergePending(list)
        evaluateNotifications()
        scheduleExpiry()
    }

    public func reloadTranscript(_ key: CliSessionKey) {
        var t = transcript(key); t.loaded = false; t.error = nil; transcripts[key] = t
        Task { await loadTranscript(key) }
    }

    /// A page is 40 items, which one busy turn can fill: earlier pages load until a few turns are in view.
    func fillEarlierTurns(_ key: CliSessionKey) async {
        for _ in 0..<6 {
            let t = transcript(key)
            guard subscribed[key] != nil, t.more, t.error == nil, CliTranscript.userTurns(t.items) < 3 else { return }
            await loadOlder(key)
        }
    }

    public func loadOlder(_ key: CliSessionKey) async {
        var t = transcript(key)
        guard t.more, !t.loadingOlder, let first = t.items.first else { return }
        t.loadingOlder = true; transcripts[key] = t
        do {
            let page = try await clientProvider().cliItems(key: key, before: first.id)
            var next = transcript(key)
            next.items = CliTranscript.prepend(next.items, page.items); next.more = page.more; next.loadingOlder = false; next.error = nil
            transcripts[key] = next
        } catch {
            var next = transcript(key); next.loadingOlder = false; next.error = CliErrorText.text(for: error, fallback: "读取失败")
            transcripts[key] = next
        }
    }

    // MARK: Actions (each throws a CoreError; `CliErrorText.text(for:)` is the line to show)

    public func send(_ key: CliSessionKey, text: String) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard trimmed.utf8.count <= CoreClient.cliMaxSendBytes else { throw CoreError(kind: .http, message: CliErrorText.byCode["too_large"] ?? "内容太长", status: 400, code: "too_large") }
        try await clientProvider().cliSend(key: key, text: trimmed)
    }

    public func translateReply(_ key: CliSessionKey, item: CliItem) async throws -> String? {
        let scope = cacheScope()
        let cacheKey = "translation:zh:v1:" + key + ":" + item.id + ":" + LocalContentCache.digest(item.text)
        if let scope, let cached = await LocalContentCache.shared.load(String.self, scope: scope, key: cacheKey), scope == cacheScope() { return cached }
        try Task.checkCancellation()
        let text = try await clientProvider().cliTranslateReply(key: key, itemId: item.id, source: item.text)
        if let scope, let text, scope == cacheScope() {
            Task { await LocalContentCache.shared.enqueue(text, scope: scope, key: cacheKey) }
        }
        return text
    }

    public func interrupt(_ key: CliSessionKey) async throws { try await clientProvider().cliInterrupt(key: key) }

    public func openLocal(_ key: CliSessionKey) async throws { try await clientProvider().cliOpenLocal(key: key) }

    /// Resumes a stopped session. The new key is selected.
    @discardableResult
    public func continueSession(_ key: CliSessionKey) async throws -> CliSessionKey {
        let next = try await clientProvider().cliContinue(key: key)
        await refresh()
        if selectedKey == key { select(next) }
        return next
    }

    // MARK: New sessions

    /// Shows a new session at once and starts it in the background: the CLI (in a new worktree when `branch` is set), then the
    /// first message. The placeholder is selected; the real session takes its place once it is listed.
    @discardableResult
    public func launch(_ request: CliLaunchRequest) -> CliSessionKey {
        let entry = CliLaunches.make(request, now: Self.currentMs())
        launches.insert(entry, at: 0)
        select(entry.key)
        runLaunch(entry.id)
        return entry.key
    }

    /// Tries a failed launch again; the worktree request and a started session are reused.
    public func retryLaunch(_ id: String) { runLaunch(id) }

    /// Drops a failed launch. A session it did start stays in the list.
    public func dismissLaunch(_ id: String) {
        guard launchTasks[id] == nil, let entry = launches.first(where: { $0.id == id }) else { return }
        launches.removeAll { $0.id == id }
        if selectedKey == entry.key { select(entry.target) }
    }

    private func updateLaunch(_ id: String, _ change: (inout CliLaunch) -> Void) {
        guard let at = launches.firstIndex(where: { $0.id == id }) else { return }
        change(&launches[at])
    }

    private func runLaunch(_ id: String) {
        guard launchTasks[id] == nil, launches.contains(where: { $0.id == id }) else { return }
        launchTasks[id] = Task { [weak self] in
            await self?.performLaunch(id)
            self?.launchTasks[id] = nil
        }
    }

    private func performLaunch(_ id: String) async {
        guard let entry = launches.first(where: { $0.id == id }) else { return }
        let request = entry.request
        var target = entry.target
        updateLaunch(id) { $0.phase = .starting }
        do {
            if target == nil {
                let key = try await clientProvider().cliStart(deviceId: request.deviceId, engine: request.engine, cwd: request.cwd, worktreeBranch: request.branch,
                                                              requestId: entry.requestId, model: request.model, effort: request.effort, createDir: request.createDir,
                                                              permissions: request.permissions)
                target = key
                updateLaunch(id) { $0.target = key }
                await refresh()
            }
            let text = request.message.trimmingCharacters(in: .whitespacesAndNewlines)
            if let target, !text.isEmpty {
                updateLaunch(id) { $0.phase = .sending }
                echoes[target] = text
                var tries = 0
                while true {
                    do { try await send(target, text: text); break } catch {
                        // the computer lists a just-started session once the CLI is up
                        if tries < 30, CoreError.wrap(error).code == "not_found" { tries += 1; try? await Task.sleep(nanoseconds: launchRetryNanos); continue }
                        throw error
                    }
                }
            }
            updateLaunch(id) { $0.phase = .sent }
            await refresh()
            settleLaunches()
        } catch {
            if let target { echoes[target] = nil }
            let text = CliErrorText.text(for: error, fallback: target == nil ? "没能启动" : "消息没有发出")
            updateLaunch(id) { $0.phase = .failed(text) }
        }
    }

    /// A launch whose session is listed and whose first message is out is done: the real row takes over.
    private func settleLaunches() {
        let listed = Set(sessions.map(\.key))
        let done = launches.filter { $0.phase == .sent && $0.target.map(listed.contains) == true }
        guard !done.isEmpty else { return }
        let ids = Set(done.map(\.id))
        launches.removeAll { ids.contains($0.id) }
        if let moved = done.first(where: { $0.key == selectedKey }) { select(moved.target) }
    }

    /// The sub-folders of a folder on a computer ("" for its drives and home folder). An executor without `dirs` lists nothing and
    /// takes a typed path as it is.
    public func dirs(deviceId: String, path: String) async throws -> CliDirListing {
        guard device(deviceId)?.cliAgents?.features.contains("dirs") == true else {
            return CliDirListing(path: path, parent: path.isEmpty ? nil : CliPaths.parent(path), exists: true, entries: [])
        }
        return try await clientProvider().cliDirs(deviceId: deviceId, path: path)
    }

    /// Running or waiting sessions on every computer, pinned above the projects.
    public var activeSessions: [CliSession] { CliSessions.active(displaySessions) }

    /// The rows of the CLI's own `/model` picker on a computer: read from it when its executor can list them (once a minute),
    /// else the built-in suggestions.
    public func models(deviceId: String, engine: CliEngine) async -> CliModelCatalog {
        let fallback = CliModelCatalog(models: CliLaunches.fallbackModels[engine] ?? [])
        guard device(deviceId)?.cliAgents?.features.contains("models") == true else { return fallback }
        let id = "\(deviceId)\n\(engine.rawValue)"
        if let cached = catalogs[id], Self.currentMs() - cached.at < 60_000 { return cached.catalog }
        guard let catalog = try? await clientProvider().cliModels(deviceId: deviceId, engine: engine) else { return fallback }
        catalogs[id] = (Self.currentMs(), catalog)
        return catalog
    }

    @discardableResult
    public func startSession(deviceId: String, engine: CliEngine, cwd: String) async throws -> CliSessionKey {
        let key = try await clientProvider().cliStart(deviceId: deviceId, engine: engine, cwd: cwd)
        await refresh()
        select(key)
        return key
    }

    /// Hides or shows a session. The list changes at once and goes back if Core refuses.
    public func setHidden(_ key: CliSessionKey, _ hidden: Bool) async throws {
        guard let index = sessions.firstIndex(where: { $0.key == key }) else { return }
        let before = sessions[index].hidden
        sessions[index].hidden = hidden
        do { try await clientProvider().cliHide(key: key, hidden: hidden) } catch {
            if let again = sessions.firstIndex(where: { $0.key == key }) { sessions[again].hidden = before }
            throw error
        }
    }

    /// Answers a pending request. `selection` holds the chosen labels of a question; `always` allows such calls for the rest of the session.
    public func answer(_ request: CliRequest, decision: CliDecision, selection: CliRequestStore.Selection = [:], always: Bool = false) async throws {
        let answers = decision == .allow && request.kind == .question ? CliRequestStore.answers(request.questions ?? [], selection) : nil
        let forSession = always && decision == .allow && request.offersAlways
        try await clientProvider().cliAnswer(id: request.id, decision: decision, answers: answers, always: forSession)
        touch()
        requests.markAnswered(request.key, request.id, decision, always: forSession)
        scheduleExpiry()
    }

    public nonisolated static func answerErrorText(_ error: Error) -> String {
        let e = CoreError.wrap(error)
        return e.code == "not_found" ? "请求已处理或已过期" : CliErrorText.text(for: e, fallback: "操作失败")
    }

    public func fork(_ key: CliSessionKey, botId: String) async throws -> CliForkResult {
        try await clientProvider().cliFork(key: key, botId: botId)
    }

    public nonisolated static func forkErrorText(_ error: Error) -> String {
        let e = CoreError.wrap(error)
        return e.code == "not_found" ? "没有可交接的记录" : CliErrorText.text(for: e, fallback: "没能交接")
    }

    // MARK: Supervision

    public func loadSupervision() async {
        if let value = try? await clientProvider().cliSupervision() { supervision = value }
    }

    public func setSupervision(transientRetry: Bool? = nil, usageLimit: Bool? = nil, wakeup: Bool? = nil) async throws {
        supervision = try await clientProvider().cliSaveSupervision(transientRetry: transientRetry, usageLimit: usageLimit, wakeup: wakeup)
    }

    // MARK: Notifications

    /// The bell. Turning it on is the caller's job after the system permission was granted.
    public func setNotifications(_ on: Bool) {
        notificationsOn = on
        defaults.set(on ? "1" : "0", forKey: Self.notifyDefault)
    }

    private func evaluateNotifications() {
        let shown = displaySessions
        let pending = requests.pendingViews(now: now)
        let newRequests = CliNotify.newRequests(previous: previousRequestIds, pending: pending)
        let newlyWaiting = CliNotify.newlyWaiting(previous: previousStates, sessions: shown)
        previousRequestIds = Set(pending.map(\.id))
        previousStates = CliNotify.states(shown)
        guard notificationsOn, !isForeground(), let notifier else { return }
        var notified = Set<CliSessionKey>()
        for request in newRequests {
            let title = shown.first { $0.key == request.key }.map(CliSessions.title) ?? "Agent 会话"
            notifier.notify(title: title, body: CliNotify.requestBody(request), key: request.key)
            notified.insert(request.key)
        }
        for session in newlyWaiting where !notified.contains(session.key) {
            notifier.notify(title: CliSessions.title(session), body: "等你处理", key: session.key)
        }
    }

    // MARK: Stream

    private func touch() { now = Self.currentMs() }

    /// Wakes up when the next open card expires, so the list stops showing it as pending.
    private func scheduleExpiry() {
        expiryTask?.cancel()
        guard let at = requests.nextExpiry(now: now) else { return }
        let wait = max(0.05, Double(at - Self.currentMs()) / 1000)
        expiryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled else { return }
            self?.touch()
            self?.evaluateNotifications()
            self?.scheduleExpiry()
        }
    }

    /// The terminal view of the session in front. Stream events for terminals go to it.
    public func attach(_ controller: CliTerminalController?) {
        terminal = controller
    }

    public func makeTerminal(key: CliSessionKey, mode: CliTermMode = .observe) -> CliTerminalController? {
        guard let stream else { return nil }
        return CliTerminalController(stream: stream, key: key, connected: connected, mode: mode)
    }

    func handle(_ event: CliAgentStream.Event) {
        switch event {
        case .status(let status):
            link = status
            terminal?.handle(event)
        case .output:
            terminal?.handle(event)
        case .message(let message):
            touch()
            apply(message)
            scheduleExpiry()
            switch message {
            case .termOpened, .termSize, .termClosed, .error: terminal?.handle(event)
            default: break
            }
        }
    }

    private func apply(_ message: CliServerMessage) {
        switch message {
        case .list(let newDevices, let newSessions):
            generation += 1
            devices = newDevices; sessions = newSessions
            // the requests of every session that has some follow this list
            requests.dropOpen()
            loaded = true; loadError = nil
            settleLaunches()
            evaluateNotifications()
        case .listDelta(let upserts, let removes, let newDevices):
            generation += 1
            var next = sessions
            for session in upserts {
                if let at = next.firstIndex(where: { $0.key == session.key }) { next[at] = session } else { next.append(session) }
            }
            if !removes.isEmpty { let gone = Set(removes); next.removeAll { gone.contains($0.key) } }
            sessions = next
            if let newDevices { devices = newDevices }
            settleLaunches()
            evaluateNotifications()
        case .cachedItems(let key, let items, let more, let snapshot):
            guard subscribed[key] != nil, !awaitingCacheAuthorization, let scope = cacheScope() else { return }
            let prior = cachedTails[key]
            let cached = Dictionary(zip(prior?.marks ?? [], prior?.items ?? []), uniquingKeysWith: { _, last in last })
            let changed = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
            let combined = snapshot.compactMap { changed[String($0.dropFirst(65))] ?? cached[$0] }
            guard combined.count == snapshot.count else { Task { await loadTranscript(key) }; return }
            var t = transcript(key)
            let priorIds = Set(prior?.items.map(\.id) ?? [])
            let next = CliTranscript.reset(t.items.filter { !priorIds.contains($0.id) }, combined)
            t.items = next.items
            if !next.kept { t.more = more }
            t.loaded = true
            t.error = nil
            t.translationEnabled = prior?.translationEnabled ?? t.translationEnabled
            transcripts[key] = t
            let tail = StoredTail(marks: snapshot, items: combined, translationEnabled: t.translationEnabled)
            cachedTails[key] = tail
            Task {
                await stream?.updateSessionKnown(key, known: snapshot)
                await LocalContentCache.shared.enqueue(tail.persistable, scope: scope, key: "cli-tail:" + key)
            }
        case .items(let key, let items, let reset, let more):
            guard subscribed[key] != nil, !awaitingCacheAuthorization else { return }
            var t = transcript(key)
            if reset {
                // the newest page again (a reconnect, a rewritten file): earlier pages stay
                let next = CliTranscript.reset(t.items, items)
                t.items = next.items
                if !next.kept { t.more = more ?? false }
            } else {
                t.items = CliTranscript.merge(t.items, items)
                if let more { t.more = more }
            }
            t.loaded = true; t.error = nil
            transcripts[key] = t
        case .requests(let key, let list):
            requests.setPending(key, list)
            evaluateNotifications()
        case .requestResolved(let key, let id, let by):
            requests.resolve(key, id, by: by)
        case .summary, .pong, .termOpened, .termSize, .termClosed, .error:
            break
        }
    }
}

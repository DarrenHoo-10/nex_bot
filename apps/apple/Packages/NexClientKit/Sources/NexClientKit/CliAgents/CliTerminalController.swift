import Foundation
import Observation

/// One terminal view of one session: opens the stream, tracks its state and moves bytes between the stream and the terminal widget.
/// The widget sets `onOpened`, `onResize` and `onOutput` and calls `sendInput` and `viewResized`; the model forwards stream events.
@MainActor @Observable
public final class CliTerminalController {
    public let key: CliSessionKey
    public private(set) var state: CliTermState
    public private(set) var connected: Bool
    /// True when control was requested but the server only granted observe mode.
    public private(set) var controlDeclined = false

    /// The terminal was opened (or reopened): reset it and size it to `cols` x `rows`.
    @ObservationIgnored public var onOpened: ((_ cols: Int, _ rows: Int) -> Void)?
    /// The device changed the terminal's size.
    @ObservationIgnored public var onResize: ((_ cols: Int, _ rows: Int) -> Void)?
    @ObservationIgnored public var onOutput: ((Data) -> Void)?

    public var status: CliTermStatus { state.status(connected: connected) }
    public var wantsControl: Bool { state.want == .control }

    @ObservationIgnored private let stream: CliAgentStream
    @ObservationIgnored private var meter = CliCreditMeter()
    @ObservationIgnored private var viewSize: (cols: Int, rows: Int)?
    @ObservationIgnored private var resizeTask: Task<Void, Never>?
    @ObservationIgnored private let input: AsyncStream<(UInt32, Data)>.Continuation
    @ObservationIgnored private let inputTask: Task<Void, Never>
    @ObservationIgnored private let resizeDelay: Double
    @ObservationIgnored private var requestedObserve = false

    public init(stream: CliAgentStream, key: CliSessionKey, connected: Bool, mode: CliTermMode = .observe, resizeDelay: Double = 0.1) {
        self.stream = stream; self.key = key; self.connected = connected; self.resizeDelay = resizeDelay
        state = CliTermState(want: mode)
        let (pipe, continuation) = AsyncStream<(UInt32, Data)>.makeStream(bufferingPolicy: .unbounded)
        input = continuation
        // keystrokes leave in the order they were typed
        inputTask = Task { for await (sid, bytes) in pipe { await stream.sendInput(sid: sid, bytes) } }
        state.apply(.start(mode))
    }

    deinit { input.finish(); inputTask.cancel() }

    /// Opens the terminal if the socket is up; otherwise it opens when the socket comes up.
    public func begin() { openIfNeeded() }

    /// Closes the terminal. The controller is not used afterwards.
    public func stop() {
        closeCurrent()
        resizeTask?.cancel()
        controlDeclined = false
        state.apply(.stop)
    }

    /// The "重新连接" button.
    public func reconnect(mode: CliTermMode? = nil) {
        closeCurrent()
        controlDeclined = false
        state.apply(.start(mode))
        openIfNeeded()
    }

    /// 只看 / 操作.
    public func setMode(_ mode: CliTermMode) {
        guard mode != state.want || state.sid == nil else { return }
        closeCurrent()
        controlDeclined = false
        state.apply(.mode(mode))
        openIfNeeded()
    }

    /// The widget's size in terminal cells. In control mode the device's terminal follows it.
    public func viewResized(cols: Int, rows: Int) {
        viewSize = (cols, rows)
        guard state.mode == .control, state.sid != nil, cols != state.cols || rows != state.rows else { return }
        resizeTask?.cancel()
        let sid = state.sid
        resizeTask = Task { [stream, resizeDelay] in
            try? await Task.sleep(for: .seconds(resizeDelay))
            guard !Task.isCancelled, let sid else { return }
            await stream.resizeTerminal(sid: sid, cols: cols, rows: rows)
        }
    }

    /// Keystrokes from the widget. Dropped unless the terminal is in control mode.
    public func sendInput(_ bytes: Data) {
        guard state.phase == .controlling, let sid = state.sid, !bytes.isEmpty else { return }
        input.yield((sid, bytes))
    }

    public func sendText(_ text: String) {
        guard !text.isEmpty else { return }
        sendInput(Data(text.utf8))
    }

    public func sendKey(_ name: String, appCursor: Bool = false) {
        if let bytes = CliTermKeyEncoder.encode(name, appCursor: appCursor) {
            sendInput(bytes)
        }
    }

    // MARK: Stream events

    public func handle(_ event: CliAgentStream.Event) {
        switch event {
        case .status(let status):
            connected = status == .open
            if connected { openIfNeeded() } else { controlDeclined = false; state.apply(.disconnected) }
        case .output(let sid, let data):
            guard sid == state.sid else { return }
            onOutput?(data)
            if let grant = meter.wrote(data.count) { Task { [stream] in await stream.grantCredit(sid: sid, bytes: grant) } }
        case .message(let message):
            switch message {
            case .termOpened(let req, let sid, let cols, let rows, let observe):
                guard req == state.req else { return }
                controlDeclined = observe && !requestedObserve
                state.apply(.opened(req: req, sid: sid, cols: cols, rows: rows, observe: observe))
                meter = CliCreditMeter()
                onOpened?(cols, rows)
                if state.mode == .control, let size = viewSize, size.cols != cols || size.rows != rows { viewResized(cols: size.cols, rows: size.rows) }
            case .termSize(let sid, let cols, let rows):
                guard sid == state.sid, cols != state.cols || rows != state.rows else { return }
                state.apply(.size(sid: sid, cols: cols, rows: rows))
                onResize?(cols, rows)
            case .termClosed(let sid, let reason):
                guard sid == state.sid else { return }
                controlDeclined = false
                state.apply(.closed(sid: sid, reason: reason))
                openIfNeeded()
            case .error(let code, let req?, _):
                guard req == state.req else { return }
                controlDeclined = false
                state.apply(.error(code: code, req: req))
            default: break
            }
        }
    }

    // MARK: Private

    private func openIfNeeded() {
        guard connected, state.needsOpen else { return }
        let req = UUID().uuidString.lowercased()
        state.apply(.requested(req))
        let observe = state.want == .observe
        requestedObserve = observe
        let size = observe ? CliTermState.clampSize(cols: nil, rows: nil) : CliTermState.clampSize(cols: viewSize?.cols, rows: viewSize?.rows)
        let key = key
        Task { [stream] in
            let sent = await stream.openTerminal(req: req, key: key, cols: size.cols, rows: size.rows, observe: observe)
            if !sent { self.openFailed(req: req) }
        }
    }

    private func openFailed(req: String) {
        guard state.req == req else { return }
        state.apply(.disconnected)
        state.needsOpen = true
    }

    private func closeCurrent() {
        if let sid = state.sid { Task { [stream] in await stream.closeTerminal(sid: sid) } }
        else if let req = state.req { Task { [stream] in await stream.abandonTerminal(req: req) } }
    }
}

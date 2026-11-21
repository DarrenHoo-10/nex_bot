import XCTest
@testable import NexClientKit

// Models, frames, helpers and the HTTP client of Agent mode.

func cliSessionJSON(_ key: String = "d1:claude:s1", device: String = "d1", cwd: String = "/work/app", state: String = "idle", online: Bool = true,
                    hidden: Bool = false, liveIn: String? = "nexbot", terminal: String? = "term-1", at: Int = 1000, title: String = "修复登录") -> [String: Any] {
    var s: [String: Any] = ["key": key, "deviceId": device, "hidden": hidden, "online": online, "engine": "claude", "nativeId": "s1", "configDir": "",
                            "cwd": cwd, "title": title, "state": state, "lastActivityAt": at]
    if let liveIn { s["liveIn"] = liveIn }
    if let terminal { s["terminal"] = terminal }
    return s
}

func cliSession(_ key: String = "d1:claude:s1", device: String = "d1", cwd: String = "/work/app", state: CliSessionState = .idle, online: Bool = true,
                hidden: Bool = false, liveIn: CliLiveIn? = .nexbot, terminal: String? = "term-1", at: Int = 1000, engine: CliEngine = .claude, title: String = "修复登录") -> CliSession {
    CliSession(key: key, deviceId: device, hidden: hidden, online: online, engine: engine, nativeId: "s1", cwd: cwd, title: title, state: state,
               liveIn: liveIn, terminal: terminal, lastActivityAt: at)
}

func cliRequest(_ id: String = "r1", key: String = "d1:claude:s1", kind: CliRequestKind = .permission, expires: Int = 10_000, questions: [CliQuestion]? = nil) -> CliRequest {
    CliRequest(id: id, key: key, kind: kind, tool: "Bash", summary: "rm -rf build", questions: questions, createdAt: 1, expiresAt: expires)
}

final class CliAgentsTests: XCTestCase {
    func decode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: object))
    }

    // MARK: Models

    func testSnapshotDropsMalformedRows() throws {
        let snapshot = try decode(CliSnapshot.self, [
            "devices": [["id": "d1", "name": "办公室", "online": true, "cliAgents": ["engines": ["claude", "gemini"], "terminal": ["name": "herdr-core", "version": "1", "ready": true]]],
                        ["id": "d2"]],
            "sessions": [cliSessionJSON(), ["key": "broken"], cliSessionJSON("d1:codex:s2")],
            "requests": [["id": "r1", "key": "d1:claude:s1", "kind": "permission", "tool": "Bash", "summary": "ls", "createdAt": 1, "expiresAt": 2], ["id": 5]],
        ])
        XCTAssertEqual(snapshot.devices.map(\.id), ["d1"])
        XCTAssertEqual(snapshot.devices[0].cliAgents?.engines, [.claude], "an unknown engine is skipped")
        XCTAssertEqual(snapshot.sessions.map(\.key), ["d1:claude:s1", "d1:codex:s2"])
        XCTAssertEqual(snapshot.requests.map(\.id), ["r1"])
    }

    func testItemsDecodePerKind() throws {
        let page = try decode(CliItemsPage.self, [
            "items": [["id": "1", "ts": 1, "kind": "user", "text": "你好", "queued": true],
                      ["id": "2", "ts": 2, "kind": "tool", "name": "Bash", "input": "ls\n-la", "status": "ok", "output": "a"],
                      ["id": "3", "ts": 3, "kind": "notice", "level": "error", "text": "失败"],
                      ["id": "4", "ts": 4, "kind": "turn", "phase": "aborted"],
                      ["id": "5", "ts": 5, "kind": "tool", "name": "Bash"]],
            "more": true,
        ])
        XCTAssertEqual(page.items.map(\.id), ["1", "2", "3", "4"], "a tool without input and status is dropped")
        XCTAssertTrue(page.more)
        XCTAssertTrue(page.items[0].queued)
        XCTAssertEqual(page.items[1].status, .ok)
        XCTAssertEqual(page.items[3].phase, .aborted)
    }

    func testSupervisionReadsGlobalOverDefaults() throws {
        let value = try decode(CliSupervision.self, [
            "defaults": ["transientRetry": true, "usageLimit": false, "wakeup": false],
            "global": ["usageLimit": true],
            "workspaces": [["cwd": "/a"], ["cwd": "/b"]],
            "actions": [["status": "pending"], ["status": "done"], ["status": "pending"]],
        ])
        XCTAssertEqual(value.settings, CliSupervisionSettings(transientRetry: true, usageLimit: true, wakeup: false))
        XCTAssertEqual(value.overrides, 2)
        XCTAssertEqual(value.pending, 2)
        let empty = try decode(CliSupervision.self, [String: Any]())
        XCTAssertEqual(empty.settings, .defaults)
    }

    func testServerMessages() throws {
        func parse(_ object: [String: Any]) -> CliServerMessage? { CliServerMessage.parse(try! JSONSerialization.data(withJSONObject: object)) }
        guard case .list(let devices, let sessions)? = parse(["type": "list", "devices": [["id": "d1", "name": "A", "online": true]], "sessions": [cliSessionJSON()]]) else { return XCTFail("list") }
        XCTAssertEqual(devices.count, 1); XCTAssertEqual(sessions.count, 1)
        guard case .listDelta(let up, let rm, let dev)? = parse(["type": "list.delta", "upserts": [cliSessionJSON()], "removes": ["x"]]) else { return XCTFail("delta") }
        XCTAssertEqual(up.count, 1); XCTAssertEqual(rm, ["x"]); XCTAssertNil(dev)
        guard case .items(let key, _, let reset, let more)? = parse(["type": "items", "key": "k", "items": [], "reset": true]) else { return XCTFail("items") }
        XCTAssertEqual(key, "k"); XCTAssertTrue(reset); XCTAssertNil(more)
        guard case .termOpened(let req, let sid, let cols, let rows, let observe)? = parse(["type": "term.opened", "req": "q", "sid": 7, "cols": 100, "rows": 30, "observe": true]) else { return XCTFail("opened") }
        XCTAssertEqual([req, "\(sid)", "\(cols)", "\(rows)", "\(observe)"], ["q", "7", "100", "30", "true"])
        guard case .termClosed(_, let reason)? = parse(["type": "term.closed", "sid": 7, "reason": "exited"]) else { return XCTFail("closed") }
        XCTAssertEqual(reason, "exited")
        guard case .error(let code, let errReq, _)? = parse(["type": "error", "code": "read_only", "req": "q"]) else { return XCTFail("error") }
        XCTAssertEqual(code, "read_only"); XCTAssertEqual(errReq, "q")
        guard case .requestResolved(_, let id, let by)? = parse(["type": "request.resolved", "key": "k", "id": "r1", "by": "terminal"]) else { return XCTFail("resolved") }
        XCTAssertEqual(id, "r1"); XCTAssertEqual(by, .terminal)
        guard case .requests(let rk, let reqs)? = parse(["type": "requests", "key": "k", "requests": [
            ["id": "a", "key": "k", "kind": "permission", "tool": "T", "summary": "s", "createdAt": 1, "expiresAt": 2],
            ["id": "b", "key": "other", "kind": "permission", "tool": "T", "summary": "s", "createdAt": 1, "expiresAt": 2]]]) else { return XCTFail("requests") }
        XCTAssertEqual(rk, "k"); XCTAssertEqual(reqs.map(\.id), ["a"], "a request of another session is dropped")
        guard case .pong? = parse(["type": "pong"]) else { return XCTFail("pong") }
        XCTAssertNil(parse(["type": "mystery"]))
        XCTAssertNil(CliServerMessage.parse(Data("not json".utf8)))
    }

    func testErrorText() {
        let known = CoreError(kind: .http, message: "", status: 409, code: "open_elsewhere")
        XCTAssertEqual(CliErrorText.text(for: known), "这个会话正在电脑上运行")
        XCTAssertEqual(CliErrorText.text(for: CoreError(kind: .http, message: "设备说：忙", status: 409, code: "busy")), "设备说：忙", "Core's own wording wins")
        XCTAssertEqual(CliErrorText.text(for: CoreError(kind: .network, message: "无法连接 Core")), "无法连接 Core")
    }

    // MARK: Frames

    func testFrameRoundTrip() {
        let data = CliFrame.input(sid: 0x0102_0304, payload: Data("ls\r".utf8)).encode()
        XCTAssertEqual([UInt8](data.prefix(5)), [0x02, 0x04, 0x03, 0x02, 0x01], "type, then sid little-endian")
        XCTAssertEqual(CliFrame.decode(data), .input(sid: 0x0102_0304, payload: Data("ls\r".utf8)))
        XCTAssertEqual(CliFrame.decode(Data([0x01, 9, 0, 0, 0, 0x41])), .output(sid: 9, payload: Data([0x41])))
        XCTAssertEqual(CliFrame.decode(Data([0x01, 9, 0, 0, 0])), .output(sid: 9, payload: Data()))
    }

    func testFrameRejectsBadInput() {
        XCTAssertNil(CliFrame.decode(Data([0x01, 0, 0, 0])), "short")
        XCTAssertNil(CliFrame.decode(Data([0x09, 0, 0, 0, 0, 1])), "unknown type")
        XCTAssertNil(CliFrame.decode(Data([0x01, 0, 0, 0, 0]) + Data(count: CliFrame.payloadMax + 1)), "too large")
        XCTAssertNotNil(CliFrame.decode(Data([0x01, 0, 0, 0, 0]) + Data(count: CliFrame.payloadMax)))
    }

    func testInputFramesSplit() {
        XCTAssertTrue(CliFrame.inputFrames(sid: 1, Data()).isEmpty)
        let frames = CliFrame.inputFrames(sid: 1, Data(count: CliFrame.payloadMax * 2 + 10))
        XCTAssertEqual(frames.map { $0.count - CliFrame.headerSize }, [CliFrame.payloadMax, CliFrame.payloadMax, 10])
    }

    // MARK: Sessions

    func testLabelsAndTone() {
        XCTAssertEqual(CliSessions.statusLabel(cliSession(state: .waiting)), "等你处理")
        XCTAssertEqual(CliSessions.statusLabel(cliSession(state: .running, online: false)), "电脑离线")
        XCTAssertEqual(CliSessions.tone(cliSession(state: .running, online: false)), .offline)
        XCTAssertEqual(CliSessions.tone(cliSession(state: .stopped)), .stopped)
        XCTAssertEqual(CliSessions.folderLabel("C:\\Users\\me\\proj"), "proj")
        XCTAssertEqual(CliSessions.folderLabel("/a/b/"), "b")
        XCTAssertEqual(CliSessions.folderLabel(""), "未知目录")
        XCTAssertEqual(CliSessions.folderLabel("/"), "/")
        XCTAssertEqual(CliSessions.title(cliSession(title: "  ")), "Claude 会话")
        XCTAssertEqual(CliSessions.title(cliSession(engine: .codex, title: "")), "Codex 会话")
        XCTAssertEqual(CliSessions.title(cliSession(title: " 修复 ")), "修复")
    }

    func testGrouping() {
        let devices = [CliDevice(id: "d2", name: "Dorm", online: false), CliDevice(id: "d1", name: "Office", online: true), CliDevice(id: "d3", name: "Spare", online: true)]
        let sessions = [
            cliSession("d1:claude:a", cwd: "/w/one", at: 10), cliSession("d1:claude:b", cwd: "/w/two", at: 30), cliSession("d1:claude:c", cwd: "/w/one", at: 20),
            cliSession("d2:claude:d", device: "d2", at: 5), cliSession("d1:claude:h", hidden: true, at: 99), cliSession("d9:claude:z", device: "d9", at: 1),
        ]
        let groups = CliSessions.group(devices: devices, sessions: sessions)
        XCTAssertEqual(groups.map(\.device.id), ["d9", "d1", "d3", "d2"], "online first, then by name; offline last")
        let office = groups[1]
        XCTAssertEqual(office.folders.map(\.cwd), ["/w/two", "/w/one"], "the folder with the latest session first")
        XCTAssertEqual(office.folders[1].sessions.map(\.key), ["d1:claude:c", "d1:claude:a"], "newest first")
        XCTAssertEqual(office.count, 3, "hidden sessions are not counted")
        XCTAssertTrue(groups[2].folders.isEmpty, "a computer without sessions stays")
        XCTAssertEqual(groups[0].device.name, "d9", "an unknown computer is named by its id")
        let all = CliSessions.group(devices: devices, sessions: sessions, showHidden: true)
        XCTAssertEqual(all.first { $0.device.id == "d1" }?.count, 4)
        XCTAssertEqual(CliSessions.hiddenCount(sessions), 1)
    }

    func testWaitingAndAsked() {
        let a = cliSession("a", state: .running), b = cliSession("b", state: .waiting), c = cliSession("c", state: .waiting, online: false), d = cliSession("d", state: .waiting, hidden: true)
        XCTAssertEqual(CliSessions.waitingCount([a, b, c, d]), 1)
        XCTAssertEqual(CliSessions.waitingCount([a, b], asked: ["a"]), 2)
        XCTAssertEqual(CliSessions.asked(a, pending: 1).state, .waiting)
        XCTAssertEqual(CliSessions.asked(a, pending: 0).state, .running)
        XCTAssertEqual(CliSessions.asked(cliSession(online: false), pending: 1).state, .idle)
    }

    func testAttachAndComposer() {
        XCTAssertTrue(CliSessions.canAttach(cliSession()))
        XCTAssertFalse(CliSessions.canAttach(cliSession(state: .stopped)))
        XCTAssertFalse(CliSessions.canAttach(cliSession(liveIn: .terminal)))
        XCTAssertFalse(CliSessions.canAttach(cliSession(terminal: nil)))
        XCTAssertEqual(CliSessions.composerMode(cliSession(online: false)), .blocked(hint: "电脑离线"))
        XCTAssertEqual(CliSessions.composerMode(cliSession(state: .stopped)), .stopped(hint: nil))
        XCTAssertEqual(CliSessions.composerMode(cliSession(state: .running)), .send(running: true))
        XCTAssertEqual(CliSessions.composerMode(cliSession(state: .idle)), .send(running: false))
        XCTAssertEqual(CliSessions.composerMode(cliSession(liveIn: .desktop)), .blocked(hint: "在 Claude 桌面应用中打开"))
        XCTAssertEqual(CliSessions.composerMode(cliSession(liveIn: .terminal)), .blocked(hint: "在电脑上运行"))
        var unknown = cliSession(liveIn: .terminal); unknown.writerUnknown = true
        XCTAssertEqual(CliSessions.composerMode(unknown), .blocked(hint: "可能在电脑上打开"))
        unknown.state = .stopped
        XCTAssertEqual(CliSessions.composerMode(unknown), .stopped(hint: "可能在电脑上打开"))
    }

    func testDeviceBlockerAndRecentFolders() {
        let ready = CliCapability(engines: [.claude], terminal: CliTerminalCapability(ready: true))
        XCTAssertNil(CliSessions.deviceBlocker(CliDevice(id: "d", name: "n", online: true, cliAgents: ready)))
        XCTAssertEqual(CliSessions.deviceBlocker(nil), "电脑离线")
        XCTAssertEqual(CliSessions.deviceBlocker(CliDevice(id: "d", name: "n", online: false, cliAgents: ready)), "电脑离线")
        XCTAssertEqual(CliSessions.deviceBlocker(CliDevice(id: "d", name: "n", online: true)), "未开启 Agent 会话")
        XCTAssertEqual(CliSessions.deviceBlocker(CliDevice(id: "d", name: "n", online: true, cliAgents: CliCapability(engines: [.claude], terminal: CliTerminalCapability(ready: false)))), "终端组件不可用")
        XCTAssertEqual(CliSessions.deviceBlocker(CliDevice(id: "d", name: "n", online: true, cliAgents: CliCapability(engines: [.claude], terminal: CliTerminalCapability(ready: false, error: "版本过低")))), "版本过低")
        XCTAssertEqual(CliSessions.deviceBlocker(CliDevice(id: "d", name: "n", online: true, cliAgents: CliCapability(engines: [], terminal: CliTerminalCapability(ready: true)))), "找不到 Claude 或 Codex")
        let sessions = [cliSession("a", cwd: "/x", at: 1), cliSession("b", cwd: "/y", at: 9), cliSession("c", cwd: "/x", at: 5), cliSession("e", device: "other", cwd: "/z", at: 99)]
        XCTAssertEqual(CliSessions.recentCwds(sessions, deviceId: "d1"), ["/y", "/x"])
        XCTAssertEqual(CliSessions.recentCwds(sessions, deviceId: "d1", limit: 1), ["/y"])
    }

    func testAbsoluteCwd() {
        for ok in ["C:\\Users\\me", "c:/work", "/home/me", "\\\\server\\share", "//server/share/dir"] { XCTAssertTrue(CliSessions.isAbsoluteCwd(ok), ok) }
        for bad in ["", "relative/dir", "~/x", "C:", "C:work", "\\\\server", "\\\\?\\C:\\x", "\\\\.\\pipe\\x", "/a\0b", "ftp://x"] { XCTAssertFalse(CliSessions.isAbsoluteCwd(bad), bad) }
        XCTAssertFalse(CliSessions.isAbsoluteCwd("/" + String(repeating: "a", count: 4096)))
    }

    // MARK: Transcript

    func item(_ id: String, _ ts: Int, _ kind: CliItemKind = .assistant, text: String = "") -> CliItem { CliItem(id: id, ts: ts, kind: kind, text: text) }

    func testMergeItems() {
        let base = [item("a", 1), item("c", 3)]
        XCTAssertEqual(CliTranscript.merge(base, [item("b", 2)]).map(\.id), ["a", "b", "c"], "after the last item that is not newer")
        XCTAssertEqual(CliTranscript.merge(base, [item("d", 9)]).map(\.id), ["a", "c", "d"])
        XCTAssertEqual(CliTranscript.merge(base, [item("a", 1, text: "new")]).first?.text, "new", "same id replaces in place")
        XCTAssertEqual(CliTranscript.merge(base, [item("x", 5), item("x", 5)]).map(\.id), ["a", "c", "x"])
        XCTAssertEqual(CliTranscript.merge(base, [item("z", 1), item("z", 1)], reset: true).map(\.id), ["z"], "reset replaces and dedupes")
        let kept = CliTranscript.reset([item("a", 1), item("b", 2), item("c", 3)], [item("b", 2), item("d", 4)])
        XCTAssertEqual(kept.items.map(\.id), ["a", "b", "d"], "a reset page that starts at a shown item keeps the earlier ones")
        XCTAssertTrue(kept.kept)
        let replaced = CliTranscript.reset([item("a", 1)], [item("z", 9)])
        XCTAssertEqual(replaced.items.map(\.id), ["z"]); XCTAssertFalse(replaced.kept)
        XCTAssertEqual(CliTranscript.prepend([item("c", 3, text: "shown")], [item("a", 1), item("c", 3, text: "old")]).map(\.text), ["", "shown"])
    }

    func testGroupItems() {
        let tool = CliItem(id: "t1", ts: 2, kind: .tool, name: "Bash", input: "ls", status: .ok)
        let tool2 = CliItem(id: "t2", ts: 3, kind: .tool, name: "Read", input: "x", status: .running)
        let blocks = CliTranscript.group([
            item("u", 1, .user, text: "hi"), tool, item("th", 2, .thinking, text: "..."), tool2, item("a", 4, .assistant, text: "ok"),
            CliItem(id: "n", ts: 5, kind: .notice, text: "断开", level: .error),
            CliItem(id: "ts", ts: 6, kind: .turn, phase: .started), CliItem(id: "ab", ts: 7, kind: .turn, phase: .aborted),
        ])
        XCTAssertEqual(blocks.count, 5)
        guard case .activity(let id, let run) = blocks[1] else { return XCTFail("activity") }
        XCTAssertEqual(id, "t1"); XCTAssertEqual(run.map(\.id), ["t1", "th", "t2"])
        XCTAssertEqual(blocks[3], .notice(id: "n", level: .error, text: "断开"))
        XCTAssertEqual(blocks[4], .notice(id: "ab", level: .info, text: "已中断"))
    }

    func testToolSummary() {
        XCTAssertEqual(CliTranscript.toolSummary("ls -la\nsecond"), "ls -la")
        XCTAssertEqual(CliTranscript.toolSummary(String(repeating: "x", count: 200)).count, 120)
        XCTAssertTrue(CliTranscript.toolSummary(String(repeating: "x", count: 200)).hasSuffix("…"))
        XCTAssertEqual(CliTranscript.toolStatusText(.error), "失败")
    }

    // MARK: Requests

    func testRequestStoreLifecycle() {
        var store = CliRequestStore()
        let a = cliRequest("a"), b = cliRequest("b")
        store.setPending("d1:claude:s1", [a, b])
        XCTAssertEqual(store.pending("d1:claude:s1", now: 0).map(\.id), ["a", "b"])
        store.markAnswered("d1:claude:s1", "a", .allow)
        XCTAssertEqual(store.records["d1:claude:s1"]?.map(\.id), ["b", "a"], "a closed card moves to the end")
        XCTAssertEqual(CliRequestStore.state(of: store.records["d1:claude:s1"]![1], now: 0), .allowed)
        store.setPending("d1:claude:s1", [a, b])
        XCTAssertEqual(store.pending("d1:claude:s1", now: 0).map(\.id), ["b"], "a closed card is not reopened by a push")
        store.resolve("d1:claude:s1", "b", by: .terminal)
        XCTAssertEqual(CliRequestStore.state(of: store.records["d1:claude:s1"]!.last!, now: 0), .terminal)
        store.resolve("d1:claude:s1", "a", by: .terminal)
        XCTAssertEqual(store.records["d1:claude:s1"]?.first(where: { $0.id == "a" })?.by, .nexbot, "an answer given here is not overwritten")
        store.setPending("d1:claude:s1", [])
        XCTAssertEqual(store.records["d1:claude:s1"]?.count, 2, "closed cards stay")
        store.dropOpen()
        XCTAssertEqual(store.records["d1:claude:s1"]?.count, 2)
    }

    func testRequestStoreMergeAndOtherSessions() {
        var store = CliRequestStore()
        store.setPending("k", [cliRequest("a", key: "k"), cliRequest("x", key: "other")])
        XCTAssertEqual(store.records["k"]?.map(\.id), ["a"], "a request of another session is ignored")
        store.mergePending([cliRequest("a", key: "k"), cliRequest("c", key: "k"), cliRequest("d", key: "m")])
        XCTAssertEqual(store.records["k"]?.map(\.id), ["a", "c"])
        XCTAssertEqual(store.records["m"]?.map(\.id), ["d"])
        store.dropOpen()
        XCTAssertTrue(store.records.isEmpty)
    }

    func testCardStatesAndExpiry() {
        var store = CliRequestStore()
        store.setPending("k", [cliRequest("a", key: "k", expires: 10_000), cliRequest("q", key: "k", kind: .question, expires: 50_000)])
        let open = store.records["k"]![0]
        XCTAssertEqual(CliRequestStore.state(of: open, now: 15_000), .pending, "five seconds of grace")
        XCTAssertEqual(CliRequestStore.state(of: open, now: 15_001), .expired)
        XCTAssertEqual(store.nextExpiry(now: 0), 15_001)
        XCTAssertEqual(store.nextExpiry(now: 20_000), 55_001)
        XCTAssertEqual(store.counts(now: 20_000), ["k": 1])
        XCTAssertEqual(store.pendingViews(now: 20_000).map(\.id), ["q"])
        store.markAnswered("k", "q", .allow)
        XCTAssertEqual(CliRequestStore.state(of: store.records["k"]!.last!, now: 0), .answered)
        store.markAnswered("k", "a", .deny)
        XCTAssertEqual(CliRequestStore.state(of: store.records["k"]!.last!, now: 0), .denied)
        XCTAssertEqual(CliCardState.terminal.text, "已在终端处理")
        XCTAssertEqual(CliCardState.expired.text, "已过期")
        XCTAssertEqual(CliCardState.gone.text, "会话已结束")
    }

    func testClosedCardsAreTrimmed() {
        var store = CliRequestStore()
        let all = (0..<15).map { cliRequest("r\($0)", key: "k") }
        store.setPending("k", all)
        for r in all { store.markAnswered("k", r.id, .allow) }
        XCTAssertEqual(store.records["k"]?.count, CliRequestStore.closedKeep)
        XCTAssertEqual(store.records["k"]?.first?.id, "r5", "the oldest are dropped")
    }

    func testQuestionAnswers() {
        let questions = [CliQuestion(question: "选哪个", options: [.init(label: "甲"), .init(label: "乙"), .init(label: "丙")], multiSelect: true),
                         CliQuestion(question: "确认吗", options: [.init(label: "是"), .init(label: "否")])]
        var selection: CliRequestStore.Selection = [:]
        XCTAssertFalse(CliRequestStore.answersComplete(questions, selection))
        selection = CliRequestStore.toggle(selection, index: 0, label: "丙", multi: true)
        selection = CliRequestStore.toggle(selection, index: 0, label: "甲", multi: true)
        XCTAssertFalse(CliRequestStore.answersComplete(questions, selection))
        selection = CliRequestStore.toggle(selection, index: 1, label: "是", multi: false)
        selection = CliRequestStore.toggle(selection, index: 1, label: "否", multi: false)
        XCTAssertTrue(CliRequestStore.answersComplete(questions, selection))
        XCTAssertEqual(CliRequestStore.answers(questions, selection), ["选哪个": "甲, 丙", "确认吗": "否"], "labels in option order, one choice replaces the other")
        selection = CliRequestStore.toggle(selection, index: 0, label: "丙", multi: true)
        XCTAssertEqual(CliRequestStore.answers(questions, selection)["选哪个"], "甲")
        XCTAssertFalse(CliRequestStore.answersComplete(nil, [:]))
    }

    // MARK: Notifications

    func testNotificationHelpers() {
        let before = CliNotify.states([cliSession("a", state: .running), cliSession("b", state: .waiting)])
        let now = [cliSession("a", state: .waiting), cliSession("b", state: .waiting), cliSession("c", state: .waiting, online: false), cliSession("d", state: .waiting, hidden: true)]
        XCTAssertEqual(CliNotify.newlyWaiting(previous: before, sessions: now).map(\.key), ["a"])
        XCTAssertTrue(CliNotify.newlyWaiting(previous: nil, sessions: now).isEmpty, "nothing on the first list")
        XCTAssertEqual(CliNotify.newRequests(previous: ["r1"], pending: [cliRequest("r1"), cliRequest("r2")]).map(\.id), ["r2"])
        XCTAssertTrue(CliNotify.newRequests(previous: nil, pending: [cliRequest("r1")]).isEmpty)
    }

    func testRequestBody() {
        XCTAssertEqual(CliNotify.requestBody(cliRequest()), "Bash rm -rf build")
        let q = CliQuestion(question: "  用哪个\n库？ ", options: [.init(label: "x")])
        XCTAssertEqual(CliNotify.requestBody(cliRequest(kind: .question, questions: [q])), "用哪个 库？")
        XCTAssertEqual(CliNotify.requestBody(CliRequest(id: "r", key: "k", kind: .question, summary: "摘要", expiresAt: 1)), "摘要")
        XCTAssertEqual(CliNotify.requestBody(CliRequest(id: "r", key: "k", kind: .question, summary: "  ", expiresAt: 1)), "等你处理")
        let long = CliNotify.requestBody(CliRequest(id: "r", key: "k", kind: .question, summary: String(repeating: "长", count: 200), expiresAt: 1))
        XCTAssertEqual(long.count, 80)
        XCTAssertTrue(long.hasSuffix("…"))
    }

    // MARK: HTTP client

    func testClientRoutes() async throws {
        let core = StubCore()
        core.handle { r in
            switch (r.method, r.path) {
            case ("GET", "/api/cli-agents"): return .json(["devices": [], "sessions": [cliSessionJSON()], "requests": []])
            case ("GET", "/api/cli-agents/items"): return .json(["items": [["id": "1", "ts": 1, "kind": "assistant", "text": "hi"]], "more": true])
            case ("GET", "/api/cli-agents/requests"): return .json(["requests": [["id": "r1", "key": "k", "kind": "permission", "tool": "T", "summary": "s", "createdAt": 1, "expiresAt": 2]]])
            case ("POST", "/api/cli-agents/start"): return .json(["key": "d1:claude:new"])
            case ("POST", "/api/cli-agents/continue"): return .json(["key": "d1:claude:next"])
            case ("POST", "/api/cli-agents/send"): return .json(["turn": 3, "started": true])
            case ("POST", "/api/cli-agents/interrupt"): return .json(["outcome": "sent"])
            case ("POST", "/api/cli-agents/open-local"), ("POST", "/api/cli-agents/hide"): return .json(["ok": true])
            case ("POST", "/api/cli-agents/answer"): return .json(["outcome": "delivered"])
            case ("POST", "/api/cli-agents/fork"): return .json(["botId": "b1", "conversationId": "c1"])
            case ("GET", "/api/cli-agents/supervision"), ("PUT", "/api/cli-agents/supervision"): return .json(["defaults": ["transientRetry": true], "global": ["wakeup": true], "workspaces": [], "actions": []])
            default: return .json(["error": "unhandled"], status: 404)
            }
        }
        let client = core.client(token: "secret")
        let snapshot = try await client.cliSnapshot()
        XCTAssertEqual(snapshot.sessions.count, 1)
        XCTAssertEqual(core.recorded("/api/cli-agents").first?.headers["Authorization"], "Bearer secret")
        let page = try await client.cliItems(key: "d1:claude:s1", before: "7")
        XCTAssertTrue(page.more)
        XCTAssertEqual(core.recorded("/api/cli-agents/items").first?.query, "key=d1:claude:s1&before=7")
        let pending = try await client.cliRequests(key: "k")
        XCTAssertEqual(pending.map(\.id), ["r1"])
        let started = try await client.cliStart(deviceId: "d1", engine: .codex, cwd: "/work")
        XCTAssertEqual(started, "d1:claude:new")
        XCTAssertEqual(core.recorded("/api/cli-agents/start").first?.json as? [String: String], ["deviceId": "d1", "engine": "codex", "cwd": "/work"])
        let next = try await client.cliContinue(key: "k")
        XCTAssertEqual(next, "d1:claude:next")
        try await client.cliSend(key: "k", text: "你好")
        XCTAssertEqual(core.recorded("/api/cli-agents/send").first?.json as? [String: String], ["key": "k", "text": "你好"])
        try await client.cliInterrupt(key: "k")
        try await client.cliOpenLocal(key: "k")
        try await client.cliHide(key: "k", hidden: true)
        XCTAssertEqual(core.recorded("/api/cli-agents/hide").first?.json["hidden"] as? Bool, true)
        try await client.cliAnswer(id: "r1", decision: .allow, answers: ["选哪个": "甲, 丙"])
        let answer = core.recorded("/api/cli-agents/answer").first?.json
        XCTAssertEqual(answer?["decision"] as? String, "allow")
        XCTAssertEqual(answer?["answers"] as? [String: String], ["选哪个": "甲, 丙"])
        try await client.cliAnswer(id: "r2", decision: .deny)
        XCTAssertNil(core.recorded("/api/cli-agents/answer").last?.json["answers"], "no answers key for a plain decision")
        let fork = try await client.cliFork(key: "k", botId: "b1")
        XCTAssertEqual(fork, CliForkResult(botId: "b1", conversationId: "c1"))
        let supervision = try await client.cliSupervision()
        XCTAssertEqual(supervision.settings, CliSupervisionSettings(transientRetry: true, usageLimit: false, wakeup: true))
        _ = try await client.cliSaveSupervision(usageLimit: true)
        let put = core.recorded("/api/cli-agents/supervision").last
        XCTAssertEqual(put?.method, "PUT")
        XCTAssertEqual((put?.json["settings"] as? [String: Bool]), ["usageLimit": true])
        XCTAssertEqual(put?.headers["Authorization"], "Bearer secret")
    }

    func testClientErrorsCarryCoreCode() async {
        let core = StubCore()
        core.handle { _ in .json(["error": "这个会话正在电脑上运行", "code": "open_elsewhere"], status: 409) }
        do { try await core.client().cliSend(key: "k", text: "x"); XCTFail("expected a failure") } catch {
            let e = CoreError.wrap(error)
            XCTAssertEqual(e.code, "open_elsewhere"); XCTAssertEqual(e.status, 409)
            XCTAssertEqual(CliErrorText.text(for: e), "这个会话正在电脑上运行")
            XCTAssertEqual(CliAgentsModel.answerErrorText(CoreError(kind: .http, message: "x", status: 404, code: "not_found")), "请求已处理或已过期")
            XCTAssertEqual(CliAgentsModel.forkErrorText(CoreError(kind: .http, message: "", status: 404, code: "not_found")), "没有可交接的记录")
        }
    }

    func testStreamRequest() {
        let https = StubCore().client(token: "tok").cliStreamRequest()
        XCTAssertEqual(https?.url?.scheme, "wss")
        XCTAssertEqual(https?.url?.path, "/api/cli-agents/stream")
        XCTAssertEqual(https?.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertNil(StubCore().client(token: nil).cliStreamRequest())
        let local = CoreClient(origin: try! CoreOrigin("http://192.168.1.5:3000"), token: "t").cliStreamRequest()
        XCTAssertEqual(local?.url?.absoluteString, "ws://192.168.1.5:3000/api/cli-agents/stream")
    }
}

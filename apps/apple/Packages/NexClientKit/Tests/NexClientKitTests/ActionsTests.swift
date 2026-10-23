import XCTest
@testable import NexClientKit

nonisolated(unsafe) private let fullState: [String: Any] = [
    "sync": syncJSON(),
    "bots": [
        ["id": "b1", "name": "工作助手", "instructions": "整理信息", "version": 3, "read_seq": 2, "appearance_json": "{\"kind\":\"portrait\",\"id\":\"fox\"}", "appearance_version": 4,
         "policy_version": 5, "policy_json": "{\"tools\":[\"memory.search\",\"device.exec\"]}", "expertise_json": "[\"写作\",\"检索\"]", "unread_count": 1],
        ["id": "b2", "name": "研究伙伴", "version": 1, "policy_version": 1, "policy_json": "{\"tools\":[]}", "expertise_json": "[]"],
    ],
    "approvals": [], "tasks": [],
    "conversations": [],
    "routines": [["id": "r1", "bot_id": "b1", "name": "每日计划", "prompt": "做计划", "schedule_kind": "daily", "interval_ms": NSNull(), "local_time": "09:00", "time_zone": "Asia/Shanghai", "enabled": 1, "next_due_at": 1_760_000_000_000, "version": 7, "created_at": 1],
                 ["id": "r2", "bot_id": "b1", "name": "间隔", "prompt": "p", "schedule_kind": "interval", "interval_ms": 1_800_000, "local_time": NSNull(), "time_zone": "UTC", "enabled": 0, "next_due_at": NSNull(), "version": 2, "created_at": 2],
                 ["id": "r3", "bot_id": "b1", "name": "一次", "prompt": "p", "schedule_kind": "once", "enabled": 1, "version": 1]],
    "occurrences": [["id": "o1", "routine_id": "r1", "routine_version": 7, "scheduled_at": 1_760_000_000_000, "status": "succeeded", "task_id": "t1", "created_at": 1, "bot_id": "b1", "name": "每日计划"]],
    "connectors": [["id": "c1", "name": "团队库", "url": "http://127.0.0.1:9/mcp", "transport": "http", "enabled": true, "version": 6, "hasToken": true,
                    "tools": [["name": "echo", "description": "回显", "inputSchema": ["type": "object"]], ["name": "q", "inputSchema": ["type": "object"]]],
                    "checkedAt": 1_760_000_000_000, "error": NSNull(), "grants": [["botId": "b1", "tools": ["echo"]]]]],
    "devices": [["id": "d1", "name": "Mac", "status": "bound", "capabilities_json": "[\"exec\"]"], ["id": "d2", "name": "旧", "status": "revoked"]],
    "onlineDevices": ["d1"],
    "memories": [["id": "m1", "scope": "bot", "bot_id": "b1", "title": "偏好", "version": 4, "updated_at": 1_760_000_000_000, "content": "喜欢短句"],
                 ["id": "m2", "scope": "workspace", "bot_id": NSNull(), "title": "共享", "version": 1, "updated_at": 1_760_000_000_000, "content": "x"],
                 ["id": "m3", "scope": "bot", "bot_id": "b2", "title": "他人", "version": 1, "updated_at": 1, "content": "y"]],
    "journal": [["task_id": "t1", "bot_id": "b1", "objective": "目标", "result": "结果", "created_at": 1_760_000_000_000]],
    "usage": [["bot_id": "b1", "calls": 3, "input_tokens": 1200, "output_tokens": 80]],
    "config": ["id": "default", "provider_id": "openai", "endpoint": "https://api.example.com/v1", "default_model": "m", "configured": true],
    "node": ["status": "ready", "origin": "http://x", "root": "/tmp/r", "exec": true, "computer": false, "computerSupported": false, "deviceId": "d1", "connected": true,
             "unknownCalls": [["call_id": "k1", "capability": "device.exec", "arguments_json": "{\"command\":\"ls\"}", "version": 9]], "hosted": false],
    "memoryEngine": ["provider": "hindsight", "release": "0.10", "status": "connected", "revision": "rev1", "forgetting": 0, "pending": 2, "failed": 0, "quarantined": 1, "error": NSNull(), "service": "ready"],
    "memoryPlugin": ["providers": [["id": "hindsight", "name": "Hindsight", "protocol": "HTTP API v1 · 0.10.3"]], "provider": "hindsight", "enabled": true, "endpoint": "https://m.example", "hasToken": true, "restartRequired": true, "status": "ready", "error": NSNull()],
    "directory": [["id": "x"]], "hostDeviceId": "d1", "address": "http://127.0.0.1:1", "dataDir": "/data", "runtime": "Pi 1.0.4", "lanEnabled": true,
    "delegations": [["id": "g1", "call_id": "c", "parent_task_id": "t1", "sender_bot_id": "b1", "receiver_bot_id": "b2", "child_task_id": "t2", "depth": 1, "status": "running"]],
]

@MainActor
final class ActionsTests: XCTestCase {
    func makeStore(_ core: StubCore) -> WorkspaceStore {
        WorkspaceStore(client: core.client(), timing: SyncTiming(debounce: 0.01, fallbackInterval: 100, backoff: Backoff(initial: 0.01, maximum: 0.01)))
    }
    /// Returns the canned state for `/api/state`, `response` for everything else.
    func loaded(_ response: @escaping @Sendable (RecordedRequest) -> StubResponse = { _ in .json(["ok": true]) }) async -> (StubCore, WorkspaceStore) {
        let core = StubCore()
        core.handle { r in r.path == "/api/state" ? .json(fullState) : response(r) }
        let store = makeStore(core); await store.refresh()
        return (core, store)
    }

    // MARK: DTOs

    func testDecodesFullState() async throws {
        let (_, store) = await loaded()
        let s = try XCTUnwrap(store.state)
        let b = s.bots[0]
        XCTAssertEqual([b.version, b.policyVersion, b.appearanceVersion], [3, 5, 4])
        XCTAssertEqual(b.policyTools, ["memory.search", "device.exec"]); XCTAssertEqual(b.expertise, ["写作", "检索"])
        XCTAssertEqual(b.appearanceJSON, "{\"kind\":\"portrait\",\"id\":\"fox\"}"); XCTAssertEqual(s.bots[1].policyTools, [])
        XCTAssertEqual(s.routines.map(\.label), ["每天 09:00 · Asia/Shanghai", "每 30 分钟", "一次性任务"])
        XCTAssertEqual(s.routines[0].version, 7); XCTAssertTrue(s.routines[0].enabled); XCTAssertFalse(s.routines[1].enabled); XCTAssertNil(s.routines[1].nextDueAt)
        XCTAssertEqual(s.occurrences[0].statusText, "已完成"); XCTAssertEqual(s.occurrences(botID: "b1").count, 1)
        let c = s.connectors[0]
        XCTAssertEqual(c.version, 6); XCTAssertTrue(c.hasToken); XCTAssertEqual(c.tools.map(\.name), ["echo", "q"])
        XCTAssertEqual(c.tools[1].displayDescription, "服务未提供工具说明"); XCTAssertEqual(c.grant(for: "b1")?.tools, ["echo"])
        XCTAssertEqual(c.subtitle, "2 个工具"); XCTAssertEqual(c.statusChip, "连接测试通过"); XCTAssertNil(c.error)
        XCTAssertEqual(s.connectors(grantedTo: "b1").count, 1); XCTAssertEqual(s.connectors(grantedTo: "b2").count, 0); XCTAssertEqual(s.enabledConnectorCount, 1)
        XCTAssertEqual(s.devices.map(\.online), [true, false]); XCTAssertEqual(s.devices[1].statusText, "已撤销"); XCTAssertEqual(s.boundDevices.count, 1)
        XCTAssertEqual(s.onlineDeviceCount, 1); XCTAssertTrue(s.isHost(s.devices[0]))
        XCTAssertEqual(s.memories(botID: "b1").map(\.id), ["m1", "m2"]); XCTAssertEqual(s.memories[1].scopeLabel, "所有 Agent 共享")
        XCTAssertEqual(s.journal(botID: "b1")[0].result, "结果"); XCTAssertEqual(s.usage(botID: "b1").inputTokens, 1200); XCTAssertEqual(s.usage(botID: "zz").calls, 0)
        XCTAssertEqual(s.config?.defaultModel, "m"); XCTAssertEqual(s.config?.providerID, "openai")
        XCTAssertEqual(s.node?.unknownCalls.first?.version, 9); XCTAssertEqual(s.node?.root, "/tmp/r"); XCTAssertFalse(s.node?.hosted ?? true)
        XCTAssertEqual(s.node?.summary, "连接状态：ready · 终端可用 · 窗口控制暂不支持")
        XCTAssertEqual(s.memoryEngine?.footnote, "Hindsight 语义记忆已连接。 2 项待同步。 部分记忆正在清理或更新，旧的派生结果已暂停读取。")
        XCTAssertEqual(s.memoryPlugin?.statusLabel, "已连接"); XCTAssertEqual(s.memoryPlugin?.providers.first?.protocolName, "HTTP API v1 · 0.10.3"); XCTAssertTrue(s.memoryPlugin?.restartRequired ?? false)
        XCTAssertEqual(s.hostDeviceID, "d1"); XCTAssertEqual(s.address, "http://127.0.0.1:1"); XCTAssertEqual(s.dataDir, "/data"); XCTAssertEqual(s.runtime, "Pi 1.0.4"); XCTAssertTrue(s.lanEnabled)
        XCTAssertEqual(s.directory.count, 1); XCTAssertEqual(s.delegations[0].receiverBotID, "b2")
    }

    func testStateWithoutOptionalFieldsDecodes() async throws {
        let core = StubCore(); core.handle { _ in .json(stateJSON()) }
        let store = makeStore(core); await store.refresh()
        let s = try XCTUnwrap(store.state)
        XCTAssertNil(s.config); XCTAssertNil(s.node); XCTAssertNil(s.memoryPlugin); XCTAssertTrue(s.connectors.isEmpty); XCTAssertEqual(s.bots[0].version, 1)
    }

    func testPeersAwaitingApproval() {
        var s = WorkspaceState(sync: SyncIdentity(cursor: 1, privacyEpoch: 0, coreId: "c", bootId: "b"))
        s.tasks = [AgentTask(row: ["id": .string("t1"), "bot_id": .string("b1"), "status": .string("running"), "ended_at": .null])]
        s.delegations = [Delegation(row: ["parent_task_id": .string("t1"), "receiver_bot_id": .string("b2"), "child_task_id": .string("t2")])]
        s.approvals = [Approval(row: ["id": .string("a"), "task_id": .string("t2"), "bot_id": .string("b2")])]
        XCTAssertEqual(s.peersAwaitingApproval(for: "b1"), ["b2"])
    }

    func testPreviewAndLabels() {
        let tool = PreviewItem(row: ["kind": "tool", "id": "c1", "title": "device.read", "status": "succeeded", "arguments": "{\"a\":1}", "content": "x", "createdAt": 1_760_000_000_000])
        XCTAssertEqual(tool.displayTitle, "读取设备文件"); XCTAssertTrue(tool.subtitle.hasPrefix("已完成 · "))
        let file = PreviewItem(row: ["kind": "file", "path": "a/b.md", "title": "b.md", "exists": true, "size": 12, "content": "hi"])
        XCTAssertEqual(file.subtitle, "a/b.md · 12 B")
        XCTAssertEqual(PreviewItem.fallback(step: ToolStep(row: ["id": "s", "tool_name": "x", "status": "failed", "preview": ""])).content, "暂无输出内容")
        XCTAssertTrue(FilePathMatcher.isFilePath("src/App.TSX")); XCTAssertTrue(FilePathMatcher.isFilePath("a\\b.json")); XCTAssertFalse(FilePathMatcher.isFilePath("run it.md")); XCTAssertFalse(FilePathMatcher.isFilePath("x.exe"))
        XCTAssertEqual(PolicyCatalog.serverOrder.count, 28); XCTAssertEqual(Set(PolicyCatalog.uiOrder.map(\.id)), Set(PolicyCatalog.serverOrder)); XCTAssertEqual(PolicyCatalog.uiOrder.count, 28)
        XCTAssertEqual(PolicyCatalog.orderedTools(["future.action", "attachment.read", "device.exec"]), ["device.exec", "attachment.read", "future.action"])
        XCTAssertEqual(PolicyCatalog.label(for: "device.exec"), "执行设备终端命令")
        XCTAssertEqual(AvatarCatalog.portraits.count, 20); XCTAssertEqual(Set(AvatarCatalog.portraits.map(\.id)), Set(AgentCatalogIDs.portraits))
        XCTAssertEqual(AvatarCatalog.companionName(shape: "bean", color: "clay"), "陶红豆荚")
        XCTAssertEqual(MemoryLabels.sourceClass("peer_reported"), "同伴转述"); XCTAssertEqual(MemoryLabels.sourceClass("other"), "other")
    }

    func testTimeFormats() {
        let tz = TimeZone(identifier: "Asia/Shanghai")!
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        let t = cal.date(from: DateComponents(year: 2026, month: 3, day: 7, hour: 9, minute: 5))!
        XCTAssertEqual(TimeFormat.formatTime(t, timeZone: tz), "3/7 09:05")
        let now = t.addingTimeInterval(3600)
        XCTAssertEqual(TimeFormat.formatShortTime(t, now: now, timeZone: tz), "09:05")
        XCTAssertEqual(TimeFormat.formatShortTime(t, now: now.addingTimeInterval(2 * 86400), timeZone: tz), "3/7")
        XCTAssertEqual(TimeFormat.dayLabel(t, now: now, timeZone: tz), "今天")
        XCTAssertEqual(TimeFormat.dayLabel(t, now: now.addingTimeInterval(86400), timeZone: tz), "昨天")
        XCTAssertEqual(TimeFormat.dayLabel(t, now: now.addingTimeInterval(5 * 86400), timeZone: tz), "3月7日")
    }

    // MARK: Requests

    func testAgentCalls() async throws {
        let (core, store) = await loaded { r in r.path == "/api/bots" ? .json(["id": "new1"]) : .json(["ok": true]) }
        let id = try await store.createAgent(name: "新", instructions: "说明")
        XCTAssertEqual(id, "new1"); XCTAssertEqual(core.recorded("/api/bots")[0].json["name"] as? String, "新"); XCTAssertEqual(core.recorded("/api/bots")[0].method, "POST")
        try await store.updateIdentity(botID: "b1", name: "改名", instructions: "新说明")
        var j = core.recorded("/api/bots/update")[0].json
        XCTAssertEqual(j["id"] as? String, "b1"); XCTAssertEqual(j["version"] as? Int, 3); XCTAssertEqual(j["name"] as? String, "改名"); XCTAssertNil(j["expertise"])
        try await store.updateIdentity(botID: "b1", name: "n", instructions: "", expertise: ["a"])
        j = core.recorded("/api/bots/update")[1].json; XCTAssertEqual(j["expertise"] as? [String], ["a"])
        try await store.updateAppearance(botID: "b1", .companion(shape: "bean", color: "clay"))
        j = core.recorded("/api/bots/appearance")[0].json
        XCTAssertEqual(j["version"] as? Int, 4); XCTAssertEqual((j["appearance"] as? [String: String]), ["kind": "companion", "shape": "bean", "color": "clay"])
        try await store.updateAppearance(botID: "b2", .portrait("fox"))
        j = core.recorded("/api/bots/appearance")[1].json
        XCTAssertEqual(j["version"] as? Int, 0); XCTAssertEqual((j["appearance"] as? [String: String]), ["kind": "portrait", "id": "fox"])
        try await store.updatePolicy(botID: "b1", tools: ["memory.search"])
        j = core.recorded("/api/bots/policy")[0].json; XCTAssertEqual(j["version"] as? Int, 5); XCTAssertEqual(j["tools"] as? [String], ["memory.search"])
        try await store.archiveAgent(botID: "b1")
        j = core.recorded("/api/bots/archive")[0].json; XCTAssertEqual(j["version"] as? Int, 3); XCTAssertEqual(j["id"] as? String, "b1")
        try await store.resumeTask("t9"); XCTAssertEqual(core.recorded("/api/resume")[0].json["taskId"] as? String, "t9")
        XCTAssertGreaterThan(core.recorded("/api/state").count, 6, "every mutation refreshes")
        do { try await store.updatePolicy(botID: "gone", tools: []); XCTFail() } catch let e as CoreError { XCTAssertEqual(e.message, "Agent 不存在") }
    }

    func testRoutineBodies() async throws {
        let (core, store) = await loaded { r in r.path == "/api/routines" ? .json(["id": "r9"]) : .json(["ok": true]) }
        let rid = try await store.saveRoutine(botID: "b1", name: "A", prompt: "P", schedule: .daily(localTime: "08:30"), timeZone: "Asia/Shanghai")
        XCTAssertEqual(rid, "r9")
        var j = core.recorded("/api/routines")[0].json
        XCTAssertEqual(j["scheduleKind"] as? String, "daily"); XCTAssertEqual(j["localTime"] as? String, "08:30"); XCTAssertEqual(j["botId"] as? String, "b1")
        XCTAssertNil(j["id"]); XCTAssertNil(j["version"]); XCTAssertNil(j["intervalMinutes"]); XCTAssertNil(j["runAt"]); XCTAssertEqual(j["timeZone"] as? String, "Asia/Shanghai")
        let existing = try XCTUnwrap(store.state?.routines.first { $0.id == "r2" })
        _ = try await store.saveRoutine(botID: "b1", existing: existing, name: "A", prompt: "P", schedule: .interval(minutes: 45))
        j = core.recorded("/api/routines")[1].json
        XCTAssertEqual(j["id"] as? String, "r2"); XCTAssertEqual(j["version"] as? Int, 2); XCTAssertEqual(j["intervalMinutes"] as? Int, 45); XCTAssertNil(j["localTime"])
        _ = try await store.saveRoutine(botID: "b1", name: "A", prompt: "P", schedule: .once(at: Date(timeIntervalSince1970: 1_800_000_000.5)))
        j = core.recorded("/api/routines")[2].json; XCTAssertEqual(j["scheduleKind"] as? String, "once"); XCTAssertEqual(j["runAt"] as? Int, 1_800_000_000_500)
        try await store.setRoutineEnabled(existing, enabled: true)
        j = core.recorded("/api/routines/toggle")[0].json; XCTAssertEqual(j["version"] as? Int, 2); XCTAssertEqual(j["enabled"] as? Bool, true)
        try await store.runRoutine(existing, clientID: "cid-1")
        j = core.recorded("/api/routines/run")[0].json; XCTAssertEqual(j["clientId"] as? String, "cid-1"); XCTAssertNil(j["version"])
    }

    func testConnectorCalls() async throws {
        let (core, store) = await loaded { r in
            switch r.path { case "/api/connectors/save": .json(["id": "c9"]); case "/api/connectors/test": .json(["ok": true, "count": 2]); default: .json(["ok": true]) }
        }
        let new = try await store.saveConnector(name: "N", url: "http://127.0.0.1:1/mcp", transport: "sse", token: "")
        XCTAssertEqual(new, "c9")
        var j = core.recorded("/api/connectors/save")[0].json
        XCTAssertEqual(j["token"] as? String, ""); XCTAssertEqual(j["enabled"] as? Bool, true); XCTAssertEqual(j["transport"] as? String, "sse"); XCTAssertNil(j["id"]); XCTAssertNil(j["clearToken"])
        let c = store.state!.connectors[0]
        _ = try await store.saveConnector(existing: c, name: "团队库", url: c.url, transport: "http", token: "", clearToken: true)
        j = core.recorded("/api/connectors/save")[1].json
        XCTAssertEqual(j["id"] as? String, "c1"); XCTAssertEqual(j["version"] as? Int, 6); XCTAssertEqual(j["clearToken"] as? Bool, true)
        let count = try await store.testConnector("c1"); XCTAssertEqual(count, 2)
        XCTAssertEqual(core.recorded("/api/connectors/test")[0].json["version"] as? Int, 6)
        try await store.grantConnector("c1", botID: "b2", tools: ["echo"])
        j = core.recorded("/api/connectors/grant")[0].json; XCTAssertEqual(j["botId"] as? String, "b2"); XCTAssertEqual(j["tools"] as? [String], ["echo"]); XCTAssertEqual(j["version"] as? Int, 6)
        try await store.setConnectorEnabled("c1", enabled: false)
        j = core.recorded("/api/connectors/toggle")[0].json; XCTAssertEqual(j["enabled"] as? Bool, false); XCTAssertEqual(j["version"] as? Int, 6)
        try await store.removeConnector("c1")
        j = core.recorded("/api/connectors/delete")[0].json; XCTAssertEqual(j["id"] as? String, "c1"); XCTAssertEqual(j["version"] as? Int, 6)
    }

    func testTestConnectorFailureStillRefreshes() async throws {
        let (core, store) = await loaded { r in r.path == "/api/connectors/test" ? .json(["error": "连接失败，请检查服务地址、认证信息及 MCP 工具目录。"], status: 400) : .json(["ok": true]) }
        let before = core.recorded("/api/state").count
        do { _ = try await store.testConnector("c1"); XCTFail() } catch let e as CoreError { XCTAssertEqual(e.message, "连接失败，请检查服务地址、认证信息及 MCP 工具目录。"); XCTAssertEqual(e.status, 400) }
        XCTAssertGreaterThan(core.recorded("/api/state").count, before)
    }

    func testDeviceNodeSettingsCalls() async throws {
        let (core, store) = await loaded { r in
            switch r.path {
            case "/api/devices": .json(["deviceId": "d9", "token": "tkn"])
            case "/api/node": .json(["status": "ready", "root": "/x"])
            case "/api/plugins/memory": .json(["provider": "hindsight", "enabled": true, "restartRequired": true, "providers": [], "status": "connecting"])
            case "/api/plugins/memory/test": .json(["ok": true, "provider": "hindsight"])
            default: .json(["ok": true])
            }
        }
        let pair = try await store.pairDevice(name: "手机"); XCTAssertEqual(pair.deviceID, "d9"); XCTAssertEqual(pair.token, "tkn")
        XCTAssertEqual(core.recorded("/api/devices")[0].json["name"] as? String, "手机")
        try await store.revokeDevice("d9"); XCTAssertEqual(core.recorded("/api/devices/revoke")[0].json["id"] as? String, "d9")
        let node = try await store.configureNode(root: "/x"); XCTAssertEqual(node.root, "/x"); XCTAssertEqual(core.recorded("/api/node")[0].json["root"] as? String, "/x")
        try await store.reconcileNodeCall("k1")
        let j = core.recorded("/api/node/reconcile")[0].json; XCTAssertEqual(j["callId"] as? String, "k1"); XCTAssertEqual(j["version"] as? Int, 9)
        do { try await store.reconcileNodeCall("nope"); XCTFail() } catch let e as CoreError { XCTAssertEqual(e.message, "调用状态已变化") }
        try await store.saveModel(provider: "anthropic", model: "m", endpoint: "https://api.anthropic.com", apiKey: "")
        var c = core.recorded("/api/config")[0].json; XCTAssertEqual(c["provider"] as? String, "anthropic"); XCTAssertNil(c["apiKey"])
        try await store.saveModel(provider: "openai", model: "m", endpoint: "e", apiKey: "k")
        c = core.recorded("/api/config")[1].json; XCTAssertEqual(c["apiKey"] as? String, "k")
        let plugin = try await store.saveMemoryPlugin(enabled: true, endpoint: "https://m.example", token: "t")
        XCTAssertTrue(plugin.restartRequired); XCTAssertEqual(plugin.statusLabel, "连接中")
        var p = core.recorded("/api/plugins/memory")[0].json
        XCTAssertEqual(p["provider"] as? String, "hindsight"); XCTAssertEqual(p["enabled"] as? Bool, true); XCTAssertEqual(p["endpoint"] as? String, "https://m.example"); XCTAssertEqual(p["token"] as? String, "t")
        _ = try await store.saveMemoryPlugin(enabled: false)
        p = core.recorded("/api/plugins/memory")[1].json; XCTAssertNil(p["endpoint"]); XCTAssertNil(p["token"])
        let provider = try await store.testMemoryPlugin(endpoint: "https://m.example"); XCTAssertEqual(provider, "hindsight")
        XCTAssertEqual(core.recorded("/api/plugins/memory/test")[0].json["enabled"] as? Bool, true)
    }

    func testModelCatalog() async throws {
        let (core, store) = await loaded { r in
            r.path == "/api/models/list" ? .json(["models": ["gpt-a", "gpt-b"], "hasMore": true]) : .json(["ok": true])
        }
        let catalog = try await store.listModels(provider: "openai", endpoint: "https://api.example/v1")
        XCTAssertEqual(catalog.models, ["gpt-a", "gpt-b"]); XCTAssertTrue(catalog.hasMore)
        let body = core.recorded("/api/models/list")[0].json
        XCTAssertEqual(body["provider"] as? String, "openai"); XCTAssertEqual(body["endpoint"] as? String, "https://api.example/v1"); XCTAssertEqual(body["apiKey"] as? String, "")
        XCTAssertTrue(core.recorded("/api/config").isEmpty, "listing must not save")
        let (_, old) = await loaded { r in r.path == "/api/models/list" ? .json(["error": "Not found"], status: 404) : .json(["ok": true]) }
        do { _ = try await old.listModels(provider: "openai", endpoint: "https://api.example/v1"); XCTFail() }
        catch let e as CoreError { XCTAssertEqual(e.message, "当前服务暂不支持获取模型列表，请手动填写模型 ID") }
    }

    func testMemoryCalls() async throws {
        let (core, store) = await loaded { r in
            switch r.path {
            case "/api/memory": .json(["documentId": "m9", "version": 5, "saved": true])
            case "/api/memory/recall": .json(["status": "available", "facts": [["ref": "r1", "refs": ["r1", "r2"], "scope": "workspace", "text": "事实", "sourceClass": "user_stated"]]])
            case "/api/memory/reflect": .json(["status": "available", "answers": [["scope": "bot", "text": "答案", "refs": ["r1"]]]])
            case "/api/memory/expand": .json(["ref": "r1", "sourceClass": "user_stated", "content": "原文", "contentHash": "h"])
            case "/api/memory/forget-preview": .json(["documents": ["a", "b"], "messages": ["m"], "tasks": [], "bots": ["b1", "gone"], "revision": "rev9", "sources": [], "banks": [], "hashes": [], "selectorHash": "s"])
            case "/api/memory/forget": .json(["id": "f", "status": "cleaning", "documents": 2, "messages": 1])
            case "/api/preview": .json(["kind": "file", "path": "a.md", "title": "a.md", "exists": true, "size": 3, "content": "abc"])
            default: .json(["ok": true])
            }
        }
        let saved = try await store.saveMemory(botID: "b1", title: "T", content: "C", scope: "workspace")
        XCTAssertEqual(saved.documentID, "m9"); XCTAssertEqual(saved.version, 5)
        var j = core.recorded("/api/memory")[0].json
        XCTAssertEqual(j["expectedVersion"] as? Int, 0); XCTAssertEqual(j["scope"] as? String, "workspace"); XCTAssertNil(j["documentId"])
        let shared = store.state!.memories[1]
        _ = try await store.saveMemory(botID: "b1", existing: shared, title: "T2", content: "C2", scope: "bot")
        j = core.recorded("/api/memory")[1].json
        XCTAssertEqual(j["documentId"] as? String, "m2"); XCTAssertEqual(j["expectedVersion"] as? Int, 1); XCTAssertEqual(j["scope"] as? String, "workspace"); XCTAssertEqual(j["botId"] as? String, "b1")
        _ = try await store.saveMemory(botID: "b1", existing: store.state!.memories[0], title: "T", content: "C")
        j = core.recorded("/api/memory")[2].json; XCTAssertEqual(j["expectedVersion"] as? Int, 4); XCTAssertEqual(j["scope"] as? String, "bot")
        try await store.deleteMemory(store.state!.memories[0])
        j = core.recorded("/api/memory/delete")[0].json; XCTAssertEqual(j["id"] as? String, "m1"); XCTAssertEqual(j["version"] as? Int, 4)

        let stateCalls = core.recorded("/api/state").count
        let recall = try await store.recallMemory(botID: "b1", query: "约束")
        XCTAssertEqual(recall.statusText, "检索完成"); XCTAssertEqual(recall.facts[0].caption, "共享 · 用户陈述"); XCTAssertEqual(recall.facts[0].refs, ["r1", "r2"])
        XCTAssertEqual(core.recorded("/api/memory/recall")[0].json["query"] as? String, "约束")
        let reflect = try await store.reflectMemory(botID: "b1", query: "总结")
        XCTAssertEqual(reflect.answers[0].caption, "私有记忆综合"); XCTAssertEqual(reflect.statusText, "综合完成")
        let expanded = try await store.expandMemory(botID: "b1", ref: "r1"); XCTAssertEqual(expanded.content, "原文")
        XCTAssertEqual(core.recorded("/api/memory/expand")[0].json["ref"] as? String, "r1")
        let preview = try await store.previewForget(botID: "b1", query: "q")
        XCTAssertEqual(preview.confirmationDetail(botNames: ["b1": "工作助手"]), "将清理 2 条记忆、1 条消息，并停止及清理 0 项相关工作。受影响的 Agent：工作助手、已归档 Agent。混合多个来源的回复会整条清理。")
        XCTAssertEqual(core.recorded("/api/state").count, stateCalls, "read-only calls do not refresh")
        let result = try await store.forget(botID: "b1", query: "q", preview: preview)
        XCTAssertEqual(result.statusText, "原文已清理，正在清理引擎派生记忆。完成前旧 bank 不可读取。")
        let f = core.recorded("/api/memory/forget")[0].json; XCTAssertEqual(f["revision"] as? String, "rev9"); XCTAssertEqual(f["query"] as? String, "q")
        let file = try await store.previewFile(path: "dir/a b.md"); XCTAssertEqual(file.content, "abc")
        XCTAssertEqual(core.recorded("/api/preview").last?.method, "GET"); XCTAssertTrue(core.recorded("/api/preview").last!.query.contains("path=dir/a%20b.md"))
        _ = try await store.previewTool(callID: "call 1"); XCTAssertTrue(core.recorded("/api/preview").last!.query.hasPrefix("callId="))
    }

    func testReflectUsesLongTimeout() throws {
        let core = StubCore().client()
        let r = try core.request("/api/memory/reflect", query: [], body: Data(), timeout: 130)
        XCTAssertEqual(r.timeoutInterval, 130)
    }

    // MARK: Errors

    func testErrorsPropagateAndSessionEnds() async throws {
        let (core, store) = await loaded { r in r.path == "/api/bots/archive" ? .json(["error": "请先停止并核对该 Agent 的未结束工作"], status: 400) : r.path == "/api/devices" ? .json(["error": "登录已失效，请重新登录"], status: 401) : .json(["ok": true]) }
        _ = core
        do { try await store.archiveAgent(botID: "b1"); XCTFail() } catch let e as CoreError { XCTAssertEqual(e.message, "请先停止并核对该 Agent 的未结束工作"); XCTAssertEqual(e.status, 400) }
        XCTAssertFalse(store.ended)
        var ended: SessionEnd?
        store.onSessionEnded = { ended = $0 }
        do { _ = try await store.pairDevice(name: "x"); XCTFail() } catch let e as CoreError { XCTAssertEqual(e.status, 401) }
        XCTAssertEqual(ended?.message, WorkspaceStore.expiredMessage); XCTAssertTrue(store.ended)
    }

    // MARK: Export

    func testExportTranscript() async throws {
        let core = StubCore()
        let tz = TimeZone(identifier: "UTC")!
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        let t0 = cal.date(from: DateComponents(year: 2026, month: 1, day: 5, hour: 9, minute: 7))!.timeIntervalSince1970 * 1000
        func msg(_ seq: Int, _ role: String, _ content: String, extra: [String: Any] = [:]) -> [String: Any] {
            ["id": "m\(seq)", "bot_id": "b1", "seq": seq, "role": role, "kind": "message", "content": content, "created_at": t0 + Double(seq) * 60_000].merging(extra) { $1 }
        }
        core.handle { r in
            switch r.path {
            case "/api/state": return .json(fullState)
            case "/api/agents/messages":
                return .json(["sync": syncJSON(), "hasMore": false, "streaming": [], "messages": [msg(1, "user", "你好"), msg(2, "assistant", "收到"), msg(3, "system", "开始"), msg(4, "peer", "报告", extra: ["a2a_peer_id": "b2"]), msg(5, "peer", "未知", extra: ["a2a_peer_id": "zz"])]])
            default: return .json(["ok": true])
            }
        }
        let store = makeStore(core)
        XCTAssertNil(store.exportTranscript(botID: "b1"))
        store.select("b1"); await store.refresh()
        let text = try XCTUnwrap(store.exportTranscript(botID: "b1", timeZone: tz))
        XCTAssertEqual(text, "[1/5 09:08] 我: 你好\n\n[1/5 09:09] 工作助手: 收到\n\n[1/5 09:10] 系统: 开始\n\n[1/5 09:11] 研究伙伴: 报告\n\n[1/5 09:12] 同伴 Agent: 未知")
    }

    // MARK: Preferences

    func testContactPreferencesPersist() {
        let suite = "nexbot.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!; defer { defaults.removePersistentDomain(forName: suite) }
        var prefs: ContactPreferences? = ContactPreferences(defaults: defaults)
        XCTAssertTrue(prefs!.motionEnabled); XCTAssertNil(prefs!.selectedAgentID); XCTAssertFalse(prefs!.isPinned("b1"))
        prefs!.togglePin("b2"); prefs!.togglePin("b1"); prefs!.togglePin("b2")
        prefs!.motionEnabled = false; prefs!.selectedAgentID = "b1"
        XCTAssertEqual(defaults.string(forKey: "nexbot.pinnedAgents"), "[\"b1\"]"); XCTAssertEqual(defaults.string(forKey: "nexbot.motion"), "0"); XCTAssertEqual(defaults.string(forKey: "nexbot.selectedAgent"), "b1")
        prefs = nil
        let again = ContactPreferences(defaults: defaults)
        XCTAssertEqual(again.pinnedIDs, ["b1"]); XCTAssertFalse(again.motionEnabled); XCTAssertEqual(again.selectedAgentID, "b1")
        let bots = [Bot(row: ["id": "b1", "name": "Alpha", "instructions": "写作"]), Bot(row: ["id": "b2", "name": "Beta", "instructions": "研究"])]
        let g = again.groups(of: bots); XCTAssertEqual(g.pinned.map(\.id), ["b1"]); XCTAssertEqual(g.rest.map(\.id), ["b2"])
        XCTAssertEqual(again.groups(of: bots, query: "研究").rest.map(\.id), ["b2"]); XCTAssertTrue(again.groups(of: bots, query: "研究").pinned.isEmpty)
    }
}

private enum AgentCatalogIDs {
    static let portraits = ["fox", "owl", "cat", "bear", "rabbit", "dog", "panda", "koala", "tiger", "deer", "penguin", "seal", "otter", "octopus", "frog", "robot", "astronaut", "star", "cloud", "sprout"]
}

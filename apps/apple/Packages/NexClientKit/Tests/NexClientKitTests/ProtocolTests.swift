import XCTest
@testable import NexClientKit

final class ProtocolTests: XCTestCase {
    func testOriginRules() throws {
        XCTAssertEqual(try CoreOrigin("https://bot.nexorai.com.cn").string, "https://bot.nexorai.com.cn")
        XCTAssertEqual(try CoreOrigin("https://Bot.Example.com:443/").string, "https://bot.example.com")
        XCTAssertEqual(try CoreOrigin("http://127.0.0.1:8080").string, "http://127.0.0.1:8080")
        XCTAssertEqual(try CoreOrigin("http://[::1]:3000").string, "http://[::1]:3000")
        for ok in ["http://localhost", "http://10.1.2.3", "http://192.168.0.5", "http://172.16.0.1", "http://172.31.255.1"] { XCTAssertNoThrow(try CoreOrigin(ok), ok) }
        for bad in ["http://example.com", "http://172.32.0.1", "http://172.15.0.1", "http://11.0.0.1", "http://192.169.0.1", "ftp://localhost", "https://u:p@example.com",
                    "https://example.com/path", "https://example.com/?q=1", "https://example.com/#x", "https://example.com?", "not a url", "", "http://10.0.0.256"] {
            XCTAssertThrowsError(try CoreOrigin(bad), bad)
        }
        XCTAssertTrue(try CoreOrigin("http://localhost:1").allowsPasswordLogin)
        XCTAssertTrue(try CoreOrigin("https://example.com").allowsPasswordLogin)
        XCTAssertEqual(CoreOrigin.default.string, "https://bot.nexorai.com.cn")
    }

    func testLaunchOptions() {
        let o = LaunchOptions.parse(arguments: ["app", "--profile=fx", "--origin=http://127.0.0.1:9"], environment: ["NEXBOT_PROFILE": "env", "NEXBOT_CORE_ORIGIN": "https://x.com"])
        XCTAssertEqual(o, LaunchOptions(profile: "fx", origin: "http://127.0.0.1:9"))
        let e = LaunchOptions.parse(arguments: ["app"], environment: ["NEXBOT_PROFILE": "env", "NEXBOT_CORE_ORIGIN": "https://x.com"])
        XCTAssertEqual(e, LaunchOptions(profile: "env", origin: "https://x.com"))
        XCTAssertEqual(LaunchOptions.parse(arguments: ["--profile="], environment: [:]).profile, nil)
        XCTAssertThrowsError(try LaunchOptions(origin: "http://example.com").originOverride())
    }

    func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(json.utf8)) }

    func testIdentityAndLoginDTOs() throws {
        let id = try decode(ClientIdentity.self, #"{"version":1,"coreId":"c1","mode":"connected","loginRequired":true,"initialized":true,"loginMethods":["password"],"provider":{"type":"nex-user","name":"X"}}"#)
        XCTAssertEqual(id, ClientIdentity(coreId: "c1", mode: "connected"))
        let local = try decode(ClientIdentity.self, #"{"version":1,"coreId":"c1","mode":"local-owner","loginMethods":["one-time-code"]}"#)
        XCTAssertFalse(local.loginRequired)
        let tx = try decode(LoginTransaction.self, #"{"transactionId":"t","bindingToken":"b","stepId":"s","challenge":"password","expiresAt":1760000000000}"#)
        XCTAssertEqual(tx.challenge, .string("password"))
        let session = try decode(LoginSession.self, #"{"token":"T","sessionId":"s1","expiresAt":1760000000000.0,"coreId":"c1","protocol":"native-v1","version":1}"#)
        XCTAssertEqual(session.expiresAt, 1_760_000_000_000)
        let check = try decode(SessionCheck.self, #"{"authenticated":true,"protocol":"native-v1","sessionId":"s1","coreId":"c1","expiresAt":17.5}"#)
        XCTAssertTrue(check.authenticated)
        XCTAssertThrowsError(try decode(LoginTransaction.self, #"{"transactionId":"t"}"#))
    }

    func testWorkspaceStateDecoding() throws {
        let json = """
        {"sync":{"cursor":12,"privacyEpoch":1.0,"coreId":"c1","bootId":"b"},"extra":{"a":1},
         "bots":[{"id":"b1","name":"小助手","instructions":"hi","version":3,"read_seq":4,"unread_count":2,"last_message":"你好","last_message_at":1760000000000,"policy_version":1}],
         "approvals":[{"id":"a1","argument_hash":"\(String(repeating: "f", count: 64))","expires_at":1760000099000,"tool_name":"device.exec","arguments_json":"{\\"command\\":\\"ls\\"}","bot_id":"b1","task_id":"t1","call_id":"c"}],
         "tasks":[{"id":"t1","bot_id":"b1","status":"running","active_tool":"memory.search","ended_at":null,"created_at":1760000000000},{"id":"t0","bot_id":"b1","status":"succeeded","ended_at":1760000001000,"active_tool":null}],
         "routines":[{"id":"r","enabled":1}],"devices":[],"onlineDevices":["d1"],"memories":[{"id":"m"}],"usage":[]}
        """
        let s = try decode(WorkspaceState.self, json)
        XCTAssertEqual(s.sync.privacyEpoch, 1)
        XCTAssertEqual(s.bots[0].unreadCount, 2); XCTAssertEqual(s.bots[0].readSeq, 4); XCTAssertEqual(s.bots[0].initials, "小")
        XCTAssertEqual(s.bots[0].lastMessageAt, Date(timeIntervalSince1970: 1_760_000_000))
        XCTAssertEqual(s.approvals[0].title, "执行终端命令"); XCTAssertEqual(s.approvals[0].argumentHash.count, 64)
        XCTAssertTrue(s.approvals[0].argumentsText.contains("\"command\""))
        XCTAssertEqual(s.tasks[0].phrase, "正在检索记忆")
        XCTAssertTrue(s.tasks[0].isUnfinished); XCTAssertFalse(s.tasks[1].isUnfinished)
        XCTAssertEqual(s.unfinishedTask(botID: "b1")?.id, "t1")
        XCTAssertEqual(s.routines[0].bool("enabled"), true)
        XCTAssertEqual(s.onlineDevices, ["d1"])
    }

    func testFeedAndMessages() throws {
        let json = """
        {"sync":{"cursor":3,"privacyEpoch":0,"coreId":"c","bootId":"b"},"hasMore":true,
         "messages":[{"id":"m1","seq":7.0,"role":"assistant","kind":"message","content":"done","task_id":"t1","created_at":1760000000000,
           "tool_steps":[{"id":"s","tool_name":"device.read","status":"succeeded","summary":"a.txt","preview":"{}","created_at":1}],
           "a2a_direction":"sent","a2a_peer_id":"b2"},
          {"id":"m2","seq":"8","role":"user","kind":"message","content":"hi","task_id":null}],
         "streaming":[{"taskId":"t1","text":"par"}]}
        """
        let f = try decode(Feed.self, json)
        XCTAssertTrue(f.hasMore); XCTAssertEqual(f.messages.map(\.seq), [7, 8])
        XCTAssertEqual(f.messages[0].toolSteps[0].label, "读取设备文件")
        XCTAssertEqual(f.messages[0].a2aPeerID, "b2"); XCTAssertTrue(f.messages[1].isFromUser); XCTAssertNil(f.messages[1].taskID)
        XCTAssertEqual(f.streaming, [StreamingText(taskId: "t1", text: "par")])
        let list = try decode(ClientSessionList.self, #"{"sessions":[{"session_id":"s1","client_name":"Mac","created_at":1,"expires_at":2,"last_seen_at":3,"revoked_at":null}],"currentSessionId":"s1"}"#)
        XCTAssertEqual(list.sessions[0].sessionID, "s1"); XCTAssertEqual(list.sessions[0].name, "Mac")
        let ev = try decode(ChangeEvent.self, #"{"cursor":5,"privacyEpoch":0,"coreId":"c","bootId":"b","reset":true}"#)
        XCTAssertTrue(ev.reset); XCTAssertEqual(ev.sync.cursor, 5)
    }

    func testLabelsAndMarkdown() {
        XCTAssertEqual(ToolLabels.label(for: "memory.search"), "检索记忆")
        XCTAssertEqual(ToolLabels.label(for: "x.y"), "x.y")
        XCTAssertEqual(ToolLabels.statusText("queued"), "排队中")
        XCTAssertEqual(ToolLabels.taskPhrase(nil), "")
        XCTAssertEqual(ToolLabels.taskPhrase(AgentTask(row: ["status": .string("cancelling")])), "正在停止…")
        XCTAssertEqual(ToolLabels.taskPhrase(AgentTask(row: ["status": .string("running")])), "执行中")
        XCTAssertEqual(ToolLabels.taskPhrase(AgentTask(row: ["status": .string("queued")])), "排队中")
        let a = Markdown.attributed("**bold** [ok](https://a.com) [bad](javascript:alert(1))\nline2")
        XCTAssertEqual(a.runs.compactMap(\.link).map(\.absoluteString), ["https://a.com"])
        XCTAssertTrue(String(a.characters).contains("\nline2"))
    }

    func testJSONValue() throws {
        let v = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"a":1,"b":2.5,"c":"3","d":true,"e":null,"f":[1]}"#.utf8))
        XCTAssertEqual(v["a"]?.intValue, 1); XCTAssertEqual(v["b"]?.doubleValue, 2.5); XCTAssertEqual(v["c"]?.intValue, 3)
        XCTAssertEqual(v["a"]?.stringValue, "1"); XCTAssertEqual(v["d"]?.boolValue, true); XCTAssertNil(v["e"]?.stringValue)
    }
}

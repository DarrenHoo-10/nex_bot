import XCTest
@testable import NexClientKit

nonisolated(unsafe) private let retrievalJSON: [String: Any] = [
    "embedding": ["source": "custom", "model": "bge-m3", "version": 3,
                  "default": ["model": "server-embed"],
                  "custom": ["enabled": true, "baseUrl": "https://embed.example/v1", "model": "bge-m3", "dimensions": 1024, "hasKey": true]],
    "rerank": ["source": "default", "model": "", "format": "tei", "version": 0,
               "default": ["model": "", "format": "tei"], "custom": NSNull()],
]

nonisolated(unsafe) private let coreJSON: [String: Any] = [
    "limit": 1500, "tokens": 87, "rendered": "核心记忆（版本 2）\n关于用户：\n- 用户叫小明",
    "bot": ["content": ["about": ["用户叫小明", "偏好中文"],
                        "topics": [["title": "部署流程", "line": "周五上线东京", "ref": "memory:abc-1"], ["title": "口味", "line": "不吃辣", "ref": ""]]],
            "version": 2, "updatedAt": 1_760_000_000_000],
    "workspace": ["content": ["about": [], "topics": []], "version": 0, "updatedAt": 0],
]

@MainActor
final class MemoryRetrievalTests: XCTestCase {
    func makeStore(_ core: StubCore) -> WorkspaceStore {
        WorkspaceStore(client: core.client(), timing: SyncTiming(debounce: 0.01, fallbackInterval: 100, backoff: Backoff(initial: 0.01, maximum: 0.01)))
    }
    private func decode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }

    // MARK: 记忆检索

    func testDecodesCustomDefaultAndDisabledItems() throws {
        let view = try decode(RetrievalView.self, retrievalJSON)
        let embedding = view.item(.embedding)
        XCTAssertEqual(embedding.source, .custom); XCTAssertEqual(embedding.model, "bge-m3"); XCTAssertEqual(embedding.version, 3)
        XCTAssertEqual(embedding.defaultModel?.model, "server-embed")
        XCTAssertEqual(embedding.custom, RetrievalCustom(enabled: true, baseURL: "https://embed.example/v1", model: "bge-m3", dimensions: 1024, format: nil, hasKey: true))
        XCTAssertEqual(embedding.statusText, "自定义 · bge-m3")
        let rerank = view.item(.rerank)
        XCTAssertEqual(rerank.source, .default); XCTAssertEqual(rerank.format, .tei); XCTAssertNil(rerank.custom)
        XCTAssertEqual(rerank.defaultModel, RetrievalDefault(model: "", format: .tei))
        XCTAssertEqual(rerank.statusText, "默认 · TEI", "a TEI default without a model name shows TEI")

        let off = try decode(RetrievalView.self, [
            "embedding": ["source": "disabled", "version": 2, "default": NSNull(),
                          "custom": ["enabled": false, "baseUrl": "", "model": "", "dimensions": NSNull(), "hasKey": false]],
            "rerank": ["source": "disabled", "version": 0, "default": NSNull(), "custom": NSNull()],
        ])
        XCTAssertEqual(off.embedding.statusText, "未启用"); XCTAssertNil(off.embedding.model); XCTAssertNil(off.embedding.defaultModel)
        XCTAssertEqual(off.embedding.custom?.enabled, false); XCTAssertNil(off.embedding.custom?.dimensions)
        XCTAssertEqual(off.rerank.statusText, "未启用"); XCTAssertEqual(off.rerank.version, 0)
    }

    func testViewHasNoKeyField() throws {
        // Even if a faulty server sent a key, the model has nowhere to hold it.
        var raw = retrievalJSON
        var embedding = raw["embedding"] as! [String: Any]
        var custom = embedding["custom"] as! [String: Any]
        custom["apiKey"] = "sk-must-not-appear"; embedding["custom"] = custom; embedding["apiKey"] = "sk-must-not-appear"; raw["embedding"] = embedding
        let view = try decode(RetrievalView.self, raw)
        XCTAssertFalse(String(describing: view).contains("sk-must-not-appear"))
        let labels = Mirror(reflecting: try XCTUnwrap(view.embedding.custom)).children.compactMap(\.label)
        XCTAssertEqual(labels, ["enabled", "baseURL", "model", "dimensions", "format", "hasKey"])
        XCTAssertFalse(labels.contains { $0.lowercased().contains("key") && $0 != "hasKey" })
    }

    func testUnknownValuesDecodeLeniently() throws {
        let view = try decode(RetrievalView.self, ["embedding": ["source": "future", "version": "4"], "rerank": [:] as [String: Any]])
        XCTAssertEqual(view.embedding.source, .disabled); XCTAssertEqual(view.embedding.version, 4); XCTAssertEqual(view.rerank.version, 0)
    }

    func testRetrievalSettingsIsAnAuthorizedGet() async throws {
        let core = StubCore(); core.handle { _ in .json(retrievalJSON) }
        let store = makeStore(core)
        let view = try await store.retrievalSettings()
        XCTAssertEqual(view.embedding.version, 3)
        let request = core.recorded("/api/memory/retrieval")[0]
        XCTAssertEqual(request.method, "GET"); XCTAssertTrue(request.body.isEmpty)
        XCTAssertEqual(request.headers["Authorization"], "Bearer tok")
        XCTAssertTrue(core.recorded("/api/state").isEmpty, "a read does not refresh the workspace state")
    }

    func testSaveRequestKeepsTheStoredKeyWhenBlank() throws {
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            RetrievalSaveRequest.save(kind: .embedding, version: 3, enabled: true, baseURL: " https://embed.example/v1 ", model: " bge-m3 ", dimensions: 1024, apiKey: "   "))) as! [String: Any]
        XCTAssertEqual(body["kind"] as? String, "embedding"); XCTAssertEqual(body["version"] as? Int, 3); XCTAssertEqual(body["enabled"] as? Bool, true)
        XCTAssertEqual(body["baseUrl"] as? String, "https://embed.example/v1"); XCTAssertEqual(body["model"] as? String, "bge-m3")
        XCTAssertEqual(body["dimensions"] as? Int, 1024)
        XCTAssertNil(body["apiKey"], "a blank key is not sent: Core keeps the stored one"); XCTAssertNil(body["format"]); XCTAssertNil(body["reset"])
        XCTAssertEqual(Set(body.keys), ["kind", "version", "enabled", "baseUrl", "model", "dimensions"])
    }

    func testSaveRequestWithNewKeyAndBlankDimensions() throws {
        let embedding = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            RetrievalSaveRequest.save(kind: .embedding, version: 0, enabled: false, baseURL: "", model: "", dimensions: nil, apiKey: " sk-new "))) as! [String: Any]
        XCTAssertEqual(embedding["apiKey"] as? String, "sk-new"); XCTAssertEqual(embedding["enabled"] as? Bool, false)
        XCTAssertTrue(embedding["dimensions"] is NSNull, "no dimensions are sent as null, as the web form does")
        let rerank = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            RetrievalSaveRequest.save(kind: .rerank, version: 5, enabled: true, baseURL: "https://rerank.example", model: "", format: .tei))) as! [String: Any]
        XCTAssertEqual(rerank["kind"] as? String, "rerank"); XCTAssertEqual(rerank["format"] as? String, "tei")
        XCTAssertNil(rerank["dimensions"]); XCTAssertNil(rerank["apiKey"])
        XCTAssertEqual(rerank["model"] as? String, "")
    }

    func testUseDefaultRequestSendsOnlyReset() throws {
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(RetrievalSaveRequest.useDefault(kind: .rerank, version: 4))) as! [String: Any]
        XCTAssertEqual(body as NSDictionary, ["kind": "rerank", "version": 4, "reset": true] as NSDictionary)
    }

    func testDimensionsField() throws {
        XCTAssertNil(try RetrievalSaveRequest.dimensions(from: ""))
        XCTAssertNil(try RetrievalSaveRequest.dimensions(from: "  "))
        XCTAssertNil(try RetrievalSaveRequest.dimensions(from: "0"))
        XCTAssertEqual(try RetrievalSaveRequest.dimensions(from: " 1024 "), 1024)
        XCTAssertEqual(try RetrievalSaveRequest.dimensions(from: "8192"), 8192)
        for bad in ["8193", "-1", "1.5", "abc"] {
            XCTAssertThrowsError(try RetrievalSaveRequest.dimensions(from: bad)) { XCTAssertEqual(($0 as? CoreError)?.message, "维度须为 1 至 8192") }
        }
    }

    func testSaveRetrievalPostsAndReturnsTheStoredView() async throws {
        let core = StubCore(); core.handle { _ in .json(retrievalJSON) }
        let store = makeStore(core)
        let view = try await store.saveRetrieval(.save(kind: .embedding, version: 3, enabled: true, baseURL: "https://embed.example/v1", model: "bge-m3", dimensions: 1024, apiKey: "sk-new"))
        XCTAssertEqual(view.embedding.custom?.hasKey, true)
        let request = core.recorded("/api/memory/retrieval")[0]
        XCTAssertEqual(request.method, "POST"); XCTAssertEqual(request.json["apiKey"] as? String, "sk-new")
        // The key is only in the request body, never in the headers or the query.
        XCTAssertFalse(request.query.contains("sk-new")); XCTAssertFalse(request.headers.values.contains { $0.contains("sk-new") })
        _ = try await store.saveRetrieval(.useDefault(kind: .embedding, version: 3))
        XCTAssertEqual(core.recorded("/api/memory/retrieval")[1].json["reset"] as? Bool, true)
    }

    func testRetrievalErrorsPassThrough() async {
        for (status, message) in [(400, "测试请求失败：连接超时"), (400, "检索设置已变化，请刷新"), (400, "服务地址须为 HTTPS；本地服务可使用 HTTP localhost"), (403, "此账号没有修改记忆检索设置的权限")] {
            let core = StubCore(); core.handle { _ in .json(["error": message], status: status) }
            let store = makeStore(core)
            do { _ = try await store.saveRetrieval(.save(kind: .rerank, version: 1, enabled: true, baseURL: "http://x", model: "m")); XCTFail("expected \(message)") }
            catch let error as CoreError { XCTAssertEqual(error.message, message); XCTAssertEqual(error.status, status) }
            catch { XCTFail("unexpected \(error)") }
        }
        let core = StubCore(); core.handle { _ in .json(["error": "此账号没有读取记忆检索设置的权限"], status: 403) }
        do { _ = try await makeStore(core).retrievalSettings(); XCTFail() } catch let error as CoreError { XCTAssertEqual(error.message, "此账号没有读取记忆检索设置的权限") } catch { XCTFail() }
    }

    // MARK: 核心记忆

    func testDecodesCoreMemory() throws {
        let view = try decode(CoreMemoryView.self, coreJSON)
        XCTAssertEqual(view.limit, 1500); XCTAssertEqual(view.tokens, 87); XCTAssertEqual(view.usageText, "87 / 1500 Token")
        XCTAssertEqual(view.bot.version, 2); XCTAssertEqual(view.bot.content.about, ["用户叫小明", "偏好中文"])
        XCTAssertEqual(view.bot.content.topics, [CoreMemoryTopic(title: "部署流程", line: "周五上线东京", ref: "memory:abc-1"), CoreMemoryTopic(title: "口味", line: "不吃辣")])
        XCTAssertEqual(view.workspace, CoreMemoryEntry()); XCTAssertEqual(view.entry(.workspace).version, 0)
        let empty = try decode(CoreMemoryView.self, [:] as [String: Any])
        XCTAssertEqual(empty.usageText, "0 / 1500 Token"); XCTAssertEqual(empty.bot, CoreMemoryEntry())
    }

    func testCoreMemoryGetCarriesTheBotId() async throws {
        let core = StubCore(); core.handle { _ in .json(coreJSON) }
        let store = makeStore(core)
        let view = try await store.coreMemory(botID: "b 1&x")
        XCTAssertEqual(view.bot.version, 2)
        let request = core.recorded("/api/memory/core")[0]
        XCTAssertEqual(request.method, "GET"); XCTAssertEqual(request.query, "botId=b%201%26x")
    }

    func testSaveCoreMemoryBody() async throws {
        let core = StubCore(); core.handle { _ in .json(coreJSON) }
        let store = makeStore(core)
        let topics = [CoreMemoryTopic(title: "部署流程", line: "周五上线东京", ref: "memory:abc-1"), CoreMemoryTopic(title: "口味", line: "不吃辣")]
        let view = try await store.saveCoreMemory(botID: "b1", scope: .workspace, about: ["喜欢短句"], topics: topics, version: 4)
        XCTAssertEqual(view.tokens, 87)
        let request = core.recorded("/api/memory/core")[0]
        XCTAssertEqual(request.method, "POST")
        let json = request.json
        XCTAssertEqual(json["botId"] as? String, "b1"); XCTAssertEqual(json["scope"] as? String, "workspace"); XCTAssertEqual(json["version"] as? Int, 4)
        XCTAssertEqual(json["about"] as? [String], ["喜欢短句"])
        let sent = try XCTUnwrap(json["topics"] as? [[String: String]])
        XCTAssertEqual(sent, [["title": "部署流程", "line": "周五上线东京", "ref": "memory:abc-1"], ["title": "口味", "line": "不吃辣", "ref": ""]])
        XCTAssertEqual(Set(json.keys), ["botId", "scope", "about", "topics", "version"])
        _ = try await store.saveCoreMemory(botID: "b1", scope: .bot, about: [], topics: [], version: 2)
        XCTAssertEqual(core.recorded("/api/memory/core")[1].json["scope"] as? String, "bot")
    }

    func testCoreMemoryErrorsPassThrough() async {
        for (status, message) in [(400, "核心记忆已被更新（当前版本 3），请按最新版本重新提交"),
                                  (400, "核心记忆超过 1500 Token（改后约 1620）。请合并相近的行、缩短说明或删除不再需要的行后重试"),
                                  (400, "主题引用须形如 memory:<id> 或 episode:<id>"),
                                  (403, "此账号没有修改核心记忆的权限")] {
            let core = StubCore(); core.handle { _ in .json(["error": message], status: status) }
            let store = makeStore(core)
            do { _ = try await store.saveCoreMemory(botID: "b1", scope: .bot, about: ["a"], topics: [], version: 1); XCTFail("expected \(message)") }
            catch let error as CoreError { XCTAssertEqual(error.message, message); XCTAssertEqual(error.status, status) }
            catch { XCTFail("unexpected \(error)") }
        }
        let core = StubCore(); core.handle { _ in .json(["error": "助手不存在"], status: 400) }
        do { _ = try await makeStore(core).coreMemory(botID: "gone"); XCTFail() } catch let error as CoreError { XCTAssertEqual(error.message, "助手不存在") } catch { XCTFail() }
    }

    // MARK: 行文本

    func testTopicLinesRoundTrip() throws {
        let topics = [CoreMemoryTopic(title: "部署流程", line: "周五上线东京", ref: "memory:abc-1"), CoreMemoryTopic(title: "口味", line: "不吃辣"), CoreMemoryTopic(title: "会议", line: "周一例会", ref: "episode:e_9")]
        let text = CoreMemoryText.topicText(topics)
        XCTAssertEqual(text, "部署流程 — 周五上线东京 (memory:abc-1)\n口味 — 不吃辣\n会议 — 周一例会 (episode:e_9)")
        XCTAssertEqual(try CoreMemoryText.parseTopics(text), topics)
    }

    func testParseTopicsAcceptsBulletsBlankLinesAndWindowsNewlines() throws {
        let parsed = try CoreMemoryText.parseTopics("\n- 部署流程 — 周五上线 (memory:a1)\r\n  • 口味 —  不吃辣  \r\n\n")
        XCTAssertEqual(parsed, [CoreMemoryTopic(title: "部署流程", line: "周五上线", ref: "memory:a1"), CoreMemoryTopic(title: "口味", line: "不吃辣")])
        XCTAssertEqual(try CoreMemoryText.parseTopics("   \n"), [])
        // A reference that is not memory:/episode: stays part of the sentence.
        XCTAssertEqual(try CoreMemoryText.parseTopics("项目 — 看 (doc:1)"), [CoreMemoryTopic(title: "项目", line: "看 (doc:1)")])
        // " — " inside the sentence stays in the sentence.
        XCTAssertEqual(try CoreMemoryText.parseTopics("甲 — 乙 — 丙"), [CoreMemoryTopic(title: "甲", line: "乙 — 丙")])
    }

    func testParseTopicsRejectsLinesWithoutATitleAndSentence() {
        for bad in ["只有标题", " — 没有标题", "标题 — ", "-", "标题 - 一句话"] {
            XCTAssertThrowsError(try CoreMemoryText.parseTopics("好 — 行\n" + bad), bad) {
                XCTAssertEqual(($0 as? CoreError)?.message, "格式应为“标题 — 一句话”：\(bad.trimmingCharacters(in: .whitespaces))")
            }
        }
        let long = String(repeating: "长", count: 60)
        XCTAssertThrowsError(try CoreMemoryText.parseTopics(long)) { XCTAssertEqual(($0 as? CoreError)?.message, "格式应为“标题 — 一句话”：" + String(repeating: "长", count: 40)) }
    }

    func testParseAbout() {
        XCTAssertEqual(CoreMemoryText.parseAbout("- 用户叫小明\n  •偏好中文\n\n喜欢短句 \r\n-\n"), ["用户叫小明", "偏好中文", "喜欢短句"])
        XCTAssertEqual(CoreMemoryText.parseAbout(""), [])
        XCTAssertEqual(CoreMemoryText.aboutText(["a", "b"]), "a\nb")
    }

    // MARK: 标签

    func testTopicAndCoreMemoryLabels() {
        XCTAssertEqual(MemoryLabels.sourceClass("synthesized"), "主题")
        XCTAssertEqual(MemoryLabels.sourceClass("user_stated"), "用户陈述")
        XCTAssertEqual(ToolLabels.label(for: "memory.core.update"), "更新核心记忆")
        XCTAssertEqual(ToolLabels.phrase(for: "memory.core.update"), "正在更新核心记忆")
    }
}

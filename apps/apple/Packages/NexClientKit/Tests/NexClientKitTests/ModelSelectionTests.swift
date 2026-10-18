import XCTest
@testable import NexClientKit

nonisolated(unsafe) private let modelState: [String: Any] = [
    "sync": syncJSON(),
    "bots": [
        ["id": "b1", "name": "工作助手", "selected_model": "fixture-reasoning", "model_selection_version": 2],
        ["id": "b2", "name": "研究伙伴"],
    ],
    "config": ["id": "default", "provider_id": "openai", "endpoint": "https://api.example.com/v1", "default_model": "fixture-model", "configured": true],
    "modelVisibility": ["models": ["fixture-model", "x"], "version": 3],
]

@MainActor
final class ModelSelectionTests: XCTestCase {
    func loaded(_ response: @escaping @Sendable (RecordedRequest) -> StubResponse) async -> (StubCore, WorkspaceStore) {
        let core = StubCore()
        core.handle { r in r.path == "/api/state" ? .json(modelState) : response(r) }
        let store = WorkspaceStore(client: core.client(), timing: SyncTiming(debounce: 0.01, fallbackInterval: 100, backoff: Backoff(initial: 0.01, maximum: 0.01)))
        await store.refresh()
        return (core, store)
    }

    func testDecodesSelectionAndVisibility() async {
        let (_, store) = await loaded { _ in .json(["ok": true]) }
        XCTAssertEqual(store.bot("b1")?.selectedModel, "fixture-reasoning"); XCTAssertEqual(store.bot("b1")?.modelSelectionVersion, 2)
        XCTAssertNil(store.bot("b2")?.selectedModel); XCTAssertEqual(store.bot("b2")?.modelSelectionVersion, 0)
        XCTAssertEqual(store.state?.modelVisibility.models, ["fixture-model", "x"]); XCTAssertEqual(store.state?.modelVisibility.version, 3)
        XCTAssertEqual(store.bot("b2")?.effectiveModel(default: "fixture-model"), "fixture-model")
        XCTAssertEqual(store.bot("b1")?.effectiveModel(default: "fixture-model"), "fixture-reasoning")
    }

    func testStateWithoutVisibilityDecodes() throws {
        var raw = modelState; raw.removeValue(forKey: "modelVisibility")
        let state = try JSONDecoder().decode(WorkspaceState.self, from: JSONSerialization.data(withJSONObject: raw))
        XCTAssertNil(state.modelVisibility.models); XCTAssertEqual(state.modelVisibility.version, 0)
        raw["modelVisibility"] = ["models": NSNull(), "version": 4]
        let all = try JSONDecoder().decode(WorkspaceState.self, from: JSONSerialization.data(withJSONObject: raw))
        XCTAssertNil(all.modelVisibility.models); XCTAssertEqual(all.modelVisibility.version, 4)
    }

    func testSetAgentModelBodyAndErrors() async throws {
        let (core, store) = await loaded { _ in .json(["ok": true]) }
        try await store.setAgentModel(botID: "b1", model: "fixture-model")
        var j = core.recorded("/api/bots/model")[0].json
        XCTAssertEqual(j["id"] as? String, "b1"); XCTAssertEqual(j["model"] as? String, "fixture-model"); XCTAssertEqual(j["provider"] as? String, "openai")
        XCTAssertEqual(j["endpoint"] as? String, "https://api.example.com/v1"); XCTAssertEqual(j["version"] as? Int, 2)
        try await store.setAgentModel(botID: "b2", model: "")
        j = core.recorded("/api/bots/model")[1].json; XCTAssertEqual(j["model"] as? String, ""); XCTAssertEqual(j["version"] as? Int, 0)
        let (_, busy) = await loaded { r in r.path == "/api/bots/model" ? .json(["error": "请等待当前任务结束或停止任务后切换模型"], status: 400) : .json(["ok": true]) }
        do { try await busy.setAgentModel(botID: "b1", model: "x"); XCTFail() } catch let e as CoreError { XCTAssertEqual(e.message, "请等待当前任务结束或停止任务后切换模型") }
    }

    func testSaveModelVisibility() async throws {
        let (core, store) = await loaded { r in r.path == "/api/models/visibility" ? .json(["models": ["a"], "version": 4]) : .json(["ok": true]) }
        let saved = try await store.saveModelVisibility(models: ["a"])
        XCTAssertEqual(saved.models, ["a"]); XCTAssertEqual(saved.version, 4)
        var j = core.recorded("/api/models/visibility")[0].json
        XCTAssertEqual(j["provider"] as? String, "openai"); XCTAssertEqual(j["endpoint"] as? String, "https://api.example.com/v1")
        XCTAssertEqual(j["models"] as? [String], ["a"]); XCTAssertEqual(j["version"] as? Int, 3)
        _ = try await store.saveModelVisibility(models: nil)
        j = core.recorded("/api/models/visibility")[1].json
        XCTAssertTrue(j["models"] is NSNull, "null (all models) must be sent explicitly")
        _ = try await store.saveModelVisibility(models: [], version: 1)
        j = core.recorded("/api/models/visibility")[2].json
        XCTAssertEqual(j["models"] as? [String], []); XCTAssertEqual(j["version"] as? Int, 1, "explicit version wins")
    }

    func testMemorySummaryAndSettings() async throws {
        let (core, store) = await loaded { r in
            switch r.path {
            case "/api/memory/summary": .json(["enabled": 1, "model": "", "version": 5, "totalTokens": 12345, "incomplete": true])
            case "/api/memory/settings": .json(["enabled": true, "model": "fixture-model", "version": 6, "totalTokens": 12345, "incomplete": false])
            default: .json(["ok": true])
            }
        }
        let s = try await store.memorySummary()
        XCTAssertTrue(s.enabled); XCTAssertEqual(s.model, ""); XCTAssertEqual(s.version, 5); XCTAssertEqual(s.totalLabel, "≥ 12,345")
        XCTAssertEqual(core.recorded("/api/memory/summary")[0].method, "POST")
        let next = try await store.saveMemorySettings(enabled: true, model: "fixture-model", version: s.version)
        XCTAssertEqual(next.version, 6); XCTAssertEqual(next.totalLabel, "12,345")
        let j = core.recorded("/api/memory/settings")[0].json
        XCTAssertEqual(j["enabled"] as? Bool, true); XCTAssertEqual(j["model"] as? String, "fixture-model"); XCTAssertEqual(j["version"] as? Int, 5)
        XCTAssertNil(j["botId"], "the unified switch never sends a bot id")
        _ = try await store.saveMemorySettings(enabled: false, version: 6)
        XCTAssertNil(core.recorded("/api/memory/settings")[1].json["model"])
    }
}

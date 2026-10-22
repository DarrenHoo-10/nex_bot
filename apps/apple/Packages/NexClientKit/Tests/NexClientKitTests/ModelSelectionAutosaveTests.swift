import XCTest
@testable import NexClientKit

@MainActor
final class ModelSelectionAutosaveTests: XCTestCase {
    /// A fake Core: stores the choice, bumps the version and rejects a stale version.
    @MainActor final class Store {
        var value = ModelVisibility(models: nil, version: 3)
        var calls: [(models: [String]?, version: Int)] = []
        var gate: CheckedContinuation<Void, Never>?
        var holdNext = false
        var failNext = false
        func save(_ models: [String]?, _ version: Int) async throws -> ModelVisibility {
            calls.append((models, version))
            if holdNext { holdNext = false; await withCheckedContinuation { gate = $0 } }
            if failNext { failNext = false; throw CoreError(kind: .http, message: "显示模型已被修改，请重新打开设置", status: 409) }
            guard version == value.version else { throw CoreError(kind: .http, message: "版本冲突", status: 409) }
            value = ModelVisibility(models: models, version: version + 1)
            return value
        }
    }

    private func settle(_ autosave: ModelSelectionAutosave) async {
        for _ in 0..<200 where autosave.busy { await Task.yield(); try? await Task.sleep(for: .milliseconds(2)) }
        await Task.yield()
    }

    func testToggleSavesWithTheStoredVersion() async {
        let core = Store(), autosave = ModelSelectionAutosave(initial: core.value, save: { try await core.save($0, $1) })
        autosave.toggle("b", all: ["a", "b", "c"])
        XCTAssertEqual(autosave.selection, ["a", "c"], "the list updates at once")
        await settle(autosave)
        XCTAssertEqual(core.calls.count, 1)
        XCTAssertEqual(core.calls[0].version, 3)
        XCTAssertEqual(autosave.selection, ["a", "c"])
        XCTAssertEqual(core.value.version, 4)
    }

    func testChoicesDuringASaveGoOutAfterItWithTheNewVersion() async {
        let core = Store(), autosave = ModelSelectionAutosave(initial: core.value, save: { try await core.save($0, $1) })
        core.holdNext = true
        autosave.toggle("a", all: ["a", "b", "c"])
        for _ in 0..<50 where core.gate == nil { await Task.yield() }
        autosave.toggle("b", all: ["a", "b", "c"])
        autosave.toggle("c", all: ["a", "b", "c"])
        XCTAssertEqual(autosave.selection, [String]())
        core.gate?.resume()
        await settle(autosave)
        XCTAssertEqual(core.calls.map(\.version), [3, 4], "the second write uses the version the first returned")
        XCTAssertEqual(core.calls.last.flatMap { $0.models }, [String]())
        XCTAssertEqual(autosave.selection, [String]())
        XCTAssertEqual(autosave.error, "")
    }

    func testFailureRevertsToTheLastConfirmedChoice() async {
        let core = Store(), autosave = ModelSelectionAutosave(initial: ModelVisibility(models: ["a"], version: 3), save: { try await core.save($0, $1) })
        core.failNext = true
        autosave.set(["a", "b"])
        await settle(autosave)
        XCTAssertEqual(autosave.selection, ["a"])
        XCTAssertEqual(autosave.error, "未保存：显示模型已被修改，请重新打开设置")
    }

    func testAdoptsNewerValuesFromAnotherDeviceOnly() {
        let autosave = ModelSelectionAutosave(initial: ModelVisibility(models: ["a"], version: 5)) { _, _ in ModelVisibility() }
        autosave.sync(ModelVisibility(models: ["x"], version: 4))
        XCTAssertEqual(autosave.selection, ["a"])
        autosave.sync(ModelVisibility(models: ["x"], version: 6))
        XCTAssertEqual(autosave.selection, ["x"])
    }

    func testImageSelectionDecodesFromState() throws {
        let json = #"{"sync":{"cursor":1,"privacyEpoch":0,"coreId":"c","bootId":"b"},"imageModelSelection":{"models":["gpt-image-1"],"version":2}}"#
        let state = try JSONDecoder().decode(WorkspaceState.self, from: Data(json.utf8))
        XCTAssertEqual(state.imageModelSelection, ModelVisibility(models: ["gpt-image-1"], version: 2))
        let empty = try JSONDecoder().decode(WorkspaceState.self, from: Data(#"{"sync":{"cursor":1,"privacyEpoch":0,"coreId":"c","bootId":"b"}}"#.utf8))
        XCTAssertEqual(empty.imageModelSelection.models, [String]())
    }
}

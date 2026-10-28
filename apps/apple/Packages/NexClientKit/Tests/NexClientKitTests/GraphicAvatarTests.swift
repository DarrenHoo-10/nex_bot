import XCTest
@testable import NexClientKit

final class GraphicAvatarTests: XCTestCase {
    func testAllApprovedGraphicsUseTheCoreWireFormat() throws {
        XCTAssertEqual(AvatarCatalog.graphics.count, 15)
        XCTAssertEqual(Set(AvatarCatalog.graphics.map(\.id)).count, 15)
        for graphic in AvatarCatalog.graphics {
            let bytes = try JSONEncoder().encode(AppearanceChoice.graphic(graphic.id))
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: String])
            XCTAssertEqual(body, ["kind": "graphic", "id": graphic.id])
        }
        let classic = try JSONEncoder().encode(AppearanceChoice.portrait("fox"))
        XCTAssertEqual(try JSONSerialization.jsonObject(with: classic) as? [String: String], ["kind": "portrait", "id": "fox"])
        XCTAssertEqual(AvatarCatalog.portraits.count, 20)
        XCTAssertNil(AvatarCatalog.graphic("missing"))
    }

    func testCompletionIsBriefAndDoesNotMaskNewWork() {
        let now = Date(timeIntervalSince1970: 100)
        func task(_ id: String, _ status: String, _ ended: Double?) -> AgentTask {
            AgentTask(row: ["id": .string(id), "bot_id": "b", "status": .string(status), "ended_at": ended.map { .number($0 * 1000) } ?? .null])
        }
        var state = WorkspaceState(sync: SyncIdentity(cursor: 1, privacyEpoch: 0, coreId: "fixture", bootId: "fixture"))
        state.tasks = [task("old", "succeeded", 90), task("just-done", "succeeded", 99)]
        XCTAssertEqual(state.avatarTask(botID: "b", now: now)?.id, "just-done")
        XCTAssertNil(state.avatarTask(botID: "b", now: now.addingTimeInterval(4)))
        XCTAssertNil(state.avatarTask(botID: "other", now: now))
        state.tasks.append(task("new", "running", nil))
        XCTAssertEqual(state.avatarTask(botID: "b", now: now)?.id, "new")
    }
}

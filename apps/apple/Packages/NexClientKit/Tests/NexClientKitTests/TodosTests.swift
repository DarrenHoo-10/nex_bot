import XCTest
@testable import NexClientKit

final class TodosTests: XCTestCase {
    func testCalendarBoundaries() throws {
        let anchor = try XCTUnwrap(TodoDates.parse("2027-01-01"))
        XCTAssertEqual(TodoDates.days(anchor, period: "week").map(TodoDates.key), ["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"])
        let november = try XCTUnwrap(TodoDates.parse("2026-11-15"))
        let month = TodoDates.days(november, period: "month").map(TodoDates.key)
        XCTAssertEqual(month.count, 42); XCTAssertEqual(month.first, "2026-10-26"); XCTAssertEqual(month.last, "2026-12-06")
        XCTAssertNil(TodoDates.parse("2026-02-30")); XCTAssertNotNil(TodoDates.parse("2024-02-29"))
    }
    func testRoundTripAndActionVersion() throws {
        var item = TodoItem(date: "2026-10-30"); item.title = "持久化待办"; item.version = 7; item.status = "review"
        item.steps = [TodoStep(text: "验收", done: true)]; item.result = "交付内容"
        let data = try JSONEncoder().encode(item)
        XCTAssertEqual(try JSONDecoder().decode(TodoItem.self, from: data), item)
        XCTAssertTrue(item.matches("running")); XCTAssertFalse(item.matches("done"))
        let action = try JSONSerialization.jsonObject(with: JSONEncoder().encode(TodoAction(item, action: "complete"))) as! [String: Any]
        XCTAssertEqual(action["version"] as? Int, 7); XCTAssertEqual(action["id"] as? String, item.id)
        XCTAssertEqual(action["action"] as? String, "complete")
    }
}

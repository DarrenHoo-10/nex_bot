import XCTest
import SwiftUI
import NexClientKit
@testable import NexRenderFixture

private final class RoutineFixtureProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var onRequest: (@Sendable () -> Void)?
    nonisolated(unsafe) static var status = "succeeded"
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let status = Self.status
        let result = status == "succeeded" ? "今天有 3 项安排。上午 10 点和设计团队讨论方案，下午 2 点确认合同，傍晚留出半小时整理本周进展。" : status == "failed" ? "暂时无法读取日历，请检查连接后再试。" : "日程已整理，发送前需要你确认。"
        let payload: [String: Any] = [
            "occurrence": ["id": "fixture-run", "name": "每天整理日程", "prompt": "整理今天的日程", "task_kind": "report", "status": status, "task_status": status, "scheduled_at": 1800000000000],
            "task": ["id": "child-task", "status": status, "result_summary": result],
            "messages": [["id": "m1", "role": "assistant", "content": "正在读取日历，随后整理。", "created_at": 1800000000000], ["id": "m2", "role": "assistant", "content": result, "created_at": 1800000001000]],
            "steps": [["id": "tool1", "tool_name": "device.exec", "status": status, "summary": "device.exec", "preview": "", "created_at": 1800000000000]], "streaming": ""
        ]
        let data = try! JSONSerialization.data(withJSONObject: payload)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
        Self.onRequest?()
    }
    override func stopLoading() {}
}

final class RoutineRenderingTests: XCTestCase {
    @MainActor func testResultFirstSuccess() async throws { try await renderDetail("succeeded") }
    @MainActor func testResultFirstFailure() async throws { try await renderDetail("failed") }
    @MainActor func testResultFirstConfirmation() async throws { try await renderDetail("awaiting_approval") }

    @MainActor private func renderDetail(_ status: String) async throws {
        let requested = expectation(description: "Loads only the fixture execution")
        requested.assertForOverFulfill = false
        RoutineFixtureProtocol.status = status
        RoutineFixtureProtocol.onRequest = { requested.fulfill() }
        defer { RoutineFixtureProtocol.onRequest = nil }
        let session = CoreClient.makeSession(protocolClasses: [RoutineFixtureProtocol.self])
        let workspace = WorkspaceStore(client: CoreClient(origin: try CoreOrigin("https://routine-fixture.example.test"), token: "synthetic", session: session))
        let view = RoutineOccurrenceDetailView(workspace: workspace, occurrence: RoutineOccurrence(row: ["id": "fixture-run", "name": "每天整理日程", "status": .string(status)]))
        try await snapshot(view, name: "routine-result-\(status)", requested: requested)
    }

    @MainActor func testNaturalScheduleList() async throws {
        let ended = Routine(row: ["id": "once", "name": "提醒我交水电费", "schedule_kind": "once", "run_at": 1_700_000_000_000, "next_due_at": .null, "enabled": false])
        XCTAssertEqual(RoutineCopy.next(ended), "已结束")
        let paused = Routine(row: ["id": "daily", "name": "每天整理日程", "schedule_kind": "daily", "local_time": "09:00", "enabled": false])
        XCTAssertEqual(RoutineCopy.next(paused), "已关闭")
        let daily = Routine(row: ["id": "daily", "name": "每天整理日程", "schedule_kind": "daily", "local_time": "09:00", "enabled": true, "next_due_at": 1_900_000_000_000])
        let latest = RoutineOccurrence(row: ["id": "o", "status": "succeeded"])
        let view = VStack(alignment: .leading, spacing: 8) {
            Text("定时任务").font(.headline).padding()
            ForEach([daily, ended]) { routine in
                RoutineListEntry(routine: routine, latest: latest, showPlan: {}, showResult: {})
            }
            Spacer()
        }.background(Theme.background)
        try await snapshot(view, name: "routine-list", requested: nil)
    }

    @MainActor func testPlanBeforeFirstRun() async throws { try await renderPlan(enabled: true, dark: false) }
    @MainActor func testClosedPlanDark() async throws { try await renderPlan(enabled: false, dark: true) }

    @MainActor private func renderPlan(enabled: Bool, dark: Bool) async throws {
        let session = CoreClient.makeSession(protocolClasses: [RoutineFixtureProtocol.self])
        let workspace = WorkspaceStore(client: CoreClient(origin: try CoreOrigin("https://routine-fixture.example.test"), token: "synthetic", session: session))
        let routine = Routine(row: ["id": "unstarted", "name": "每天整理日程", "prompt": "每天早上帮我整理今天的日程。", "schedule_kind": "daily", "local_time": "09:00", "time_zone": "Asia/Shanghai", "enabled": .bool(enabled), "next_due_at": enabled ? .number(1_900_000_000_000) : .null, "version": 1])
        let view = RoutinePlanDetailView(workspace: workspace, routine: routine).environment(\.colorScheme, dark ? .dark : .light)
        try await snapshot(view, name: dark ? "routine-plan-closed-dark" : "routine-plan-before-first-run", requested: nil)
    }

    @MainActor private func snapshot<V: View>(_ view: V, name: String, requested: XCTestExpectation?) async throws {
        #if os(macOS)
        let host = NSHostingView(rootView: view)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 640), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        host.frame = window.contentView!.bounds
        window.orderFront(nil)
        defer { window.orderOut(nil) }
        #else
        let host = UIHostingController(rootView: view)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        #endif
        if let requested { await fulfillment(of: [requested], timeout: 5) }
        try await Task.sleep(for: .milliseconds(250))
        #if os(macOS)
        host.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        let image = NSImage(size: host.bounds.size)
        image.addRepresentation(bitmap)
        #else
        host.view.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
        #endif
        XCTAssertGreaterThan(image.size.width, 300)
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

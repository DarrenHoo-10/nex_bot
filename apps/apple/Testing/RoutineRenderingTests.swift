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

private final class JobFixtureProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var onRequest: (@Sendable () -> Void)?
    nonisolated(unsafe) static let jobs: [[String: Any]] = [
        ["id": "j-question", "botId": "b1", "title": "整理下载文件夹", "stage": "question", "taskId": "t1", "createdAt": 1800000000000, "endedAt": NSNull(),
         "latestReport": ["id": "r1", "state": "question", "summary": "已按类型整理 12 个文件。", "question": "下载里的 3 张截图要保留吗？", "messageId": "m-question", "createdAt": 1800000001000]],
        ["id": "j-review", "botId": "b1", "title": "写周报", "stage": "review", "taskId": "t2", "todoId": "todo", "todoVersion": 4, "todoStatus": "review", "createdAt": 1800000000000, "endedAt": NSNull(),
         "latestReport": ["id": "r2", "state": "ready", "summary": "周报已写好：本周完成 3 项。", "messageId": "m-review", "createdAt": 1800000002000]],
        ["id": "j-blocked", "botId": "b1", "title": "操作屏幕", "stage": "blocked", "taskId": "t3", "createdAt": 1800000000000, "endedAt": NSNull(),
         "latestReport": ["id": "r3", "state": "blocked", "summary": "屏幕正被「整理下载文件夹」使用。", "messageId": "m-blocked", "createdAt": 1800000003000]],
    ]
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        let payload: [String: Any] = path == "/api/jobs/detail" ? [
            "job": Self.jobs[0], "task": ["id": "t1", "status": "succeeded"], "tasks": [["id": "t1"]],
            "messages": [["id": "brief", "role": "user", "content": "后台任务「整理下载文件夹」。以用户原话为准"], ["id": "m1", "role": "assistant", "content": "正在按类型整理。", "created_at": 1800000000000]],
            "steps": [["id": "s1", "tool_name": "device.list", "status": "succeeded", "summary": "device.list", "preview": "", "created_at": 1800000000000]],
            "reports": [["id": "r1", "state": "question", "summary": "已按类型整理 12 个文件。", "created_at": 1800000001000]], "streaming": "",
        ] : ["sync": ["cursor": 1, "privacyEpoch": 0, "coreId": "fixture", "bootId": "fixture"],
             "bots": [["id": "b1", "name": "后台演示助手", "selected_connection": "thinker", "selected_model": "", "selected_reasoning": "max", "model_selection_version": 2]],
             "config": ["id": "default", "provider_id": "openai", "endpoint": "https://api.example.test/v1", "default_model": "fake", "configured": 1],
             "connections": [
                ["id": "default", "name": "演示供应商", "provider": "openai", "endpoint": "https://api.example.test/v1", "defaultModel": "fake", "enabled": true, "isDefault": true, "configured": true, "version": 3, "models": NSNull(), "modelsVersion": 0, "options": [:], "imageModels": ["models": ["gpt-image-2"], "version": 1]],
                ["id": "thinker", "name": "推理供应商", "provider": "anthropic", "endpoint": "https://api.example.test/thinker", "defaultModel": "claude-x", "enabled": true, "isDefault": false, "configured": true, "version": 1, "models": ["claude-x"], "modelsVersion": 4, "names": ["claude-x": "Claude X"],
                 "options": ["claude-x": ["imageInput": true, "reasoning": ["low", "high"], "version": 1]]],
             ],
             "approvals": [], "tasks": [], "routines": [], "occurrences": [], "devices": [], "conversations": [], "onlineDevices": [], "memories": [], "jobs": Self.jobs]
        let data = try! JSONSerialization.data(withJSONObject: payload)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
        if path == "/api/jobs/detail" { Self.onRequest?() }
    }
    override func stopLoading() {}
}

final class JobRenderingTests: XCTestCase {
    @MainActor private func workspace() async throws -> WorkspaceStore {
        let session = CoreClient.makeSession(protocolClasses: [JobFixtureProtocol.self])
        let store = WorkspaceStore(client: CoreClient(origin: try CoreOrigin("https://job-fixture.example.test"), token: "synthetic", session: session))
        await store.refresh()
        return store
    }

    /// Report cards follow the job's current stage: 回复 on a question, 验收 / 修改 on a todo delivery, 停止 while open.
    @MainActor func testReportCards() async throws {
        let store = try await workspace()
        XCTAssertEqual(store.state?.openJobs(botID: "b1").count, 3)
        func message(_ id: String, _ job: String, _ state: String, _ content: String) -> AgentMessage {
            AgentMessage(row: ["id": .string(id), "bot_id": "b1", "role": state == "blocked" ? "system" : "assistant", "content": .string(content), "job_id": .string(job), "job_state": .string(state), "created_at": 1_800_000_001_000])
        }
        let view = VStack(alignment: .leading, spacing: 14) {
            JobReportCard(message: message("m-question", "j-question", "question", "后台任务「整理下载文件夹」\n已按类型整理 12 个文件。\n\n下载里的 3 张截图要保留吗？"), workspace: store, open: {}, reply: { _ in }) { EmptyView() }
            JobReportCard(message: message("m-review", "j-review", "ready", "后台任务「写周报」\n周报已写好：本周完成 3 项。"), workspace: store, open: {}, reply: { _ in }) { EmptyView() }
            JobReportCard(message: message("m-blocked", "j-blocked", "blocked", "后台任务「操作屏幕」\n屏幕正被「整理下载文件夹」使用。"), workspace: store, open: {}, reply: { _ in }) { EmptyView() }
            Spacer()
        }.padding(20).background(Theme.background)
        try await snapshot(view, name: "job-report-cards", requested: nil)
    }

    /// Open jobs in the inspector show only their names; a running one carries the flowing sweep, a waiting one a warning mark.
    @MainActor func testJobRows() async throws {
        let store = try await workspace()
        let jobs = store.state?.openJobs(botID: "b1") ?? []
        XCTAssertFalse(jobs.isEmpty)
        let view = VStack(spacing: 6) {
            ForEach(jobs) { job in JobFlowRow(job: job) {} }
            Spacer()
        }.padding(20).frame(width: 360).background(Theme.background)
        try await snapshot(view, name: "job-rows", requested: nil)
    }

    /// Providers decode from the state; the assistant's choice resolves to its provider's default model and the nearest offered effort.
    @MainActor func testModelConnections() async throws {
        let store = try await workspace()
        let state = try XCTUnwrap(store.state)
        XCTAssertEqual(state.connections.map(\.name), ["演示供应商", "推理供应商"])
        let thinker = try XCTUnwrap(state.connections.last)
        XCTAssertNil(state.connections[0].models)
        XCTAssertEqual(state.connections[0].imageModels?.models, ["gpt-image-2"])
        XCTAssertNil(thinker.imageModels)
        XCTAssertEqual(thinker.models, ["claude-x"])
        XCTAssertEqual(thinker.options["claude-x"]?.reasoning, [.low, .high])
        XCTAssertEqual(thinker.options["claude-x"]?.imageInput, true)
        let bot = state.bots.first
        XCTAssertEqual(state.connection(forBot: bot)?.id, "thinker")
        XCTAssertEqual(state.modelChoice(forBot: bot).model, "claude-x")
        XCTAssertEqual(state.modelChoice(forBot: bot).reasoning, "high")
        XCTAssertEqual(thinker.displayName("claude-x"), "Claude X")
        XCTAssertEqual(thinker.displayName("unnamed"), "unnamed")
        XCTAssertEqual(state.modelLabel(forBot: bot), "Claude X · 高")
        XCTAssertEqual(ReasoningLevel.resolve(nil, offered: [.low, .medium, .high]), "medium")
        XCTAssertEqual(ReasoningLevel.resolve("medium", offered: [.low, .high]), "low")
        XCTAssertEqual(ReasoningLevel.resolve("high", offered: []), "off")
    }

    @MainActor func testJobDetail() async throws {
        let requested = expectation(description: "Loads the fixture job")
        requested.assertForOverFulfill = false
        JobFixtureProtocol.onRequest = { requested.fulfill() }
        defer { JobFixtureProtocol.onRequest = nil }
        let view = JobDetailView(workspace: try await workspace(), jobID: "j-question")
        try await snapshot(view, name: "job-detail", requested: requested)
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

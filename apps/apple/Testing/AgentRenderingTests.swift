import XCTest
import SwiftUI
import NexClientKit
@testable import NexRenderFixture

/// A fake Core for the Agent views: two computers, live and stopped sessions with context usage, a folder tree.
private final class AgentFixtureProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let payload: Any
        switch url.path {
        case "/api/cli-agents":
            let cap: [String: Any] = ["version": 1, "engines": ["claude", "codex"], "terminal": ["name": "herdr-core", "version": "0.1.21", "ready": true], "features": ["launchOptions", "models", "dirs", "attach"]]
            func session(_ id: String, _ title: String, _ state: String, _ cwd: String, _ at: Int, context: [String: Any]? = nil, engine: String = "claude") -> [String: Any] {
                var s: [String: Any] = ["key": "win:\(engine):\(id)", "deviceId": "win", "hidden": false, "online": true, "engine": engine, "nativeId": id, "configDir": "",
                                        "cwd": cwd, "title": title, "state": state, "lastActivityAt": at, "repoRoot": cwd.components(separatedBy: "/.claude/").first ?? cwd]
                if let context { s["context"] = context }
                return s
            }
            payload = ["devices": [["id": "win", "name": "darren-win-1", "online": true, "cliAgents": cap]],
                       "sessions": [session("s1", "NexAgent 模型选择与新建会话", "running", "D:/ProgrammingProjects/nex_bot", 1_800_000_009_000, context: ["used": 776256, "window": 1000000]),
                                    session("s2", "整理发布说明", "waiting", "D:/ProgrammingProjects/nex_bot/.claude/worktrees/zen", 1_800_000_008_000, context: ["used": 42000, "window": 200000]),
                                    session("s3", "邮箱服务添加域名", "stopped", "D:/ProgrammingProjects/nex_mail", 1_800_000_007_000),
                                    session("s4", "a-stock-data 借鉴", "idle", "D:/ProgrammingProjects/nex_stock", 1_800_000_006_000, engine: "codex")],
                       "requests": []]
        case "/api/cli-agents/models":
            payload = ["current": "sonnet[1m]", "models": [["id": "opus", "label": "Opus"], ["id": "sonnet", "label": "Sonnet"], ["id": "auto/claude-opus-5-5[1m]", "label": "Claude Opus 5.5 · routing group"]]]
        case "/api/cli-agents/dirs":
            let path = query.first { $0.name == "path" }?.value ?? ""
            payload = path.isEmpty
                ? ["path": "", "exists": true, "entries": [["name": "C:\\", "path": "C:\\"], ["name": "D:\\", "path": "D:\\"]]]
                : ["path": path, "parent": "D:/ProgrammingProjects", "exists": true, "git": true,
                   "entries": [["name": "android", "path": path + "/android"], ["name": "apps", "path": path + "/apps"], ["name": "docs", "path": path + "/docs"],
                               ["name": "server", "path": path + "/server"], ["name": "src", "path": path + "/src"]]]
        case "/api/cli-agents/items":
            payload = ["items": [["id": "u1", "ts": 1_800_000_000_000, "kind": "user", "text": "侧栏再优化一下，状态要一眼看出来"],
                                 ["id": "a1", "ts": 1_800_000_001_000, "kind": "assistant", "text": "好的，我先看一下现在的列表结构。"]], "more": false]
        default:
            payload = ["requests": [], "items": [], "more": false]
        }
        let data = try! JSONSerialization.data(withJSONObject: payload)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class AgentRenderingTests: XCTestCase {
    @MainActor private func model() async throws -> CliAgentsModel {
        let session = CoreClient.makeSession(protocolClasses: [AgentFixtureProtocol.self])
        let client = CoreClient(origin: try CoreOrigin("https://agent-fixture.example.test"), token: "synthetic", session: session)
        let model = CliAgentsModel(client: { client }, defaults: UserDefaults(suiteName: "agent-render-\(UUID().uuidString)")!)
        await model.refresh()
        XCTAssertEqual(model.sessions.count, 4)
        return model
    }

    /// The list (new-session button, pinned 进行中 with state dots, projects as headings) beside the new-session page.
    @MainActor func testListAndNewSessionPage() async throws {
        let model = try await model()
        model.select("win:claude:s1")
        let view = HStack(spacing: 14) {
            AgentSessionList(model: model, selected: model.selectedKey, onSelect: { _ in }, onCreate: {}, onNew: { _, _ in }, onArchive: { _, _ in }, onDelete: { _ in })
                .frame(width: 300)
                .background(Theme.sidebar, in: RoundedRectangle(cornerRadius: 18))
            AgentNewSessionPage(model: model, target: AgentNewTarget(deviceId: "win", cwd: "D:/ProgrammingProjects/nex_bot")) { _ in }
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 18))
        }
        .padding(16).background(Theme.background)
        try await snapshot(view, name: "agent-list-and-new-session", size: CGSize(width: 1100, height: 680), wait: 900)
    }

    @MainActor func testFolderBrowser() async throws {
        let model = try await model()
        let view = AgentDirectoryBrowser(model: model, deviceId: .constant("win"), start: AgentDirChoice(path: "D:/ProgrammingProjects/nex_bot", create: false)) { _ in }
            .background(Theme.card)
        try await snapshot(view, name: "agent-folder-browser", size: CGSize(width: 440, height: 460), wait: 700)
    }

    /// A running session: the working dots under the reply, the context ring in the box.
    @MainActor func testRunningSessionWithContext() async throws {
        let model = try await model()
        let workspace = WorkspaceStore(client: CoreClient(origin: try CoreOrigin("https://agent-fixture.example.test"), token: "synthetic", session: CoreClient.makeSession(protocolClasses: [AgentFixtureProtocol.self])))
        let view = AgentSessionDetail(model: model, workspace: workspace, key: "win:claude:s1", openAssistant: { _ in }, onKeyChange: { _ in })
            .background(Theme.card)
        try await snapshot(view, name: "agent-running-session", size: CGSize(width: 760, height: 560), wait: 900)
        let ring = VStack(spacing: 12) {
            ForEach([CliContextUsage(used: 50_000, window: 200_000), CliContextUsage(used: 776_256, window: 1_000_000), CliContextUsage(used: 950_000, window: 1_000_000)], id: \.used) { usage in
                HStack { AgentContextRing(usage: usage); Text(CliContext.summary(usage)).font(.caption) }
            }
            AgentWorkingRow(engine: .claude, label: "执行中", byline: true)
        }
        .padding(20).background(Theme.background)
        try await snapshot(ring, name: "agent-context-rings", size: CGSize(width: 420, height: 260), wait: 300)
    }

    @MainActor private func snapshot<V: View>(_ view: V, name: String, size: CGSize, wait: Int) async throws {
        #if os(macOS)
        let host = NSHostingView(rootView: view)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        host.frame = window.contentView!.bounds
        window.orderFront(nil)
        defer { window.orderOut(nil) }
        try await Task.sleep(for: .milliseconds(wait))
        host.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        let image = NSImage(size: host.bounds.size)
        image.addRepresentation(bitmap)
        #else
        let host = UIHostingController(rootView: view)
        let window = UIWindow(frame: CGRect(origin: .zero, size: CGSize(width: min(size.width, 390), height: 844)))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(wait))
        host.view.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
        #endif
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
